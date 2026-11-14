# Logica di cue, scratch via MIDI e salvataggio delle hot cue dopo il riavvio.
import asyncio, threading, http.server, socketserver, functools, os
from playwright.async_api import async_playwright
ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web'); PAGE = os.environ.get('SOLCO_PAGE', 'index.html'); PORT = 8812
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
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': 1280, 'height': 800}, device_scale_factor=1)
        await ctx.grant_permissions(['midi'], origin=f'http://127.0.0.1:{PORT}')
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://127.0.0.1:{PORT}/{PAGE}')
        await page.click('#gateBtn'); await page.wait_for_timeout(400)
        await page.click('#btnBrowse')
        async with page.expect_file_chooser() as fc: await page.click('#brImport')
        await (await fc.value).set_files([f'{MEDIA}/test-128.wav'])
        for i in range(80):
            if not await page.eval_on_selector('#busy', 'e => e.textContent'): break
            await page.wait_for_timeout(400)
        await page.locator('.br-list .row').first.dblclick(); await page.wait_for_timeout(1200)
        ev = lambda js: page.evaluate(js)
        pos = lambda: page.evaluate('() => solco.engine.estimate()/solco.engine.sr')
        midi = lambda a, b_, c: page.evaluate(f'() => solco.midi.handle([{a},{b_},{c}], performance.now())')
        cue0 = await ev('() => solco.D.cue/solco.D.sr')
        check('cue automatico sul primo battito', abs(cue0 - 0.25) < 0.01, round(cue0, 4))
        await midi(0x90, 1, 127); await midi(0x80, 1, 0)
        await page.wait_for_timeout(1500)
        check('play da controller', await ev('() => solco.D.playing') and await pos() > 1.4, round(await pos(), 3))
        await midi(0x90, 2, 127); await page.wait_for_timeout(250)
        check('CUE mentre suona: torna al cue e si ferma', (not await ev('() => solco.D.playing')) and abs(await pos() - cue0) < 0.02, round(await pos(), 3))
        await midi(0x80, 2, 0); await page.wait_for_timeout(200)
        # in pausa: la jog sposta la posizione (ascolto)
        await ev('() => { for (let i=1;i<=60;i++) solco.midi.handle([0xEF, 0, 64 + i], performance.now()); }')
        await page.wait_for_timeout(400)
        p_scrub = await pos()
        check('in pausa la jog cerca il punto', p_scrub > cue0 + 0.05, round(p_scrub, 3))
        # nuovo cue (quantizzato al battito più vicino) e ascolto tenendo premuto
        await midi(0x90, 2, 127); await page.wait_for_timeout(700)
        newcue = await ev('() => solco.D.cue/solco.D.sr')
        per = 60 / 128
        k = round((newcue - 0.2508) / per)
        check('nuovo cue agganciato alla griglia', abs(newcue - (0.2508 + k * per)) < 0.003, round(newcue, 4))
        check('tenendo CUE si ascolta', await ev('() => solco.D.playing') and await pos() > newcue + 0.3, round(await pos(), 3))
        await midi(0x80, 2, 0); await page.wait_for_timeout(250)
        check('lasciando CUE torna al cue', (not await ev('() => solco.D.playing')) and abs(await pos() - newcue) < 0.02, round(await pos(), 3))
        # CUE tenuto + PLAY: continua a suonare
        await midi(0x90, 2, 127); await page.wait_for_timeout(300); await midi(0x90, 1, 127); await midi(0x80, 1, 0); await midi(0x80, 2, 0)
        await page.wait_for_timeout(600)
        check('CUE + PLAY: continua dopo aver lasciato CUE', await ev('() => solco.D.playing'), round(await pos(), 3))
        # scratch: mano sulla jog, mezzo giro avanti, poi lascia
        await page.wait_for_timeout(500)
        await midi(0x90, 0x40, 127); await page.wait_for_timeout(200)
        p0 = await pos()
        await ev('() => { let a = solco.midi.jogLast || 0; for (let i=0;i<64;i++) { a = (a + 128) % 16384; solco.midi.handle([0xEF, a & 127, a >> 7], performance.now()); } }')
        await page.wait_for_timeout(300)
        p1 = await pos()
        check('scratch: mezzo giro = 0,9 s di brano', abs((p1 - p0) - 0.9) < 0.06, round(p1 - p0, 3))
        await midi(0x80, 0x40, 0); await page.wait_for_timeout(600)
        rate = await ev('() => solco.engine.rep.r')
        check('lasciando la jog il brano riparte', abs(rate - 1) < 0.01, round(rate, 3))
        # hot cue B e salvataggio
        await page.click('#hotcues .hc >> nth=1'); await page.wait_for_timeout(700)
        hb = await ev('() => solco.D.hot[1] && solco.D.hot[1].t')
        await page.reload(); await page.click('#gateBtn'); await page.wait_for_timeout(500)
        await ev("() => solco.loadTrack(solco.tracks()[0], true)"); await page.wait_for_timeout(1500)
        hb2 = await ev('() => solco.D.hot[1] && solco.D.hot[1].t')
        c2 = await ev('() => solco.D.cue/solco.D.sr')
        check('hot cue salvata dopo il riavvio', hb is not None and hb2 is not None and abs(hb - hb2) < 0.001, f'{hb} / {hb2}')
        check('cue salvato dopo il riavvio', abs(c2 - newcue) < 0.002, round(c2, 4))
        check('nessun errore JavaScript', not errs, errs)
        await b.close()
    print('\nTutti i test passati' if not fails else f'\n{fails} test falliti')
asyncio.run(main())
