# Assegnazione MIDI di controller qualsiasi: fader del tempo a 14 bit su due CC
# (byte alto n e basso n+32, in qualsiasi ordine), fader a 7 bit, jog con il bordo
# su un CC a parte. I messaggi arrivano dal ponte usato dall'app Android.
# Uso: python3 tests/ui_midi_learn_test.py
import asyncio, threading, http.server, socketserver, functools, os
from playwright.async_api import async_playwright

ROOT = os.environ.get('SOLCO_ROOT', '/home/claude/solco/web')
PORT = 8819

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

        async def send(*msgs):
            for m in msgs:
                await page.evaluate('(m) => solcoMidiIn(m)', list(m))
                await page.wait_for_timeout(15)

        async def entry(fn):
            return await page.evaluate('(fn) => solco.midi.map.find((m) => m.fn === fn) || null', fn)

        async def pitch():
            return await page.evaluate('() => solco.D.pitch')

        inv = await page.evaluate('() => !!solco.S.invertFader')
        def expect(msb, lsb):
            n = ((msb << 7) | lsb) / 16383 * 2 - 1
            return -n if inv else n

        # 1) fader del tempo a 14 bit: CC 8 (alto) + CC 40 (basso) sul canale 2
        await page.evaluate("() => { window.__ok = false; solco.midi.learn('tempo', () => { window.__ok = true; }); }")
        await send((0xB1, 8, 64), (0xB1, 40, 0), (0xB1, 8, 64), (0xB1, 40, 9))
        await page.wait_for_timeout(450)
        e = await entry('tempo')
        check('fader riconosciuto a 14 bit (CC 8 + CC 40)', await page.evaluate('() => window.__ok') and e and e['mode'] == 'abs14cc' and e['num'] == 8 and e['lsb'] == 40 and e['ch'] == 1, e)
        check('descrizione con «14 bit»', '14 bit' in await page.evaluate("() => solco.midi.describe('tempo')"))

        await send((0xB1, 8, 64), (0xB1, 40, 0))
        await send((0xB1, 8, 66), (0xB1, 40, 0))
        v1 = await pitch()
        check('byte alto poi basso: tempo giusto', abs(v1 - expect(66, 0)) < 1e-6, (v1, expect(66, 0)))
        await send((0xB1, 40, 77))
        v2 = await pitch()
        check('il solo byte basso sposta il tempo (precisione 14 bit)', abs(v2 - expect(66, 77)) < 1e-6 and v2 != v1, (v2, expect(66, 77)))
        await send((0xB1, 40, 10), (0xB1, 8, 63))
        v3 = await pitch()
        check('ordine inverso (basso poi alto): valore finale esatto', abs(v3 - expect(63, 10)) < 1e-6, (v3, expect(63, 10)))

        # 2) fader a 7 bit: un solo CC
        await page.evaluate("() => solco.midi.learn('tempo', () => {})")
        await send((0xB0, 16, 60), (0xB0, 16, 61), (0xB0, 16, 62))
        await page.wait_for_timeout(450)
        e = await entry('tempo')
        check('fader a un solo CC: 7 bit', e and e['mode'] == 'abs7' and e['num'] == 16 and 'lsb' not in e, e)
        await send((0xB0, 16, 64))
        v4 = await pitch()
        n7 = 64 / 127 * 2 - 1
        check('fader a 7 bit muove il tempo', abs(v4 - (-n7 if inv else n7)) < 1e-6, v4)

        # 3) jog: sopra (CC 10) e bordo (CC 9) su CC diversi, tutti e due attivi
        await page.evaluate("() => { window.__acts = []; const o = solco.midi.onAction; solco.midi.onAction = (fn, v, ev) => { window.__acts.push([fn, v]); o(fn, v, ev); }; }")
        await page.evaluate("() => solco.midi.learn('jog', () => {})")
        await send((0xB1, 10, 1))
        await page.evaluate("() => solco.midi.learn('jog2', () => {})")
        await send((0xB1, 9, 1))
        j1, j2 = await entry('jog'), await entry('jog2')
        check('jog sopra assegnata (CC 10)', j1 and j1['num'] == 10 and j1['mode'] == 'rel2c', j1)
        check('jog bordo assegnata (CC 9) senza togliere l\'altra', j2 and j2['num'] == 9 and j2['mode'] == 'rel2c', j2)
        await page.evaluate('() => { window.__acts = []; }')
        await send((0xB1, 9, 1), (0xB1, 10, 127))
        acts = await page.evaluate('() => window.__acts')
        tpr = await page.evaluate('() => solco.midi.ticksPerRev')
        check('bordo e sopra muovono la jog nei due versi', len(acts) == 2 and acts[0][0] == 'jog' and acts[1][0] == 'jog' and abs(acts[0][1] - 1 / tpr) < 1e-9 and abs(acts[1][1] + 1 / tpr) < 1e-9, acts)

        # 4) annullare durante l'attesa del fader non assegna nulla
        await page.evaluate("() => { solco.midi.learn('tempoReset', () => {}); solco.midi.learn('tempo', () => { window.__late = true; }); }")
        await send((0xB2, 5, 10))
        await page.evaluate('() => solco.midi.cancelLearn()')
        await page.wait_for_timeout(450)
        e = await entry('tempo')
        check('annulla durante l\'attesa: resta la mappatura di prima', e and e['num'] == 16 and not await page.evaluate('() => !!window.__late'), e)

        # 5) schermata Comandi: riga «Jog (bordo)» e fader «14 bit»
        await page.evaluate("() => solco.midi.learn('tempo', () => {})")
        await send((0xB1, 8, 50), (0xB1, 40, 1))
        await page.wait_for_timeout(450)
        await page.click('#btnSettings')
        await page.locator('#setTabs button', has_text='Comandi').click()
        await page.wait_for_timeout(200)
        rows = await page.locator('#mGrid .map-row').all_inner_texts()
        check('riga «Jog (bordo)» nelle impostazioni', any(r.startswith('Jog (bordo)') for r in rows))
        check('riga del fader con «14 bit»', any('Fader tempo' in r and '14 bit' in r for r in rows), [r for r in rows if 'Fader' in r])
        os.makedirs('shots', exist_ok=True)
        await page.screenshot(path='shots/midi_comandi.png')

        check('nessun errore nella pagina', not errs, errs)
        await b.close()
    print('FALLITI:', fails)

asyncio.run(main())
