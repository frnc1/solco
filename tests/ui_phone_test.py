# Disposizione smartphone: automatica sugli schermi piccoli, scelta in Impostazioni. Chrome headless.
# Uso: python3 tests/ui_phone_test.py
import asyncio, threading, http.server, socketserver, functools, os
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PORT = 8824
SHOTS = '/home/claude/solco/shots'

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
threading.Thread(target=lambda: socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Q, directory=ROOT)).serve_forever(), daemon=True).start()

fails = 0
def check(name, ok, info=''):
    global fails
    print(('ok   ' if ok else 'FAIL ') + name + ('  → ' + str(info) if info != '' else ''))
    if not ok: fails += 1

async def open_page(p, w, h):
    b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = await b.new_context(viewport={'width': w, 'height': h}, screen={'width': w, 'height': h}, device_scale_factor=2)
    page = await ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto(f'http://127.0.0.1:{PORT}/index.html')
    await page.click('#gateBtn'); await page.wait_for_timeout(500)
    return b, page, errs

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as p:
        # smartphone verticale
        b, page, errs = await open_page(p, 390, 844)
        check('smartphone: disposizione automatica', await page.evaluate("() => document.getElementById('app').classList.contains('phone')"))
        check('smartphone: jog e fader nascosti', not await page.is_visible('#deck'))
        check('smartphone: SLIP e KEY LOCK nella fila in basso', await page.evaluate("() => document.getElementById('tSlip').parentNode.id === 'transport' && document.getElementById('tKL').parentNode.id === 'transport'"))
        check('smartphone: tasti in basso visibili', await page.is_visible('#tSlip') and await page.is_visible('#tKL') and await page.is_visible('#tPlay'))
        await page.click('#tKL'); await page.wait_for_timeout(100)
        check('smartphone: KEY LOCK funziona', await page.evaluate("() => document.getElementById('tKL').classList.contains('on')"))
        box = await page.eval_on_selector('#transport', 'e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; }')
        check('smartphone: la fila in basso sta nello schermo', box[1] <= box[2] + 1, box)
        await page.screenshot(path=f'{SHOTS}/phone_portrait.png')
        # passaggio a TABLET dalle impostazioni
        await page.click('#btnSettings'); await page.wait_for_timeout(200)
        await page.locator('#setTabs button', has_text='SCHERMO').click(); await page.wait_for_timeout(200)
        await page.locator('.set-row', has_text='Disposizione').locator('button', has_text='TABLET').click(); await page.wait_for_timeout(300)
        check('scelta TABLET: torna la jog', await page.evaluate("() => !document.getElementById('app').classList.contains('phone') && document.getElementById('tSlip').parentNode.id === 'jogWrap'"))
        check('scelta TABLET: KEY LOCK resta acceso', await page.evaluate("() => document.getElementById('tKL').classList.contains('on')"))
        check('nessun errore (smartphone)', not errs, errs)
        await b.close()
        # smartphone orizzontale
        b, page, errs = await open_page(p, 844, 390)
        check('smartphone orizzontale: disposizione smartphone', await page.evaluate("() => document.getElementById('app').classList.contains('phone')"))
        box = await page.eval_on_selector('#transport', 'e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; }')
        check('smartphone orizzontale: tutto nello schermo', box[1] <= box[2] + 1, box)
        await page.screenshot(path=f'{SHOTS}/phone_landscape.png')
        check('nessun errore (orizzontale)', not errs, errs)
        await b.close()
        # tablet: resta la disposizione di prima
        b, page, errs = await open_page(p, 800, 1280)
        check('tablet: jog visibile', await page.evaluate("() => !document.getElementById('app').classList.contains('phone')") and await page.is_visible('#jog'))
        check('nessun errore (tablet)', not errs, errs)
        await b.close()
    print('FALLITI:', fails)

asyncio.run(main())
