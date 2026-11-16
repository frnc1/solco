# BPM scritto a mano (tocco sul BPM o sulla percentuale sotto il fader), Chrome headless verticale.
# Uso: python3 tests/ui_bpm_test.py
import asyncio, threading, http.server, socketserver, functools, os, time
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PORT = 8821
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
        await page.click('#gateBtn'); await page.wait_for_timeout(400)

        async def toast():
            return await page.locator('#toast').inner_text()

        # senza brano: solo un avviso
        await page.click('#info .c-tempo'); await page.wait_for_timeout(150)
        check('senza brano: avviso, nessuna finestra', 'Carica' in await toast() and await page.locator('#modal.hidden').count() == 1, await toast())

        await page.click('#btnBrowse')
        async with page.expect_file_chooser() as fc: await page.click('#brImport')
        await (await fc.value).set_files([f'{MEDIA}/test-128.wav'])
        for _ in range(100):
            if not await page.eval_on_selector('#busy', 'e => e.textContent'): break
            await page.wait_for_timeout(400)
        await page.locator('.br-list .row', has_text='test-128').first.dblclick()
        await page.wait_for_timeout(1200)
        bpm0 = await page.evaluate('() => solco.D.bpm')
        check('brano caricato a 128 BPM', abs(bpm0 - 128) < 0.05, bpm0)

        async def enter(txt, how='button', where='#info .c-tempo'):
            await page.click(where)
            await page.wait_for_selector('#modal:not(.hidden)')
            await page.fill('#bpmIn', txt)
            if how == 'enter': await page.press('#bpmIn', 'Enter')
            elif how == 'cancel': await page.locator('#mBtns button', has_text='ANNULLA').click()
            else: await page.locator('#mBtns button', has_text='IMPOSTA').click()
            await page.wait_for_timeout(250)

        async def state():
            return await page.evaluate('() => ({ pitch: solco.D.pitch, r: solco.RANGES[solco.S.rangeIdx], f: 1 + solco.D.pitch * solco.RANGES[solco.S.rangeIdx] / 100, take: solco.D.softTakeover, big: document.getElementById("bpmBig").textContent })')

        # 1) tocco sul BPM: finestra col valore attuale, 130 → esatto, range ±10% invariato
        await page.click('#info .c-tempo')
        await page.wait_for_selector('#modal:not(.hidden)')
        val = await page.input_value('#bpmIn')
        check('la finestra propone il BPM attuale', val == '128.00', val)
        await page.screenshot(path='shots/bpm_finestra.png')
        await page.locator('#mBtns button', has_text='ANNULLA').click()
        await page.wait_for_timeout(150)

        await enter('130')
        s = await state()
        check('130 BPM esatti', abs(s['f'] * bpm0 - 130) < 1e-6 and s['r'] == 10 and s['big'] == '130.00', s)
        check('fader fisico in presa morbida dopo il BPM scritto', s['take'] is True, s)

        # 2) dalla percentuale sotto il fader, con Invio: 100 BPM vuole −21,9% → range ±50%
        await enter('100', how='enter', where='#tPct')
        s = await state()
        t = await toast()
        check('100 BPM: range allargato al più stretto che basta (±50%)', abs(s['f'] * bpm0 - 100) < 1e-6 and s['r'] == 50 and '±50%' in t, (s, t))

        # 3) virgola italiana e valore vicinissimo all'originale: niente zona morta
        await enter('128,2')
        s = await state()
        check('«128,2» con la virgola: 128.20 esatti', abs(s['f'] * bpm0 - 128.2) < 1e-6 and s['big'] == '128.20', s)

        # 4) fuori portata, testo non valido, ANNULLA: il tempo non cambia
        await enter('300')
        s2 = await state()
        check('300 BPM rifiutati (oltre ±50%)', abs(s2['pitch'] - s['pitch']) < 1e-12 and 'Troppo lontano' in await toast(), s2)
        await enter('abc')
        s3 = await state()
        check('testo non valido rifiutato', abs(s3['pitch'] - s['pitch']) < 1e-12 and 'non valido' in await toast())
        await enter('90', how='cancel')
        s4 = await state()
        check('ANNULLA non cambia nulla', abs(s4['pitch'] - s['pitch']) < 1e-12)

        # 5) fader fisico (mappatura SOLCO, pitch bend canale 15): lontano non salta, vicino riprende
        inv = await page.evaluate('() => !!solco.S.invertFader')
        def pb(n):
            v = (-n if inv else n)
            x = max(0, min(16383, round((v + 1) / 2 * 16383)))
            return [0xEE, x & 0x7F, x >> 7]
        await page.evaluate('(m) => solcoMidiIn(m)', pb(0.9))
        s5 = await state()
        check('fader fisico lontano: il tempo scritto resta', abs(s5['pitch'] - s['pitch']) < 1e-12, s5)
        await page.evaluate('(m) => solcoMidiIn(m)', pb(s['pitch'] + 0.01))
        s6 = await state()
        check('fader fisico raggiunto: riprende il comando', s6['take'] is False and abs(s6['pitch'] - s['pitch']) < 0.03, s6)

        # 6) il motore suona davvero più veloce: 140 BPM = ×1,09375
        await enter('140')
        await page.click('#tPlay'); await page.wait_for_timeout(500)
        a0 = await page.evaluate('() => solco.engine.estimate() / solco.engine.sr'); w0 = time.time()
        await page.wait_for_timeout(2000)
        a1 = await page.evaluate('() => solco.engine.estimate() / solco.engine.sr'); w1 = time.time()
        ratio = (a1 - a0) / (w1 - w0)
        check('motore a ×1,094 (140/128)', abs(ratio - 140 / 128) < 0.04, round(ratio, 4))
        await page.click('#tPlay')

        check('nessun errore nella pagina', not errs, errs)
        await b.close()
    print('FALLITI:', fails)

asyncio.run(main())
