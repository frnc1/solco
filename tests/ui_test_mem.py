import asyncio, threading, http.server, socketserver, functools
from playwright.async_api import async_playwright
PORT=8813
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
socketserver.TCPServer.allow_reuse_address=True
threading.Thread(target=lambda: socketserver.TCPServer(('127.0.0.1',PORT),functools.partial(Q,directory='/home/claude/solco/dist')).serve_forever(),daemon=True).start()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        page=await (await b.new_context(viewport={'width':1280,'height':800})).new_page()
        errs=[]; page.on('pageerror',lambda e: errs.append(str(e)))
        await page.add_init_script("Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true});")
        await page.goto(f'http://127.0.0.1:{PORT}/solco.html'); await page.click('#gateBtn'); await page.wait_for_timeout(300)
        await page.click('#btnBrowse')
        async with page.expect_file_chooser() as fc: await page.click('#brImport')
        await (await fc.value).set_files(['/home/claude/solco/tests/media/test.mp3'])
        for i in range(60):
            if not await page.eval_on_selector('#busy','e=>e.textContent'): break
            await page.wait_for_timeout(300)
        await page.locator('.br-list .row').first.dblclick(); await page.wait_for_timeout(1000)
        await page.click('#tPlay'); await page.wait_for_timeout(1000)
        r=await page.evaluate("()=>({mem: SolcoLibrary.memoryOnly, title: solco.D.track&&solco.D.track.title, pos: solco.engine.estimate()/solco.engine.sr, art: !!document.querySelector('#art img')})")
        print(r, 'errori:', errs or 'nessuno')
        await b.close()
asyncio.run(main())
