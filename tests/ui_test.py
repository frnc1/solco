# Prova l'interfaccia in Chrome headless: importa brani, carica, suona, hot cue, loop, screenshot.
import asyncio, sys, threading, http.server, socketserver, functools, json, os
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PAGE = os.environ.get('SOLCO_PAGE', 'index.html')
PORT = 8811
MEDIA = '/home/claude/solco/tests/media'

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Quiet, directory=ROOT))
    httpd.serve_forever()
threading.Thread(target=serve, daemon=True).start()

async def run(name, w, h, scale):
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=scale, has_touch=True)
        await ctx.grant_permissions(['midi'], origin=f'http://127.0.0.1:{PORT}')
        page = await ctx.new_page()
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await page.goto(f'http://127.0.0.1:{PORT}/{PAGE}')
        await page.wait_for_timeout(700)
        await page.screenshot(path=f'shots/{name}-0-gate.png')
        await page.click('#gateBtn')
        await page.wait_for_timeout(600)
        await page.screenshot(path=f'shots/{name}-1-empty.png')
        await page.click('#btnBrowse')
        async with page.expect_file_chooser() as fc:
            await page.click('#brImport')
        ch = await fc.value
        await ch.set_files([f'{MEDIA}/test.mp3', f'{MEDIA}/test-128.wav', f'{MEDIA}/test16.aiff', f'{MEDIA}/test.flac'])
        for i in range(120):
            busy = await page.eval_on_selector('#busy', 'e => e.textContent')
            if not busy:
                break
            await page.wait_for_timeout(500)
        await page.wait_for_timeout(300)
        await page.screenshot(path=f'shots/{name}-2-browser.png')
        rows = await page.evaluate("() => [...document.querySelectorAll('.br-list .row')].map(r => r.innerText.replace(/\\n/g,' | '))")
        print('righe:', json.dumps(rows, ensure_ascii=False))
        # carica il brano WAV da 75 s (doppio tocco)
        row = page.locator('.br-list .row', has_text='test-128').first
        if await row.count() == 0:
            row = page.locator('.br-list .row').first
        await row.dblclick()
        await page.wait_for_timeout(1500)
        st = await page.evaluate("() => ({title: solco.D.track && solco.D.track.title, bpm: solco.D.bpm, cue: solco.D.cue/solco.D.sr, mode: solco.engine.mode, sr: solco.engine.sr, ctx: solco.engine.ctx && solco.engine.ctx.state})")
        print('caricato:', st)
        await page.click('#tPlay')
        await page.wait_for_timeout(2200)
        p1 = await page.evaluate("() => solco.engine.estimate()/solco.engine.sr")
        await page.click('#hotcues .hc >> nth=0')
        await page.wait_for_timeout(1300)
        await page.click('#tAuto')
        await page.wait_for_timeout(1500)
        # tempo +3%
        await page.evaluate("() => { const S = solco.S; }")
        await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp')
        await page.keyboard.press('KeyK')
        await page.wait_for_timeout(1200)
        await page.screenshot(path=f'shots/{name}-3-playing.png')
        st2 = await page.evaluate("() => ({pos: solco.engine.estimate()/solco.engine.sr, playing: solco.D.playing, loop: solco.D.loop, hot: solco.D.hot.filter(Boolean).length, pitch: solco.D.pitch, keyLock: solco.S.keyLock, kl: solco.engine.rep.kl})")
        print('pos dopo 2,2 s:', round(p1, 3), '| stato:', st2)
        # esce dal loop, apre impostazioni
        await page.click('#tAuto')
        await page.click('#btnSettings')
        await page.wait_for_timeout(300)
        await page.screenshot(path=f'shots/{name}-4-settings.png')
        await page.click('#setTabs button >> nth=2')
        await page.wait_for_timeout(300)
        await page.screenshot(path=f'shots/{name}-5-midi.png')
        await page.click('#setClose')
        # comandi MIDI simulati: jog e fader
        await page.evaluate("() => { solco.midi.handle([0x90, 0x01, 127], performance.now()); }")
        await page.wait_for_timeout(300)
        await page.evaluate("() => { for (let i=0;i<20;i++) solco.midi.handle([0xEF, 0, (64 + i*2) & 127], performance.now()); solco.midi.handle([0xEE, 0, 80], performance.now()); }")
        await page.wait_for_timeout(300)
        st3 = await page.evaluate("() => ({playing: solco.D.playing, pitch: solco.D.pitch})")
        print('dopo MIDI (play + fader):', st3)
        await page.screenshot(path=f'shots/{name}-6-after-midi.png')
        errs = [l for l in logs if 'PAGEERROR' in l or l.startswith('error')]
        print('errori:', errs if errs else 'nessuno')
        await b.close()

async def main():
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == 'lite':
        await run('lite', 1408, 880, 1.5)
    else:
        await run('s9', 1280, 800, 2)
asyncio.run(main())
