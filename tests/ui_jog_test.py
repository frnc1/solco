# Jog e fader a schermo in Chrome headless: scratch, spinta, fader che non salta, TEMPO 0, range, screenshot.
# Uso: python3 tests/ui_jog_test.py            (verticale 800x1280 e orizzontale 1280x800, screenshot in shots/)
import asyncio, threading, http.server, socketserver, functools, os, math
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PORT = 8813
MEDIA = '/home/claude/solco/tests/media'
os.makedirs('shots', exist_ok=True)

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
threading.Thread(target=lambda: socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Q, directory=ROOT)).serve_forever(), daemon=True).start()

fails = 0
def check(name, ok, info=''):
    global fails
    print(('ok   ' if ok else 'FAIL ') + name + ('  → ' + str(info) if info != '' else ''))
    if not ok: fails += 1

async def setup(p, w, h):
    b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)
    page = await ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto(f'http://127.0.0.1:{PORT}/index.html')
    await page.click('#gateBtn'); await page.wait_for_timeout(400)
    await page.click('#btnBrowse')
    async with page.expect_file_chooser() as fc: await page.click('#brImport')
    await (await fc.value).set_files([f'{MEDIA}/test-128.wav', f'{MEDIA}/test.mp3'])
    for _ in range(100):
        if not await page.eval_on_selector('#busy', 'e => e.textContent'): break
        await page.wait_for_timeout(400)
    await page.locator('.br-list .row', has_text='test-128').first.dblclick()
    await page.wait_for_timeout(1200)
    return b, page, errs

async def pos(page):
    return await page.evaluate('() => solco.engine.estimate() / solco.engine.sr')

async def jog_geom(page):
    return await page.evaluate("() => { const r = document.getElementById('jog').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: r.width / 2 * 0.985 }; }")

async def arc(page, g, rad, a0, a1, steps, ms):
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / steps
        await page.mouse.move(g['cx'] + math.cos(a) * rad, g['cy'] + math.sin(a) * rad)
        await page.wait_for_timeout(ms)

async def portrait(p):
    b, page, errs = await setup(p, 800, 1280)
    check('verticale: comandi a schermo visibili', await page.evaluate("() => document.getElementById('app').classList.contains('touch-on') && getComputedStyle(document.getElementById('deck')).display !== 'none'"))
    g = await jog_geom(page)
    check('verticale: jog grande (diametro in px CSS)', g['R'] * 2 > 560, round(g['R'] * 2))
    await page.click('#hotcues .hc >> nth=0')
    await page.click('#tPlay'); await page.wait_for_timeout(1500)

    # scratch: tocco sul piatto (modo vinile) → il brano si ferma sotto il dito
    await page.mouse.move(g['cx'], g['cy'] - g['R'] * 0.55)
    await page.mouse.down()
    await page.wait_for_timeout(250)
    a = await pos(page); await page.wait_for_timeout(500); b2 = await pos(page)
    check('piatto toccato: il brano resta fermo', abs(b2 - a) < 0.03, round(b2 - a, 3))
    sc = await page.evaluate('() => solco.engine.rep.sc')
    check('piatto toccato: motore in scratch', sc is True, sc)
    await page.screenshot(path='shots/jog-v-scratch.png')
    # un quarto di giro in senso orario = 1,8 s / 4 di brano
    a = await pos(page)
    await arc(page, g, g['R'] * 0.55, -math.pi / 2, 0, 24, 12)
    await page.wait_for_timeout(250)
    b2 = await pos(page)
    check('quarto di giro avanti ≈ +0,45 s', abs((b2 - a) - 0.45) < 0.07, round(b2 - a, 3))
    a = await pos(page)
    await arc(page, g, g['R'] * 0.55, 0, -math.pi / 2, 24, 12)
    await page.wait_for_timeout(250)
    b2 = await pos(page)
    check('quarto di giro indietro ≈ −0,45 s', abs((b2 - a) + 0.45) < 0.07, round(b2 - a, 3))
    await page.mouse.up()
    await page.wait_for_timeout(300)
    a = await pos(page); await page.wait_for_timeout(1000); b2 = await pos(page)
    check('rilasciato: riparte a velocità normale', abs((b2 - a) - 1.0) < 0.12, round(b2 - a, 3))

    # spinta sull'anello mentre suona: velocità sopra 1 mentre giri in avanti
    rates = []
    await page.mouse.move(g['cx'] + g['R'] * 0.87, g['cy'])
    await page.mouse.down()
    for i in range(30):
        ang = i * 0.06
        await page.mouse.move(g['cx'] + math.cos(ang) * g['R'] * 0.87, g['cy'] + math.sin(ang) * g['R'] * 0.87)
        await page.wait_for_timeout(16)
        rates.append(await page.evaluate('() => solco.engine.rep.r'))
    await page.mouse.up()
    check('anello girato in avanti: il brano accelera', max(rates) > 1.01, round(max(rates), 3))
    sc = await page.evaluate('() => solco.engine.rep.sc')
    check('anello: niente scratch', sc is False, sc)

    # fader: toccarlo non sposta il tempo; trascinarlo sì
    fr = await page.evaluate("() => { const r = document.getElementById('tFader').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top, h: r.height }; }")
    await page.mouse.move(fr['x'], fr['y'] + fr['h'] * 0.85)
    await page.mouse.down(); await page.wait_for_timeout(100)
    p0 = await page.evaluate('() => solco.D.pitch')
    check('tocco sul fader lontano dal cursore: nessun salto', p0 == 0, p0)
    await page.mouse.move(fr['x'], fr['y'] + fr['h'] * 0.85 + 40, steps=8)
    p1 = await page.evaluate('() => solco.D.pitch')
    await page.mouse.up()
    check('trascinato in giù: tempo più veloce', p1 > 0.05, round(p1, 3))
    # range: il tempo resta uguale
    t0 = await page.evaluate('() => solco.engine.rep && (1 + solco.D.pitch * [6, 8, 10, 16, 50][solco.S.rangeIdx] / 100)')
    await page.click('#tRange'); await page.wait_for_timeout(100)
    t1 = await page.evaluate('() => 1 + solco.D.pitch * [6, 8, 10, 16, 50][solco.S.rangeIdx] / 100')
    check('cambio range: tempo invariato', abs(t1 - t0) < 1e-6, (round(t0, 5), round(t1, 5)))
    # TEMPO 0: un tocco non basta, tenendo premuto sì
    await page.click('#tReset'); await page.wait_for_timeout(100)
    p2 = await page.evaluate('() => solco.D.pitch')
    check('TEMPO 0 toccato: tempo invariato', p2 != 0, round(p2, 3))
    box = await page.locator('#tReset').bounding_box()
    await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    await page.mouse.down(); await page.wait_for_timeout(650); await page.mouse.up()
    p3 = await page.evaluate('() => solco.D.pitch')
    check('TEMPO 0 tenuto premuto: tempo a zero', p3 == 0, p3)

    # modo solo spinta: il piatto non ferma il brano
    await page.click('#tVinyl'); await page.wait_for_timeout(100)
    await page.mouse.move(g['cx'], g['cy'] - g['R'] * 0.5)
    await page.mouse.down()
    a = await pos(page); await page.wait_for_timeout(500); b2 = await pos(page)
    await page.mouse.up()
    check('solo spinta: toccando il piatto il brano continua', b2 - a > 0.4, round(b2 - a, 3))
    await page.click('#tVinyl')
    await page.click('#tAuto'); await page.wait_for_timeout(1400)
    await page.screenshot(path='shots/jog-v-playing.png')
    check('verticale: nessun errore nella pagina', not errs, errs)
    await b.close()

async def landscape(p):
    b, page, errs = await setup(p, 1280, 800)
    g = await jog_geom(page)
    check('orizzontale: jog visibile', g['R'] * 2 > 400, round(g['R'] * 2))
    await page.click('#hotcues .hc >> nth=0')
    await page.click('#tPlay'); await page.wait_for_timeout(1500)
    await page.screenshot(path='shots/jog-o-playing.png')
    # con la jog fisica collegata i comandi a schermo spariscono
    await page.evaluate("() => { solco.S.touchControls = 'off'; document.getElementById('app').classList.remove('touch-on'); window.dispatchEvent(new Event('resize')); }")
    await page.wait_for_timeout(400)
    await page.screenshot(path='shots/jog-o-fisica.png')
    check('orizzontale: nessun errore nella pagina', not errs, errs)
    await b.close()

async def main():
    async with async_playwright() as p:
        await portrait(p)
        await landscape(p)
    print('FALLITI:', fails)

asyncio.run(main())
