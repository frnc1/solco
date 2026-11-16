# Giradischi con puck: i messaggi del puck (Bluetooth MIDI) comandano il brano. Chrome headless verticale.
# Uso: python3 tests/ui_turntable_test.py
import asyncio, threading, http.server, socketserver, functools, os
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PORT = 8823
MEDIA = '/home/claude/solco/tests/media'

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
threading.Thread(target=lambda: socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Q, directory=ROOT)).serve_forever(), daemon=True).start()

fails = 0
def check(name, ok, info=''):
    global fails
    print(('ok   ' if ok else 'FAIL ') + name + ('  → ' + str(info) if info != '' else ''))
    if not ok: fails += 1

# il puck manda i giri 100 volte al secondo, come il firmware
PUCK = '''(rpm) => {
  clearInterval(window.__pk);
  if (rpm === null) return;
  const send = () => solcoMidiBatch(SolcoMidi.puckBytes(rpm));
  send(); window.__pk = setInterval(send, 10);
  solcoMidiBatch([[0xBC, 105, 82], [0xBC, 106, 1]]);
}'''

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        page = await (await b.new_context(viewport={'width': 800, 'height': 1280})).new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://127.0.0.1:{PORT}/index.html')
        await page.click('#gateBtn'); await page.wait_for_timeout(400)
        toast = lambda: page.locator('#toast').inner_text()

        await page.click('#btnBrowse')
        async with page.expect_file_chooser() as fc: await page.click('#brImport')
        await (await fc.value).set_files([f'{MEDIA}/test-128.wav'])
        for _ in range(100):
            if not await page.eval_on_selector('#busy', 'e => e.textContent'): break
            await page.wait_for_timeout(400)
        await page.locator('.br-list .row', has_text='test-128').first.dblclick()
        await page.wait_for_timeout(1200)
        check('brano caricato, fermo', await page.evaluate('() => !!solco.D.track && !solco.D.playing'))

        # il puck compare tra i dispositivi: i comandi a schermo restano (il puck non ha tasti)
        await page.evaluate("() => solcoMidiDevices(['SOLCO Puck 3F2A'])")
        await page.wait_for_timeout(100)
        check('con il solo puck collegato i comandi a schermo restano', await page.evaluate("() => document.getElementById('app').classList.contains('touch-on')"))

        # disco a 33 giri: il brano parte da solo e va a velocità normale
        await page.evaluate(PUCK, 100 / 3)
        await page.wait_for_timeout(500)
        check('primo dato del puck → modo giradischi', await page.evaluate('() => solco.TT.on'), await toast())
        check('chip GIRADISCHI', (await page.inner_text('#chVinyl')) == 'GIRADISCHI')
        p0 = await page.evaluate('() => solco.D.posF || 0')
        t0 = await page.evaluate('() => solco.engine.ctx ? solco.engine.ctx.currentTime : 0')
        await page.wait_for_timeout(1500)
        check('il brano va', await page.evaluate('() => solco.D.playing'))
        check('tempo a 0,00% con il disco a 33⅓', (await page.inner_text('#pitchPct')) in ('0.00%', '+0.00%', '−0.00%'), await page.inner_text('#pitchPct'))
        bpm = float(await page.inner_text('#bpmBig'))
        check('BPM come il brano (128)', abs(bpm - 128) < 0.05, bpm)

        # pitch del giradischi +8%
        await page.evaluate(PUCK, 100 / 3 * 1.08)
        await page.wait_for_timeout(1500)
        check('pitch +8% sul giradischi → +8% in SOLCO', (await page.inner_text('#pitchPct')) == '+8.00%', await page.inner_text('#pitchPct'))
        bpm = float(await page.inner_text('#bpmBig'))
        check('BPM 138,24', abs(bpm - 138.24) < 0.05, bpm)

        # play e BPM scritto a mano non hanno senso col disco
        await page.click('#tPlay'); await page.wait_for_timeout(150)
        check('PLAY: avviso, il brano continua', 'disco' in await toast() and await page.evaluate('() => solco.D.playing'), await toast())

        # disco fermo
        await page.evaluate(PUCK, 0)
        await page.wait_for_timeout(600)
        check('disco fermo → brano fermo', await page.evaluate('() => !solco.D.playing'))

        # il puck tace: si tiene l'ultima velocità
        await page.evaluate(PUCK, 100 / 3)
        await page.wait_for_timeout(500)
        await page.evaluate(PUCK, None)
        await page.wait_for_timeout(2200)
        check('puck muto: avviso e il brano continua', 'non risponde' in await toast() and await page.evaluate('() => solco.D.playing'), await toast())
        await page.evaluate(PUCK, 100 / 3)
        await page.wait_for_timeout(300)
        check('puck di nuovo vivo', not await page.evaluate('() => solco.TT.lost'))

        # impostazioni → Comandi: sezione giradischi
        await page.click('#btnSettings'); await page.wait_for_timeout(200)
        await page.locator('#setTabs button', has_text='COMANDI').click(); await page.wait_for_timeout(200)
        st = await page.inner_text('#ttStat')
        check('stato del puck nelle impostazioni', 'Puck collegato' in st and 'batteria 82%' in st, st)
        await page.click('#ttScan'); await page.wait_for_timeout(150)
        check('CERCA PUCK fuori dall’app Android: avviso', 'Android' in await toast(), await toast())
        await page.locator('.set-row', has_text='Giradischi').locator('button', has_text='SPENTO').click()
        await page.wait_for_timeout(400)
        check('giradischi SPENTO → comandi normali, deck fermo', await page.evaluate('() => !solco.TT.on && !solco.D.playing'))
        await page.evaluate(PUCK, None)

        check('nessun errore nella pagina', not errs, errs)
        await b.close()
    print('FALLITI:', fails)

asyncio.run(main())
