"""Prova del firmware SOLCO su un computer: simula i moduli di CircuitPython
(pulsanti, manopola, AS5600, NeoSlider, tocco) e controlla i messaggi MIDI prodotti."""
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = open(os.path.join(ROOT, 'firmware', 'code.py'), encoding='utf-8').read()


class Fine(Exception):
    pass


def costruisci(scenario):
    """scenario(ms, stato) viene chiamato a ogni lettura dell'orologio e modifica lo stato."""
    stato = {
        'ms': 0, 'angolo': 1000, 'premuti': set(), 'manopola': 0, 'tocco': 2000,
        'fader': 512, 'midi': [], 'nvm': bytearray(16), 'tempo_max': 3000,
        'i2c_assente': False, 'pins_bassi': set(),
    }
    mods = {}

    board = types.ModuleType('board')
    for n in list(range(0, 29)):
        setattr(board, 'GP%d' % n, 'GP%d' % n)
    board.LED = 'LED'
    mods['board'] = board

    tm = types.ModuleType('time')

    def monotonic_ns():
        stato['ms'] += 1
        if stato['ms'] > stato['tempo_max']:
            raise Fine()
        scenario(stato['ms'], stato)
        return stato['ms'] * 1000000

    def sleep(s):
        for _ in range(max(1, int(s * 1000))):
            stato['ms'] += 1
            if stato['ms'] > stato['tempo_max']:
                raise Fine()
            scenario(stato['ms'], stato)

    tm.monotonic_ns = monotonic_ns
    tm.sleep = sleep
    mods['time'] = tm

    dio = types.ModuleType('digitalio')

    class Dir:
        OUTPUT = 'out'
        INPUT = 'in'

    class Pull:
        UP = 'up'
        DOWN = 'down'

    class DigitalInOut:
        def __init__(self, pin):
            self.pin = pin
            self.direction = None
            self._v = False

        def switch_to_input(self, pull=None):
            pass

        @property
        def value(self):
            if self.pin == 'LED':
                return self._v
            return self.pin not in stato['pins_bassi']

        @value.setter
        def value(self, v):
            self._v = v

        def deinit(self):
            pass

    dio.Direction = Dir
    dio.Pull = Pull
    dio.DigitalInOut = DigitalInOut
    mods['digitalio'] = dio

    kp = types.ModuleType('keypad')

    class Event:
        def __init__(self):
            self.key_number = 0
            self.pressed = False

    class Coda:
        def __init__(self, keys):
            self.keys = keys

        def get_into(self, ev):
            k = self.keys
            for i, p in enumerate(k.pins):
                giu = p in stato['premuti']
                if giu != k.ultimo[i]:
                    k.ultimo[i] = giu
                    ev.key_number = i
                    ev.pressed = giu
                    return True
            return False

    class Keys:
        def __init__(self, pins, value_when_pressed, pull, interval, debounce_threshold=1):
            self.pins = list(pins)
            self.ultimo = [False] * len(self.pins)
            self.events = Coda(self)

    kp.Event = Event
    kp.Keys = Keys
    mods['keypad'] = kp

    mc = types.ModuleType('microcontroller')
    mc.nvm = stato['nvm']
    mods['microcontroller'] = mc

    rot = types.ModuleType('rotaryio')

    class Enc:
        def __init__(self, a, b, divisor=4):
            assert (a, b) == ('GP27', 'GP28')

        @property
        def position(self):
            return stato['manopola']

    rot.IncrementalEncoder = Enc
    mods['rotaryio'] = rot

    um = types.ModuleType('usb_midi')

    class Porta:
        def write(self, b):
            stato['midi'].append(bytes(b))
            return len(b)

    um.ports = (None, Porta())
    mods['usb_midi'] = um

    ti = types.ModuleType('touchio')

    class TouchIn:
        def __init__(self, pin):
            assert pin == 'GP21'

        @property
        def raw_value(self):
            return stato['tocco']

    ti.TouchIn = TouchIn
    mods['touchio'] = ti

    bio = types.ModuleType('busio')

    class I2C:
        def __init__(self, scl, sda, frequency):
            assert (scl, sda) == ('GP5', 'GP4')
            if stato['i2c_assente']:
                raise RuntimeError('No pull up found on SDA or SCL')
            self.reg_ss = None

        def try_lock(self):
            return True

        def writeto_then_readfrom(self, addr, out, buf):
            assert addr == 0x36
            if out[0] == 0x0B:
                buf[0] = 0x20
            elif out[0] == 0x0C:
                a = stato['angolo'] & 0xFFF
                buf[0] = a >> 8
                buf[1] = a & 0xFF

        def writeto(self, addr, data):
            assert addr == 0x30
            self.reg_ss = bytes(data)

        def readfrom_into(self, addr, buf):
            assert addr == 0x30 and self.reg_ss == bytes((0x09, 0x19))
            v = stato['fader']
            buf[0] = v >> 8
            buf[1] = v & 0xFF

    bio.I2C = I2C
    mods['busio'] = bio
    return stato, mods


def esegui(scenario, **extra):
    stato, mods = costruisci(scenario)
    stato.update(extra)
    salvati = {k: sys.modules.get(k) for k in mods}
    sys.modules.update(mods)
    try:
        exec(compile(SRC, 'code.py', 'exec'), {'__name__': '__main__'})
    except Fine:
        pass
    finally:
        for k, v in salvati.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return stato


def decodifica(midi):
    out = []
    for m in midi:
        t = m[0] & 0xF0
        ch = m[0] & 0x0F
        if t == 0x90:
            out.append(('nota', m[1], m[2] > 0))
        elif t == 0xB0:
            out.append(('cc', m[1], m[2]))
        elif t == 0xE0:
            out.append(('pb', ch, m[1] | (m[2] << 7)))
    return out


ok = True


def verifica(cond, testo):
    global ok
    print(('OK   ' if cond else 'ERR  ') + testo)
    ok = ok and cond


# 1) pulsanti, SHIFT, manopola, jog, tocco, fader
def scenario1(ms, s):
    if ms == 1000:
        s['premuti'].add('GP16')            # PLAY giù
    if ms == 1010:
        s['premuti'].discard('GP16')
    if ms == 1100:
        s['premuti'].add('GP19')            # SHIFT giù
    if ms == 1110:
        s['premuti'].add('GP10')            # LOOP IN con SHIFT → ½
    if ms == 1120:
        s['premuti'].discard('GP19')        # SHIFT su prima di LOOP IN
    if ms == 1130:
        s['premuti'].discard('GP10')        # rilascio: deve chiudere la stessa nota (½)
    if ms == 1200:
        s['manopola'] = 2                   # due scatti avanti
    if 1300 <= ms < 1400:
        s['angolo'] = 1000 + (ms - 1300) * 3   # jog in avanti
    if 1400 <= ms < 1450:
        s['angolo'] = 1297 + (1 if ms % 2 else 0)  # tremolio da fermo
    if ms == 1500:
        s['tocco'] = 2800                   # dito sulla jog (+40%)
    if ms == 1600:
        s['tocco'] = 2010                   # dito tolto
    if ms == 1700:
        s['fader'] = 1015                   # fader in fondo
    if ms == 2000:
        s['fader'] = 512                    # al centro


st = esegui(scenario1)
ev = decodifica(st['midi'])
note = [e for e in ev if e[0] == 'nota']
verifica(('nota', 0x01, True) in note and ('nota', 0x01, False) in note, 'PLAY invia nota 1 giù e su')
verifica(('nota', 0x24, True) in note and ('nota', 0x24, False) in note and ('nota', 0x20, True) not in note,
         'SHIFT + LOOP IN invia loop ½ e lo chiude anche se SHIFT è già alzato')
verifica(('nota', 0x0A, True) in note and ('nota', 0x0A, False) in note, 'SHIFT arriva anche all\'app')
cc = [e for e in ev if e[0] == 'cc']
verifica(cc == [('cc', 0x40, 1), ('cc', 0x40, 1)], 'due scatti della manopola = due CC 64 valore 1')
jog = [e[2] for e in ev if e[0] == 'pb' and e[1] == 15]
verifica(len(jog) > 50 and jog[0] == 1000 * 4, 'la jog manda l\'angolo (×4) sul canale 16')
diffs = [((b - a + 8192) % 16384) - 8192 for a, b in zip(jog, jog[1:])]
verifica(all(d > 0 for d in diffs), 'nessun passo indietro: il tremolio da fermo viene ignorato')
verifica(('nota', 0x40, True) in note and ('nota', 0x40, False) in note, 'tocco della jog: nota 64 giù e su')
fad = [e[2] for e in ev if e[0] == 'pb' and e[1] == 14]
verifica(16383 in fad and abs(fad[-1] - 8191) < 40, 'fader: arriva a 16383 e torna al centro')

# 2) senza jog e fader collegati i pulsanti funzionano lo stesso
def scenario2(ms, s):
    if ms == 500:
        s['premuti'].add('GP17')
    if ms == 520:
        s['premuti'].discard('GP17')


st = esegui(scenario2, i2c_assente=True)
note = [e for e in decodifica(st['midi']) if e[0] == 'nota']
verifica(note == [('nota', 0x02, True), ('nota', 0x02, False)], 'senza bus I2C: CUE funziona comunque')

# 3) accensione con SHIFT + JUMP ◀: jog invertita e memorizzata
def scenario3(ms, s):
    if ms == 200:
        s['pins_bassi'].clear()
    if 2200 <= ms < 2300:
        s['angolo'] = 1000 + (ms - 2200) * 3


st = esegui(scenario3, pins_bassi={'GP19', 'GP14'})
jog = [e[2] for e in decodifica(st['midi']) if e[0] == 'pb' and e[1] == 15]
diffs = [((b - a + 8192) % 16384) - 8192 for a, b in zip(jog, jog[1:])]
verifica(st['nvm'][0] == 0x5C and st['nvm'][1] & 1 == 1, 'opzione "jog invertita" salvata in memoria')
verifica(len(diffs) > 20 and all(d < 0 for d in diffs), 'con la jog invertita il verso si capovolge')

print('\nTUTTO OK' if ok else '\nCI SONO ERRORI')
sys.exit(0 if ok else 1)
