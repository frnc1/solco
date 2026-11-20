# Puck con schermo (M5Stack StopWatch): SOLCO gli manda stato, brano e forma d'onda, risponde alle
# richieste della lista e carica i brani scelti sul puck. Chrome headless verticale; il puck è simulato
# con i suoi messaggi SysEx (stessi byte del firmware, vedi tests/puck_proto.test.js).
# Uso: python3 tests/ui_puck_screen_test.py
import asyncio, threading, http.server, socketserver, functools, os, re
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PORT = 8824
MEDIA = '/home/claude/solco/tests/media'
VERSION = re.search(r"VERSION = '([^']+)'", open(os.path.join(ROOT, 'js/app.js')).read()).group(1)

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
threading.Thread(target=lambda: socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Q, directory=ROOT)).serve_forever(), daemon=True).start()

fails = 0
def check(name, ok, info=''):
    global fails
    print(('ok   ' if ok else 'FAIL ') + name + ('  → ' + str(info) if info != '' else ''))
    if not ok: fails += 1

# puck simulato: messaggi in arrivo (SysEx) e disco (programma 1.1: orario, angolo, giri al minuto, 100 volte al secondo)
SETUP = '''() => {
  const PP = SolcoMidi.PuckProto;
  window.__out = [];
  solco.midi.onPuckOut = (b) => window.__out.push(Array.from(b));
  window.__pk = (name, o) => solcoMidiBatch([Array.from(PP.enc[name](o || {}))]);
  window.__got = (cmd) => window.__out.map((b) => PP.decode(b)).filter((m) => m && m.cmd === cmd);
  window.__clear = () => { window.__out = []; };
  window.__disc = { t: 5000, a: 0.25, w: 0 };
  clearInterval(window.__pkI);
  window.__pkI = setInterval(() => { const d = window.__disc; d.t += 100; d.a += d.w * 0.01; solcoMidiBatch(SolcoMidi.puckBytes(d.w * 60, d.t, d.a)); }, 10);
}'''
PK = {'STATE': 0x01, 'TRACK': 0x02, 'WAVE': 0x03, 'LHEAD': 0x04, 'LITEMS': 0x05, 'GENRES': 0x06, 'RESULT': 0x07, 'HELLOK': 0x08}

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        page = await (await b.new_context(viewport={'width': 800, 'height': 1280})).new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://127.0.0.1:{PORT}/index.html')
        await page.click('#gateBtn'); await page.wait_for_timeout(400)
        got = lambda name: page.evaluate(f'() => __got({PK[name]})')
        pos = lambda: page.evaluate('() => solco.engine.rep.p / solco.engine.sr')

        # tre brani, uno caricato
        await page.click('#btnBrowse')
        async with page.expect_file_chooser() as fc: await page.click('#brImport')
        await (await fc.value).set_files([f'{MEDIA}/test-128.wav', f'{MEDIA}/test.mp3', f'{MEDIA}/test.flac'])
        for _ in range(150):
            if not await page.eval_on_selector('#busy', 'e => e.textContent'): break
            await page.wait_for_timeout(400)
        n = await page.evaluate('() => solco.tracks().length')
        check('tre brani in libreria', n == 3, n)
        await page.evaluate("() => { const t = solco.tracks(); t[0].genre = 'House'; t[1].genre = 'Techno'; t[2].genre = 'house'; }")
        await page.locator('.br-list .row', has_text='test-128').first.dblclick()
        await page.wait_for_timeout(1200)
        loaded = await page.evaluate('() => solco.D.track && solco.D.track.id')
        check('brano caricato', bool(loaded))

        # il puck si presenta: SOLCO risponde e manda brano, forma d'onda e stato
        await page.evaluate("() => solcoMidiDevices(['SOLCO Puck 3F2A'])")
        await page.evaluate(SETUP)
        await page.wait_for_timeout(400)
        check('disco fermo: modo giradischi, brano fermo', await page.evaluate('() => solco.TT.on && !solco.D.playing'))
        await page.evaluate("() => __pk('hello', { proto: 1, model: 2, fw: '2.0' })")
        await page.wait_for_timeout(300)
        hk = await got('HELLOK')
        check('HELLOK con la versione di SOLCO', len(hk) == 1 and hk[0]['version'] == VERSION, hk)
        check('puck con schermo pronto', await page.evaluate('() => solco.PL.ready && solco.PL.model === 2'))
        tr = await got('TRACK')
        check('TRACK: titolo, BPM 128, durata', len(tr) >= 1 and 'test-128' in tr[-1]['title'] and abs(tr[-1]['bpm'] - 12800) <= 10 and tr[-1]['dur'] > 0, tr[-1] if tr else None)
        wv = await got('WAVE')
        check('WAVE: 120 spicchi con ampiezza e banda', len(wv) >= 1 and len(wv[-1]['bins']) == 120 and max(v & 31 for v in wv[-1]['bins']) > 10, len(wv[-1]['bins']) if wv else None)
        st = await got('STATE')
        check('STATE: brano caricato, fermo, giradischi', len(st) >= 1 and (st[-1]['flags'] & 1) and not (st[-1]['flags'] & 2) and (st[-1]['flags'] & 16), st[-1] if st else None)
        check('STATE: stesso numero di brano di TRACK', st and tr and st[-1]['tseq'] == tr[-1]['tseq'])
        n0 = len(st)
        await page.wait_for_timeout(1000)
        n1 = len(await got('STATE'))
        check('STATE 10 volte al secondo', 7 <= n1 - n0 <= 13, n1 - n0)

        # lista intorno al brano caricato, ordine per artista
        await page.evaluate('() => __clear()')
        await page.evaluate("() => __pk('lreq', { req: 5, sort: 2, compat: 0, start: 0x3FFF, count: 20, genre: '' })")
        await page.wait_for_timeout(200)
        lh = await got('LHEAD'); li = await got('LITEMS')
        items = [it for m in li for it in m['items']]
        check('LHEAD: 3 brani, quello caricato segnato', len(lh) == 1 and lh[0]['req'] == 5 and lh[0]['total'] == 3 and lh[0]['sel'] < 3, lh)
        check('LITEMS: tutti e 3, il caricato col segno', len(items) == 3 and sum(1 for it in items if it['fl'] & 1) == 1 and any(it['id'] == loaded for it in items), [(it['title'], it['fl']) for it in items])
        # per BPM: in ordine crescente (senza BPM in fondo)
        await page.evaluate('() => __clear()')
        await page.evaluate("() => __pk('lreq', { req: 6, sort: 3, compat: 0, start: 0, count: 20, genre: '' })")
        await page.wait_for_timeout(200)
        bp = [it['bpm'] or 99999 for m in await got('LITEMS') for it in m['items']]
        check('ordine per BPM', len(bp) == 3 and bp == sorted(bp), bp)
        # generi: senza doppioni per maiuscole, e filtro per genere
        await page.evaluate('() => __clear()')
        await page.evaluate("() => __pk('greq')")
        await page.wait_for_timeout(200)
        gl = await got('GENRES')
        names = [g['name'] for g in gl[0]['list']] if gl else []
        check('GENRES: House (2) e Techno (1)', len(names) == 2 and gl[0]['list'][0]['n'] == 2 and names[1] == 'Techno', gl)
        await page.evaluate('() => __clear()')
        await page.evaluate("() => __pk('lreq', { req: 7, sort: 1, compat: 0, start: 0, count: 20, genre: 'HOUSE' })")
        await page.wait_for_timeout(200)
        lh = await got('LHEAD')
        check('filtro per genere: 2 brani house', lh and lh[0]['total'] == 2, lh)

        # sfogliare: girare il disco scorre la lista sul puck e il brano resta fermo, poi nessun salto
        p0 = await pos()
        await page.evaluate("() => __pk('browse', { on: 1 })")
        await page.wait_for_timeout(100)
        check('sfoglia: SOLCO lo sa', await page.evaluate('() => solco.TT.browse'))
        await page.evaluate('() => { __disc.w = 1; }')            # un giro al secondo, a mano
        await page.wait_for_timeout(1200)
        await page.evaluate('() => { __disc.w = 0; }')
        await page.wait_for_timeout(300)
        p1 = await pos()
        check('sfogliando il brano non si muove', abs(p1 - p0) < 0.05 and not await page.evaluate('() => solco.D.playing'), round(p1 - p0, 3))
        await page.evaluate("() => __pk('browse', { on: 0 })")
        await page.wait_for_timeout(600)
        p2 = await pos()
        check('fine sfoglia: nessun salto del brano', abs(p2 - p0) < 0.05, round(p2 - p0, 3))
        await page.evaluate('() => { __disc.w = 1 / 1.8; }')       # giradischi a 33 giri
        await page.wait_for_timeout(1500)
        p3 = await pos()
        check('poi il disco comanda di nuovo', p3 - p2 > 0.6 and await page.evaluate('() => solco.D.playing'), round(p3 - p2, 3))

        # carica dal puck: a disco in moto chiede conferma, poi carica
        other = await page.evaluate("(id) => solco.tracks().find((t) => t.id !== id).id", loaded)
        await page.evaluate('() => __clear()')
        await page.evaluate("(id) => __pk('load', { force: 0, id })", other)
        await page.wait_for_timeout(300)
        rs = await got('RESULT')
        check('deck in onda: chiede conferma (codice 1)', len(rs) == 1 and rs[0]['code'] == 1 and len(rs[0]['text']) > 0, rs)
        check('niente caricato senza conferma', await page.evaluate('() => solco.D.track.id') == loaded)
        await page.evaluate('() => __clear()')
        await page.evaluate("(id) => __pk('load', { force: 1, id })", other)
        for _ in range(40):
            if await got('RESULT'): break
            await page.wait_for_timeout(200)
        rs = await got('RESULT')
        check('carica comunque: caricato (codice 0)', len(rs) == 1 and rs[0]['code'] == 0, rs)
        check('il brano nuovo è nel deck', await page.evaluate('() => solco.D.track.id') == other)
        await page.wait_for_timeout(300)
        tr = await got('TRACK')
        check('brano nuovo: TRACK mandato da solo', len(tr) >= 1 and tr[-1]['tseq'] == (await got('STATE'))[-1]['tseq'], tr[-1] if tr else None)
        # disco fermo: carica subito; brano che non c'è
        await page.evaluate('() => { __disc.w = 0; }')
        await page.wait_for_timeout(600)
        await page.evaluate('() => __clear()')
        await page.evaluate("(id) => __pk('load', { force: 0, id })", loaded)
        for _ in range(40):
            if await got('RESULT'): break
            await page.wait_for_timeout(200)
        rs = await got('RESULT')
        check('disco fermo: carica senza chiedere', len(rs) == 1 and rs[0]['code'] == 0 and await page.evaluate('() => solco.D.track.id') == loaded, rs)
        await page.evaluate('() => __clear()')
        await page.evaluate("() => __pk('load', { force: 0, id: 'nessuno' })")
        await page.wait_for_timeout(200)
        rs = await got('RESULT')
        check('brano che non c’è: codice 2', len(rs) == 1 and rs[0]['code'] == 2, rs)

        await page.click('#btnSettings'); await page.wait_for_timeout(200)
        await page.locator('#setTabs button', has_text='COMANDI').click(); await page.wait_for_timeout(200)
        check('impostazioni: puck con schermo', '(con schermo)' in await page.inner_text('#ttStat'), await page.inner_text('#ttStat'))

        # il puck tace: dopo 5 s SOLCO smette di mandargli lo stato
        await page.evaluate('() => { clearInterval(window.__pkI); }')
        await page.wait_for_timeout(5600)
        check('puck muto: non più pronto', not await page.evaluate('() => solco.PL.ready'))
        await page.evaluate('() => __clear()')
        await page.wait_for_timeout(400)
        check('niente stato a un puck muto', len(await got('STATE')) == 0)

        check('nessun errore nella pagina', not errs, errs)
        await b.close()
    print('FALLITI:', fails)
    return fails

raise SystemExit(1 if asyncio.run(main()) else 0)
