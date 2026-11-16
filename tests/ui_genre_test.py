# Filtro per genere nella lista dei brani (Chrome headless, verticale 800x1280).
# Uso: python3 tests/ui_genre_test.py
import asyncio, threading, http.server, socketserver, functools, os
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PORT = 8818
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
        page = await (await b.new_context(viewport={'width': 800, 'height': 1280})).new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://127.0.0.1:{PORT}/index.html')
        await page.click('#gateBtn'); await page.wait_for_timeout(300)
        await page.click('#btnBrowse')
        async with page.expect_file_chooser() as fc: await page.click('#brImport')
        await (await fc.value).set_files([f'{MEDIA}/test-128.wav', f'{MEDIA}/test.mp3'])
        for _ in range(100):
            if not await page.eval_on_selector('#busy', 'e => e.textContent'): break
            await page.wait_for_timeout(400)
        check('etichetta CAMELOT nell\'ordinamento', await page.locator('#brSort button[data-s="key"]').inner_text() == 'CAMELOT')
        # generi come arriverebbero dai tag dei file
        await page.evaluate("() => { const t = solco.tracks(); t[0].genre = 'Techno'; t[1].genre = 'Melodic House & Techno'; }")
        await page.click('#brGenre')
        await page.wait_for_selector('#modal:not(.hidden)')
        labels = await page.locator('#mBtns button').all_inner_texts()
        check('menu: ANNULLA, TUTTI e i due generi', len(labels) == 4 and any('Techno' == l.split('\n')[0].split(' 1')[0].strip() for l in labels), labels)
        await page.locator('#mBtns button', has_text='Melodic').click()
        await page.wait_for_timeout(200)
        rows = await page.locator('.br-list .row').count()
        check('filtro attivo: un solo brano', rows == 1, rows)
        pill = await page.locator('#brGenre').inner_text()
        check('pulsante col nome del genere', pill.startswith('MELODIC'), pill)
        art = await page.locator('.br-list .row .rt span').first.inner_text()
        check('genere visibile sotto il titolo', 'Melodic House & Techno' in art, art)
        status = await page.locator('#brStatus').inner_text()
        check('stato: 1 di 2', '1 di 2' in status, status)
        await page.click('#brGenre')
        await page.wait_for_selector('#modal:not(.hidden)')
        await page.locator('#mBtns button', has_text='TUTTI').click()
        await page.wait_for_timeout(200)
        rows = await page.locator('.br-list .row').count()
        check('TUTTI: di nuovo tutti i brani', rows == 2, rows)
        check('pulsante tornato GENERE', await page.locator('#brGenre').inner_text() == 'GENERE')
        await page.screenshot(path='/tmp/solco_shots/shots/genere.png')
        # stesso file reimportato da un'altra provenienza (es. Drive): data diversa, stesso nome e dimensione → saltato
        n = await page.evaluate("""async () => {
          const mk = (lm) => new File([new Uint8Array(4096)], 'doppio.wav', { type: 'audio/wav', lastModified: lm });
          await solco.importFiles([mk(1000)]);
          await solco.importFiles([mk(987654321)]);
          return solco.tracks().filter((t) => t.fileName === 'doppio.wav').length;
        }""")
        check('stesso brano da un\'altra cartella: niente doppione', n == 1, n)
        t = await page.locator('#toast').inner_text()
        check('avviso «già presenti»', 'già present' in t, t)
        check('nessun errore nella pagina', not errs, errs)
        await b.close()
    print('FALLITI:', fails)

asyncio.run(main())
