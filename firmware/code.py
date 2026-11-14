# SOLCO — firmware dei comandi fisici
# CircuitPython 9 o 10 su Raspberry Pi Pico H (RP2040; NON Pico 2: il tocco della jog
# non funziona sull'RP2350). Nessuna libreria esterna da copiare: basta questo file e boot.py.
#
# Collegamenti (morsetti a vite della Terminal PiCowbell, numero = pin del Pico):
#   GP0..GP3, GP6..GP9  hot cue A..H          GP10 LOOP IN     GP11 LOOP OUT
#   GP12 RELOOP         GP13 AUTO LOOP        GP14 JUMP ◀      GP15 JUMP ▶
#   GP16 PLAY           GP17 CUE              GP18 KEY LOCK    GP19 SHIFT     GP20 BACK
#   GP21 tocco jog (+ resistenza da 1 MΩ verso GND)            GP22 pulsante manopola (SW)
#   GP27 manopola CLK   GP28 manopola DT      3V3 → "+" della manopola
#   STEMMA QT: jog magnetica AS5600 (0x36) e fader NeoSlider (0x30)
#   L'altro filo di ogni pulsante va a GND (tramite i connettori WAGO).
#
# Messaggi MIDI (gli stessi che l'app SOLCO si aspetta):
#   note sul canale 1 per i pulsanti, pitch bend canale 16 = angolo jog,
#   pitch bend canale 15 = fader tempo, CC 64 canale 1 = manopola.
#
# Accensione con SHIFT + JUMP ◀ premuti: inverte il verso della jog (resta memorizzato).

import time
import board
import busio
import digitalio
import keypad
import microcontroller
import rotaryio
import usb_midi

try:
    import touchio
except ImportError:
    touchio = None

# ------------------------------------------------------------------ impostazioni
TOCCO_ON = 0.25        # dito sulla jog: lettura oltre il riposo del 25%
TOCCO_OFF = 0.12       # dito tolto: lettura sotto il riposo + 12%
TOCCO_OGNI_MS = 4
JOG_ISTERESI = 2       # scatti (su 4096 per giro) per cambiare verso: elimina il tremolio da fermo
FADER_OGNI_MS = 20
FADER_SOGLIA = 8       # passi su 16383 prima di inviare un nuovo valore
FADER_ZONA_ZERO = 0.006  # come nell'app: vicino al centro il tempo è 0%

# ------------------------------------------------------------------ pulsanti
# (piedino, nota, nota con SHIFT premuto)
SHIFT_NOTE = 0x0A
PULSANTI = (
    (board.GP0, 0x10, 0x10),   # HOT A  (con SHIFT l'app cancella il cue)
    (board.GP1, 0x11, 0x11),   # HOT B
    (board.GP2, 0x12, 0x12),   # HOT C
    (board.GP3, 0x13, 0x13),   # HOT D
    (board.GP6, 0x14, 0x14),   # HOT E
    (board.GP7, 0x15, 0x15),   # HOT F
    (board.GP8, 0x16, 0x16),   # HOT G
    (board.GP9, 0x17, 0x17),   # HOT H
    (board.GP10, 0x20, 0x24),  # LOOP IN    / loop ½
    (board.GP11, 0x21, 0x25),  # LOOP OUT   / loop ×2
    (board.GP12, 0x22, 0x07),  # RELOOP     / slip
    (board.GP13, 0x23, 0x08),  # AUTO LOOP  / quantize
    (board.GP14, 0x26, 0x28),  # JUMP ◀     / cue memoria ◀
    (board.GP15, 0x27, 0x29),  # JUMP ▶     / cue memoria ▶
    (board.GP16, 0x01, 0x06),  # PLAY       / reverse
    (board.GP17, 0x02, 0x2A),  # CUE        / memorizza cue
    (board.GP18, 0x03, 0x04),  # KEY LOCK   / range tempo
    (board.GP19, SHIFT_NOTE, SHIFT_NOTE),  # SHIFT
    (board.GP20, 0x34, 0x09),  # BACK       / vinile ↔ CDJ
    (board.GP22, 0x33, 0x05),  # premi manopola: carica / tempo a zero
)
I_SHIFT = 17
I_JUMP_INDIETRO = 12
NOTA_TOCCO = 0x40
CC_MANOPOLA = 0x40
NOTA_BRANO_PREC = 0x30
NOTA_BRANO_SUCC = 0x31

# ------------------------------------------------------------------ MIDI
porta = usb_midi.ports[1]
msg = bytearray(3)


def invia(a, b, c):
    msg[0] = a
    msg[1] = b
    msg[2] = c
    try:
        porta.write(msg)
    except Exception:
        pass


def nota(n, giu):
    invia(0x90, n, 127 if giu else 0)


def pitch_bend(canale, v):
    invia(0xE0 | canale, v & 0x7F, (v >> 7) & 0x7F)


# ------------------------------------------------------------------ led e memoria
led = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT


def lampeggia(volte, durata=0.12):
    for _ in range(volte):
        led.value = True
        time.sleep(durata)
        led.value = False
        time.sleep(durata)


nvm = microcontroller.nvm
if nvm[0] != 0x5C:
    nvm[0:2] = bytes((0x5C, 0))
opzioni = nvm[1]

# accensione con SHIFT + JUMP ◀: inverte la jog
p1 = digitalio.DigitalInOut(PULSANTI[I_SHIFT][0])
p2 = digitalio.DigitalInOut(PULSANTI[I_JUMP_INDIETRO][0])
p1.switch_to_input(pull=digitalio.Pull.UP)
p2.switch_to_input(pull=digitalio.Pull.UP)
time.sleep(0.05)
if not p1.value and not p2.value:
    opzioni ^= 1
    nvm[1] = opzioni
    lampeggia(3)
    while not p1.value or not p2.value:
        time.sleep(0.02)
p1.deinit()
p2.deinit()
JOG_INVERTITA = bool(opzioni & 1)

# ------------------------------------------------------------------ ingressi
try:
    tasti = keypad.Keys([p[0] for p in PULSANTI], value_when_pressed=False, pull=True,
                        interval=0.002, debounce_threshold=3)
except TypeError:  # CircuitPython più vecchio, senza debounce_threshold
    tasti = keypad.Keys([p[0] for p in PULSANTI], value_when_pressed=False, pull=True,
                        interval=0.005)
evento = keypad.Event()

manopola = rotaryio.IncrementalEncoder(board.GP27, board.GP28, divisor=4)
manopola_ultima = manopola.position

tocco = None
if touchio is not None:
    try:
        tocco = touchio.TouchIn(board.GP21)
    except Exception as e:  # manca la resistenza da 1 MΩ
        print("Tocco jog disattivato:", e)

i2c = None


def i2c_avvia():
    # Senza jog e fader collegati il bus non ha resistenze di pull-up e la creazione fallisce:
    # in quel caso i pulsanti funzionano lo stesso e si riprova ogni 2 secondi.
    global i2c
    try:
        bus = busio.I2C(board.GP5, board.GP4, frequency=400000)
        while not bus.try_lock():
            pass
        i2c = bus
    except Exception as e:
        print("Bus I2C non disponibile:", e)
        i2c = None


i2c_avvia()

# ------------------------------------------------------------------ jog magnetica (AS5600)
AS5600 = 0x36
REG_STATO = bytes((0x0B,))
REG_ANGOLO = bytes((0x0C,))
b1 = bytearray(1)
b2 = bytearray(2)
jog_ok = False
jog_magnete = 0      # 0 assente, 1 ok, 2 debole, 3 forte
jog_inviato = -1
jog_verso = 0


def jog_stato():
    global jog_ok, jog_magnete
    if i2c is None:
        jog_ok = False
        return
    try:
        i2c.writeto_then_readfrom(AS5600, REG_STATO, b1)
        s = b1[0]
        jog_ok = True
        if not s & 0x20:
            jog_magnete = 0
        elif s & 0x10:
            jog_magnete = 2
        elif s & 0x08:
            jog_magnete = 3
        else:
            jog_magnete = 1
    except Exception:
        jog_ok = False
        jog_magnete = 0


def jog_angolo():
    i2c.writeto_then_readfrom(AS5600, REG_ANGOLO, b2)
    a = ((b2[0] & 0x0F) << 8) | b2[1]
    return (4096 - a) & 0xFFF if JOG_INVERTITA else a


# ------------------------------------------------------------------ fader (NeoSlider, protocollo seesaw)
NEOSLIDER = 0x30
RICHIESTA_FADER = bytes((0x09, 0x07 + 18))   # ADC, piedino 18
fader_ok = False
fader_fase = 0
fader_t = 0
fader_filtro = -1.0
fader_inviato = -100
fader_luce = None


def seesaw_scrivi(dati):
    i2c.writeto(NEOSLIDER, bytes(dati))


def fader_avvia():
    global fader_ok
    if i2c is None:
        fader_ok = False
        return
    try:
        seesaw_scrivi((0x00, 0x7F, 0xFF))          # reset
        time.sleep(0.5)
        seesaw_scrivi((0x0E, 0x01, 14))            # led sul piedino 14
        seesaw_scrivi((0x0E, 0x03, 0x00, 12))      # 4 led × 3 byte
        fader_ok = True
    except Exception:
        fader_ok = False


def fader_luci(g, r, b):
    global fader_luce
    colore = (g, r, b)
    if colore == fader_luce:
        return
    fader_luce = colore
    try:
        seesaw_scrivi((0x0E, 0x04, 0x00, 0x00) + colore * 4)
        seesaw_scrivi((0x0E, 0x05))
    except Exception:
        pass


# ------------------------------------------------------------------ avvio
jog_stato()
fader_avvia()

tocco_riposo = 0.0
if tocco is not None:
    somma = 0
    for _ in range(40):
        somma += tocco.raw_value
        time.sleep(0.01)
    tocco_riposo = somma / 40
toccato = False
conta_on = 0
conta_off = 0

shift = False
nota_tenuta = [None] * len(PULSANTI)

ora_ms = time.monotonic_ns() // 1000000
prossimo_tocco = ora_ms
prossimo_fader = ora_ms
prossimo_stato = ora_ms
prossimo_led = ora_ms
led_acceso = False
ultimo_errore = 0

print("SOLCO pronto. jog:", jog_ok, "magnete:", jog_magnete, "fader:", fader_ok,
      "tocco:", tocco is not None)

# ------------------------------------------------------------------ ciclo principale
while True:
    ora_ms = time.monotonic_ns() // 1000000

    # pulsanti
    while tasti.events.get_into(evento):
        i = evento.key_number
        if i == I_SHIFT:
            shift = evento.pressed
            nota(SHIFT_NOTE, shift)
            continue
        if evento.pressed:
            n = PULSANTI[i][2] if shift else PULSANTI[i][1]
            nota_tenuta[i] = n
            nota(n, True)
        else:
            n = nota_tenuta[i]
            if n is not None:
                nota(n, False)
                nota_tenuta[i] = None

    # manopola
    pos = manopola.position
    if pos != manopola_ultima:
        passi = pos - manopola_ultima
        manopola_ultima = pos
        verso = 1 if passi > 0 else -1
        for _ in range(min(abs(passi), 8)):
            if shift:
                n = NOTA_BRANO_SUCC if verso > 0 else NOTA_BRANO_PREC
                nota(n, True)
                nota(n, False)
            else:
                invia(0xB0, CC_MANOPOLA, 1 if verso > 0 else 127)

    # jog
    if jog_ok:
        try:
            a = jog_angolo()
            if jog_inviato < 0:
                jog_inviato = a
                pitch_bend(15, a * 4)
            else:
                d = (a - jog_inviato) & 0xFFF
                if d >= 2048:
                    d -= 4096
                if d and (d * jog_verso > 0 or abs(d) >= JOG_ISTERESI):
                    jog_verso = 1 if d > 0 else -1
                    jog_inviato = a
                    pitch_bend(15, a * 4)
        except Exception:
            jog_ok = False
            ultimo_errore = ora_ms

    # tocco sulla jog
    if tocco is not None and ora_ms >= prossimo_tocco:
        prossimo_tocco = ora_ms + TOCCO_OGNI_MS
        v = tocco.raw_value
        if not toccato:
            if v > tocco_riposo * (1 + TOCCO_ON):
                conta_on += 1
                if conta_on >= 2:
                    toccato = True
                    conta_off = 0
                    nota(NOTA_TOCCO, True)
            else:
                conta_on = 0
                tocco_riposo += (v - tocco_riposo) * (0.002 if v > tocco_riposo else 0.05)
        else:
            if v < tocco_riposo * (1 + TOCCO_OFF):
                conta_off += 1
                if conta_off >= 3:
                    toccato = False
                    conta_on = 0
                    nota(NOTA_TOCCO, False)
            else:
                conta_off = 0

    # fader: richiesta, poi lettura 3 ms dopo (il seesaw ha bisogno di un attimo)
    if fader_ok:
        try:
            if fader_fase == 0 and ora_ms >= prossimo_fader:
                i2c.writeto(NEOSLIDER, RICHIESTA_FADER)
                fader_fase = 1
                fader_t = ora_ms
            elif fader_fase == 1 and ora_ms - fader_t >= 3:
                i2c.readfrom_into(NEOSLIDER, b2)
                fader_fase = 0
                prossimo_fader = ora_ms + FADER_OGNI_MS
                grezzo = (b2[0] << 8) | b2[1]
                if grezzo <= 1023:
                    fader_filtro = grezzo if fader_filtro < 0 else fader_filtro + (grezzo - fader_filtro) * 0.35
                    x = (fader_filtro - 16) / 991   # piccola zona morta ai due estremi
                    x = 0.0 if x < 0 else (1.0 if x > 1 else x)
                    v14 = int(x * 16383 + 0.5)
                    if abs(v14 - fader_inviato) >= FADER_SOGLIA or (v14 in (0, 16383) and v14 != fader_inviato):
                        fader_inviato = v14
                        pitch_bend(14, v14)
                    if abs(x * 2 - 1) < FADER_ZONA_ZERO:
                        fader_luci(40, 0, 0)       # verde: tempo a 0%
                    else:
                        fader_luci(0, 0, 6)        # blu tenue
        except Exception:
            fader_ok = False
            fader_fase = 0
            ultimo_errore = ora_ms

    # ogni 2 secondi: stato del magnete e nuovi tentativi se qualcosa si è scollegato
    if ora_ms >= prossimo_stato:
        prossimo_stato = ora_ms + 2000
        if i2c is None:
            i2c_avvia()
        jog_stato()
        if not fader_ok:
            fader_avvia()
            fader_luce = None

    # led del Pico: fisso = tutto ok, lento = magnete da sistemare, veloce = jog non trovata
    if ora_ms >= prossimo_led:
        if not jog_ok:
            periodo = 125
        elif jog_magnete != 1:
            periodo = 500
        else:
            periodo = 0
        if periodo:
            led_acceso = not led_acceso
            prossimo_led = ora_ms + periodo
        else:
            led_acceso = True
            prossimo_led = ora_ms + 250
        led.value = led_acceso
