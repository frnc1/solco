"""
SOLCO — misure e costruzione dei pezzi da stampare (una "unità": scocca con jog e comandi + supporto tablet).

Sistema di riferimento della scocca: X da sinistra a destra (0..240), Y dal bordo verso il DJ (0)
al bordo verso il tablet (220), Z = 0 sulla superficie superiore del pannello, verso l'alto positivo.
"""
import math

import numpy as np

from solco_cad import (Part, Piece, circle, nest_contours, poly, rect, ring, rrect, slot,
                       text_contours, toothed_circle)

# ------------------------------------------------------------------ misure generali
W, D = 240.0, 220.0         # ingombro della scocca
R_ANGOLO = 10.0
T_PANNELLO = 3.0
H_SCOCCA = 42.0             # dal piano superiore al bordo inferiore delle pareti
T_PARETE = 2.4
INCISO = 0.6                # profondità delle scritte
FONT = '/usr/share/fonts/opentype/inter/Inter-Black.otf'
H_TESTO = 3.0               # altezza maiuscole scritte principali
H_TESTO_SHIFT = 2.6

# jog
C = (122.0, 94.0)           # centro della jog
R_JOG = 70.0                # raggio del piatto
JOG_SOTTO = 1.5             # distanza tra piatto e pannello
JOG_SPESSORE = 10.0
R_SEDE_CUSC = 21.1          # foro per i cuscinetti 6806 (Ø42 → Ø42,2)
R_LABBRO = 19.6             # appoggio dell'anello esterno del cuscinetto inferiore (Ø39,2: sbalzo di stampa di soli 1,5 mm)
R_MOZZO = 30.0              # esterno del supporto cuscinetti
Z_LABBRO = -14.0            # fondo dei due cuscinetti (2 × 7 mm)
Z_MOZZO = -16.0
R_ALBERO = 14.925           # albero Ø29,85 nei cuscinetti
R_DISTANZIALE = 16.5        # tocca solo l'anello interno (Ø33)
R_VITI_ALBERO = 11.5
R_PILOTA = 1.35             # foro per vite M3 autofilettante (Ø2,7)
R_PASSANTE = 1.7            # foro passante M3 (Ø3,4)
Y_VITI_SENSORE = 25.5       # viti del supporto sensore sotto il mozzo (±Y)

# rame per il tocco
R_RAME_INT, R_RAME_EST = 29.0, 67.0      # anello fisso sul pannello
FILO_TOCCO = (C[0] + 48.0, C[1])

# pulsanti: (nome, x, y, diametro foro, scritta sotto, scritta sopra = funzione con SHIFT)
HOT_Y = 196.0
PULSANTI = [(f'HOT {L}', 28.0 + 23.0 * i, HOT_Y, 12.2, L, None) for i, L in enumerate('ABCDEFGH')] + [
    ('LOOP IN', 17.0, 166.0, 12.2, 'LOOP IN', '½'),
    ('LOOP OUT', 39.0, 166.0, 12.2, 'LOOP OUT', '×2'),
    ('RELOOP', 61.0, 166.0, 12.2, 'RELOOP', 'SLIP'),
    ('AUTO', 17.0, 138.0, 12.2, 'AUTO 4', 'QUANT'),
    ('SHIFT', 39.0, 138.0, 12.2, 'SHIFT', None),
    ('JUMP-', 17.0, 110.0, 12.2, '◀ JUMP', '◀ MEM'),
    ('JUMP+', 39.0, 110.0, 12.2, 'JUMP ▶', 'MEM ▶'),
    ('CUE', 24.0, 66.0, 12.2, None, None),
    ('PLAY', 24.0, 30.0, 12.2, None, None),
    ('BACK', 218.0, 166.0, 12.2, 'BACK', 'VINYL'),
    ('KEY LOCK', 218.0, 138.0, 12.2, 'KEY LOCK', 'RANGE'),
]
R_TESTA = 7.0               # raggio della testa del pulsante da 12 mm
MANOPOLA = (218.0, 196.0)
R_FORO_MANOPOLA = 3.6       # boccola M7 dell'encoder KY-040
R_MANOPOLA = 11.0
COLLARI = {'PLAY': 15.0, 'CUE': 15.0}   # anelli decorativi grandi attorno a PLAY e CUE

# fader (NeoSlider 75 mm, corsa ~60 mm)
FADER_X = 218.0
FADER_Y0, FADER_Y1 = 36.0, 98.0
FADER_LARGH = 3.2
FADER_INCAVO = (211.0, 26.0, 225.0, 108.0)      # pannello assottigliato a 2 mm da sotto
FADER_BORCHIE = [(FADER_X, 21.0), (FADER_X, 113.0)]

# viti tra scocca e fondo
COLONNE = [(9.5, 9.5), (230.5, 9.5), (9.5, 210.5), (230.5, 210.5), (120.0, 8.0), (108.5, 212.0)]
# uscita del cavo USB (tacca sul bordo inferiore della parete posteriore)
TACCA_USB = (140.0, 154.0, 8.0)          # x0, x1, altezza
# fori per le viti verso il supporto tablet (asole verticali nella parete posteriore)
FORI_SUPPORTO_X = (60.0, 180.0)
FORI_SUPPORTO_Z = (-23.0, -17.0)

# scheda elettronica (Pico H + Terminal PiCowbell 52,1 × 43,1 mm) sul fondo
SCHEDA = (122.0, 152.0, 52.1, 43.1)


# ================================================================== scritte incise

class Etichetta:
    def __init__(self, testo, cx, cy, h=H_TESTO, ancora='c', specchio=False):
        cont, w, hh = text_contours(testo, h, FONT)
        if ancora == 'c':
            x0, y0 = cx - w / 2, cy - hh / 2
        elif ancora == 'l':
            x0, y0 = cx, cy - hh / 2
        else:
            x0, y0 = cx - w, cy - hh / 2
        self.contorni = []
        for c in cont:
            p = c + [x0, y0]
            if specchio:
                p = p.copy()
                p[:, 0] = 2 * cx - p[:, 0]
            self.contorni.append(p)
        self.box = (x0 - 0.8, y0 - 0.8, x0 + w + 0.8, y0 + hh + 0.8)
        if specchio:
            self.box = (2 * cx - self.box[2], self.box[1], 2 * cx - self.box[0], self.box[3])

    def pezzi(self):
        """Il riquadro dell'etichetta senza i caratteri (che restano vuoti = incisi)."""
        depth, parent = nest_contours(self.contorni)
        fori = [c for c, d in zip(self.contorni, depth) if d % 2 == 0]
        out = [Piece(rect(*self.box), fori)]
        for i, (c, d) in enumerate(zip(self.contorni, depth)):
            if d % 2 == 1:   # interno di "O", "A", ...: torna pieno
                figli = [self.contorni[j] for j in range(len(self.contorni)) if parent[j] == i]
                out.append(Piece(c, figli))
        return out


class Riquadro:
    """Riquadro con solchi rettangolari (tacche di riferimento)."""

    def __init__(self, box, solchi):
        self.box = box
        self.solchi = solchi

    def pezzi(self):
        return [Piece(rect(*self.box), [rect(*s) for s in self.solchi])]


def etichette_pannello():
    et = []
    for nome, x, y, d, sotto, sopra in PULSANTI:
        if sotto:
            et.append(Etichetta(sotto, x, y - R_TESTA - 3.6, H_TESTO))
        if sopra:
            et.append(Etichetta(sopra, x, y + R_TESTA + 3.4, H_TESTO_SHIFT))
    # PLAY e CUE: la scritta è sul collare; la funzione con SHIFT va a destra
    et.append(Etichetta('REV', 24.0 + 17.5, 30.0, H_TESTO_SHIFT, ancora='l'))
    et.append(Etichetta('MEM', 24.0 + 17.5, 66.0, H_TESTO_SHIFT, ancora='l'))
    # manopola
    mx, my = MANOPOLA
    et.append(Etichetta('BROWSE', mx, my - R_MANOPOLA - 3.4, H_TESTO))
    et.append(Etichetta('TRACK ±', mx, my + R_MANOPOLA + 3.2, H_TESTO_SHIFT))
    # fila hot cue
    et.append(Etichetta('HOT CUE', 17.0, 211.0, H_TESTO_SHIFT, ancora='l'))
    et.append(Etichetta('SHIFT + HOT CUE = DELETE', 52.0, 211.0, H_TESTO_SHIFT, ancora='l'))
    # fader
    et.append(Etichetta('TEMPO', FADER_X, FADER_Y1 + 10.5, H_TESTO))
    et.append(Etichetta('−', FADER_X - 8.5, FADER_Y1 - 2.0, H_TESTO))
    et.append(Etichetta('+', FADER_X - 8.5, FADER_Y0 + 2.0, H_TESTO))
    ym = (FADER_Y0 + FADER_Y1) / 2
    et.append(Riquadro((FADER_X + 2.6, ym - 2.0, FADER_X + 8.6, ym + 2.0),
                       [(FADER_X + 3.4, ym - 0.35, FADER_X + 7.8, ym + 0.35)]))
    et.append(Riquadro((FADER_X - 8.6, ym - 2.0, FADER_X - 2.6, ym + 2.0),
                       [(FADER_X - 7.8, ym - 0.35, FADER_X - 3.4, ym + 0.35)]))
    et.append(Etichetta('SOLCO', 236.0, 8.0, H_TESTO, ancora='r'))
    return et


def _box_sovrapposti(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def controlla_etichette(et, ostacoli_cerchi):
    """Le etichette non devono toccarsi tra loro, coi fori, né stare sotto la jog."""
    problemi = []
    for i in range(len(et)):
        for j in range(i + 1, len(et)):
            if _box_sovrapposti(et[i].box, et[j].box):
                problemi.append(('etichette', i, j))
    for i, e in enumerate(et):
        x0, y0, x1, y1 = e.box
        for (cx, cy, r) in ostacoli_cerchi:
            nx = min(max(cx, x0), x1)
            ny = min(max(cy, y0), y1)
            if math.hypot(nx - cx, ny - cy) < r:
                problemi.append(('foro', i, (cx, cy, r)))
        if x0 < 3 or y0 < 3 or x1 > W - 3 or y1 > D - 3:
            problemi.append(('bordo', i))
    return problemi


# ================================================================== scocca (pannello + pareti)

def fori_pannello():
    fori = []
    for nome, x, y, d, _, _ in PULSANTI:
        fori.append(circle(x, y, d / 2, 48))
    fori.append(circle(MANOPOLA[0], MANOPOLA[1], R_FORO_MANOPOLA, 32))
    fori.append(slot(FADER_X, FADER_Y0, FADER_X, FADER_Y1, FADER_LARGH))
    return fori


def scocca():
    p = Part('scocca')
    contorno = rrect(0, 0, W, D, R_ANGOLO, 12)
    fori = fori_pannello()
    cx, cy = C
    et = etichette_pannello()
    ost = [(x, y, d / 2 + 0.6) for _, x, y, d, _, _ in PULSANTI]
    ost += [(cx, cy, R_RAME_EST + 1.0), (MANOPOLA[0], MANOPOLA[1], R_FORO_MANOPOLA + 0.6)]
    ost += [(x, y, COLLARI[n] + 0.5) for n, x, y, _, _, _ in PULSANTI if n in COLLARI]
    ost += [(FADER_X, y, FADER_LARGH / 2 + 0.6) for y in np.linspace(FADER_Y0, FADER_Y1, 30)]
    prob = controlla_etichette(et, ost)
    if prob:
        raise SystemExit('Etichette in conflitto: %r' % prob[:12])

    # pannello: strato inferiore con incavo del fader, strato intermedio, strato superiore inciso
    foro_cusc = circle(cx, cy, R_SEDE_CUSC, 120)
    foro_filo = circle(FILO_TOCCO[0], FILO_TOCCO[1], 0.8, 16)
    fori_sotto = fori[:-1]          # l'asola del fader è dentro l'incavo
    p.add(Piece(contorno, fori_sotto + [foro_cusc, foro_filo, rect(*FADER_INCAVO)]), 'z', -T_PANNELLO, -1.95)
    p.add(Piece(contorno, fori + [foro_cusc, foro_filo]), 'z', -2.0, -INCISO + 0.05)
    zona_jog = circle(cx, cy, R_RAME_EST + 0.3, 160)
    p.add(Piece(contorno, fori + [zona_jog] + [rect(*e.box) for e in et]), 'z', -INCISO, 0)
    p.add(Piece(circle(cx, cy, R_RAME_EST - 0.3, 160), [circle(cx, cy, R_RAME_INT + 0.3, 80), foro_filo]),
          'z', -INCISO, 0)
    p.add(Piece(circle(cx, cy, R_RAME_INT - 0.3, 80), [foro_cusc]), 'z', -INCISO, 0)
    for e in et:
        for pz in e.pezzi():
            p.add(pz, 'z', -INCISO - 0.05, 0)      # leggera sovrapposizione col pannello

    # pareti: 4 lati dritti + 4 angoli, con tacca USB e asole per il supporto
    zb = -H_SCOCCA
    zt = -T_PANNELLO + 0.5
    t = T_PARETE
    r = R_ANGOLO
    p.add(rect(r - 0.5, 0, W - r + 0.5, t), 'z', zb, zt)                       # davanti
    p.add(rect(0, r - 0.5, t, D - r + 0.5), 'z', zb, zt)                       # sinistra
    p.add(rect(W - t, r - 0.5, W, D - r + 0.5), 'z', zb, zt)                   # destra
    # dietro, a tratti: tacca USB in basso e due asole verticali
    xs = sorted([r - 0.5, W - r + 0.5, TACCA_USB[0], TACCA_USB[1]] +
                [x + s for x in FORI_SUPPORTO_X for s in (-R_PASSANTE, R_PASSANTE)])
    for a, b in zip(xs[:-1], xs[1:]):
        xm = (a + b) / 2
        dietro = rect(a, D - t, b, D)
        if TACCA_USB[0] <= xm <= TACCA_USB[1]:
            p.add(dietro, 'z', zb + TACCA_USB[2], zt)
        elif any(abs(xm - x) < R_PASSANTE for x in FORI_SUPPORTO_X):
            p.add(dietro, 'z', zb, FORI_SUPPORTO_Z[0])
            p.add(dietro, 'z', FORI_SUPPORTO_Z[1], zt)
        else:
            p.add(dietro, 'z', zb, zt)
    for (ax, ay) in ((r, r), (W - r, r), (W - r, D - r), (r, D - r)):
        ang = math.degrees(math.atan2(ay - D / 2, ax - W / 2))
        base = {(r, r): 180, (W - r, r): 270, (W - r, D - r): 0, (r, D - r): 90}[(ax, ay)]
        a0, a1 = math.radians(base - 3), math.radians(base + 93)
        tt = np.linspace(a0, a1, 16)
        est = np.column_stack([ax + r * np.cos(tt), ay + r * np.sin(tt)])
        inn = np.column_stack([ax + (r - t) * np.cos(tt[::-1]), ay + (r - t) * np.sin(tt[::-1])])
        p.add(np.vstack([est, inn]), 'z', zb, zt)

    # colonne per le viti del fondo (foro pilota in basso)
    for (x, y) in COLONNE:
        p.add(Piece(circle(x, y, 4.5, 32), [circle(x, y, R_PILOTA, 16)]), 'z', zb, zb + 12)
        p.add(circle(x, y, 4.5, 32), 'z', zb + 12, zt)

    # mozzo dei cuscinetti, con fori pilota per il supporto del sensore
    pil = [circle(cx, cy + s * Y_VITI_SENSORE, R_PILOTA, 16) for s in (-1, 1)]
    p.add(Piece(circle(cx, cy, R_MOZZO, 120), [circle(cx, cy, R_LABBRO, 96)] + pil), 'z', Z_MOZZO, Z_LABBRO)
    p.add(Piece(circle(cx, cy, R_MOZZO, 120), [circle(cx, cy, R_SEDE_CUSC, 120)] + pil), 'z', Z_LABBRO, Z_MOZZO + 10)
    p.add(ring(cx, cy, R_MOZZO, R_SEDE_CUSC, 120), 'z', Z_MOZZO + 10, -T_PANNELLO + 0.5)

    # nervature di rinforzo sotto il pannello
    zr0, zr1 = -11.0, -T_PANNELLO + 0.5
    p.add(rect(cx + R_MOZZO - 1, cy - 1.5, 200.0, cy + 1.5), 'z', zr0, zr1)
    p.add(rect(50.0, cy - 1.5, cx - R_MOZZO + 1, cy + 1.5), 'z', zr0, zr1)
    p.add(rect(cx - 1.5, T_PARETE - 0.5, cx + 1.5, cy - R_MOZZO + 1), 'z', zr0, zr1)
    p.add(rect(cx - 1.5, cy + R_MOZZO - 1, cx + 1.5, 185.0), 'z', zr0, zr1)

    # borchie per la piastrina che tiene il fader
    for (x, y) in FADER_BORCHIE:
        p.add(Piece(circle(x, y, 4.0, 32), [circle(x, y, R_PILOTA, 16)]), 'z', -9.0, -T_PANNELLO + 0.5)
    return p


# ================================================================== fondo

def fondo():
    p = Part('fondo')
    z0, z1 = -H_SCOCCA - 3.0, -H_SCOCCA
    contorno = rrect(0, 0, W, D, R_ANGOLO, 12)
    fori = [circle(x, y, R_PASSANTE, 20) for (x, y) in COLONNE]
    sx, sy, sw, sh = SCHEDA
    fascette = [slot(sx + s * (sw / 2 + 5), sy - 6, sx + s * (sw / 2 + 5), sy + 6, 3.6) for s in (-1, 1)]
    piedini = [(22, 22), (W - 22, 22), (W - 22, D - 22), (22, D - 22)]
    # piastra; lo strato a contatto col piano ha i cerchi per i piedini e la scritta (a specchio)
    scritta = Etichetta('SOLCO · SOTTO', W / 2, D / 2, 6.0, specchio=True)
    p.add(Piece(contorno, fori + fascette), 'z', z0 + INCISO - 0.05, z1)
    cerchi = []
    for (x, y) in piedini:
        cerchi.append(circle(x, y, 6.3, 48))
    p.add(Piece(contorno, fori + fascette + cerchi + [rect(*scritta.box)]), 'z', z0, z0 + INCISO)
    for (x, y) in piedini:
        p.add(Piece(circle(x, y, 5.7, 48)), 'z', z0, z0 + INCISO)
    for pz in scritta.pezzi():
        p.add(pz, 'z', z0, z0 + INCISO + 0.05)
    # fermi angolari per la scheda (la scheda si appoggia in mezzo, una fascetta la tiene)
    gx, gy = sw / 2 + 0.4, sh / 2 + 0.4
    for (ux, uy) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x0, y0 = sx + ux * gx, sy + uy * gy
        # solo lungo i lati corti: sui lati lunghi ci sono gli ingressi dei morsetti
        lx = poly([(x0, y0), (x0 + ux * 2, y0), (x0 + ux * 2, y0 - uy * 9), (x0, y0 - uy * 9)])
        p.add(lx, 'z', z1 - 0.2, z1 + 4.0)
        p.add(rect(min(x0, x0 + ux * 2), min(y0, y0 + uy * 2), max(x0, x0 + ux * 2), max(y0, y0 + uy * 2)),
              'z', z1 - 0.2, z1 + 4.0)
    return p


# ================================================================== jog (piatto), rondella, supporto sensore

def piatto():
    p = Part('piatto')
    z0 = JOG_SOTTO
    z1 = JOG_SOTTO + JOG_SPESSORE
    bordo = toothed_circle(0, 0, R_JOG, 0.7, 100)
    asole = []
    for k in range(3):
        a = math.radians(90 + 120 * k)
        cx, cy = 40 * math.cos(a), 40 * math.sin(a)
        tx, ty = -math.sin(a), math.cos(a)
        asole.append(slot(cx - 5.5 * tx, cy - 5.5 * ty, cx + 5.5 * tx, cy + 5.5 * ty, 2.2, 6))
    # corpo
    p.add(Piece(bordo, asole), 'z', z0 + 0.4, z1 - 0.4)
    # faccia superiore: solco guida per ritagliare il rame (r = 60)
    p.add(Piece(bordo, [circle(0, 0, 60.3, 160)]), 'z', z1 - 0.45, z1)
    p.add(Piece(circle(0, 0, 59.7, 160), asole), 'z', z1 - 0.45, z1)
    # faccia inferiore: solchi guida per l'anello di rame (r = 25 e r = 65)
    p.add(Piece(bordo, [circle(0, 0, 65.3, 160)]), 'z', z0, z0 + 0.45)
    p.add(Piece(circle(0, 0, 64.7, 160), [circle(0, 0, 25.3, 96)] + asole), 'z', z0, z0 + 0.45)
    p.add(circle(0, 0, 24.7, 96), 'z', z0, z0 + 0.45)
    # distanziale (tocca solo l'anello interno del cuscinetto) e albero
    p.add(circle(0, 0, R_DISTANZIALE, 96), 'z', -0.05, z0 + 0.05)
    pil = [circle(R_VITI_ALBERO * math.cos(math.radians(90 + 120 * k)),
                  R_VITI_ALBERO * math.sin(math.radians(90 + 120 * k)), R_PILOTA, 16) for k in range(3)]
    z_fine = Z_LABBRO + 0.3                                  # 0,3 mm più corto: la rondella stringe i cuscinetti
    p.add(circle(0, 0, R_ALBERO, 96), 'z', -1.7, 0.0)
    p.add(Piece(circle(0, 0, R_ALBERO, 96), pil), 'z', z_fine + 1.0, -1.7)
    p.add(Piece(circle(0, 0, R_ALBERO - 0.5, 96), pil), 'z', z_fine, z_fine + 1.0)   # smusso d'invito
    return p


def rondella():
    p = Part('rondella')
    z0, z1 = -19.0, -14.0
    viti = [(R_VITI_ALBERO * math.cos(math.radians(90 + 120 * k)),
             R_VITI_ALBERO * math.sin(math.radians(90 + 120 * k))) for k in range(3)]
    svasi = [circle(x, y, 3.1, 24) for x, y in viti]
    pass_ = [circle(x, y, R_PASSANTE, 16) for x, y in viti]
    est = circle(0, 0, R_DISTANZIALE, 96)
    p.add(Piece(est, svasi + [circle(0, 0, 3.075, 24)]), 'z', z0, z0 + 2.6)          # sede magnete Ø6,15
    p.add(Piece(est, svasi), 'z', z0 + 2.55, z0 + 3.25)
    p.add(Piece(est, pass_), 'z', z0 + 3.15, z1)
    return p


def supporto_sensore():
    p = Part('supporto_sensore')
    zp0, zp1 = -27.2, -24.2
    fori = [circle(0, s * Y_VITI_SENSORE, R_PASSANTE, 20) for s in (-1, 1)]
    p.add(Piece(rect(-30, -30, 30, 30), fori), 'z', zp0, zp1 - 0.35)
    # croce di riferimento incisa: il chip dell'AS5600 va centrato sull'incrocio
    g = 0.35
    for s in (1, -1):
        meta = poly([(-30, s * g), (-g, s * g), (-g, s * 15), (g, s * 15), (g, s * g), (30, s * g),
                     (30, s * 30), (-30, s * 30)])
        p.add(Piece(meta, [fori[0 if s < 0 else 1]]), 'z', zp1 - 0.4, zp1)
    for s in (-1, 1):
        gamba = rect(-8, 18, 8, 30) if s > 0 else rect(-8, -30, 8, -18)
        p.add(Piece(gamba, [fori[1 if s > 0 else 0]]), 'z', zp1 - 0.1, Z_MOZZO)
    return p


def morsetto_fader():
    p = Part('morsetto_fader')
    x, y0, y1 = FADER_X, 17.0, 117.0
    fori = [slot(x, yy - 2.0, x, yy + 2.0, 3.4, 8) for (_, yy) in FADER_BORCHIE]
    finestra = rect(x - 7.0, 31.0, x + 7.0, 103.0)
    p.add(Piece(rrect(x - 12, y0, x + 12, y1, 4), fori + [finestra]), 'z', -14.0, -11.5)
    return p


def manopola():
    p = Part('manopola')
    mx, my = 0.0, 0.0
    z0, z1 = 1.0, 15.0
    est = toothed_circle(mx, my, R_MANOPOLA, 0.6, 40)
    # foro per l'albero Ø6 con 3 nervature schiacciabili
    a = np.linspace(0, 2 * math.pi, 72, endpoint=False)
    rr = np.full_like(a, 3.0)
    for k in range(3):
        d = np.abs(((a - k * 2 * math.pi / 3) + math.pi) % (2 * math.pi) - math.pi)
        rr = np.where(d < 0.18, 2.8, rr)
    albero = np.column_stack([mx + rr * np.cos(a), my + rr * np.sin(a)])
    p.add(Piece(est, [circle(mx, my, 6.2, 48)]), 'z', z0, z0 + 3.0)       # spazio per il dado M7
    p.add(Piece(est, [albero]), 'z', z0 + 3.0, z0 + 11.0)
    p.add(est, 'z', z0 + 11.0, z1 - 0.4)
    indice = rect(mx - 0.45, my + 3.5, mx + 0.45, my + 9.5)
    p.add(Piece(est, [indice]), 'z', z1 - 0.45, z1)
    return p


def collare(nome):
    p = Part('collare_' + nome.lower())
    r = COLLARI[nome]
    r_cima = r - 0.5
    et = Etichetta(nome, 0, -10.4, 2.8)
    x0, y0, x1, y1 = et.box
    assert max(math.hypot(x, y) for x in (x0, x1) for y in (y0, y1)) < r_cima - 0.2, et.box
    foro = circle(0, 0, 6.2, 48)
    p.add(Piece(circle(0, 0, r, 96), [foro]), 'z', 0, 1.9)
    p.add(Piece(circle(0, 0, r_cima, 96), [foro, rect(*et.box)]), 'z', 1.85, 2.5)
    for pz in et.pezzi():
        p.add(pz, 'z', 1.85, 2.5)
    return p


# ================================================================== supporto del tablet

TH = 35.0                  # inclinazione del tablet (gradi dal piano)
L_APPOGGIO = 130.0
T_PIASTRA = 4.0
H_LABBRO = 12.0
T_LABBRO = 4.0
Z_TABLET = 52.0            # altezza del bordo inferiore del tablet sul piano del supporto
LARGH_SUPPORTO = 200.0
T_PARETI_SUPP = 4.0
X_VITI_SUPP = (40.0, 160.0)    # = FORI_SUPPORTO_X - 20 (il supporto è centrato dietro la scocca)
Z_VITI_SUPP = 25.0
# finestrella nella parete frontale, dietro la tacca USB della scocca: il cavo del Pico entra nel supporto
FINESTRA_USB = (TACCA_USB[0] - 20.0 - 2.0, TACCA_USB[1] - 20.0 + 2.0, T_PARETI_SUPP, 18.0)   # x0, x1, z0, z1


def _profilo_supporto():
    th = math.radians(TH)
    d = np.array([math.cos(th), math.sin(th)])
    nf = np.array([-math.sin(th), math.cos(th)])
    off = -(-T_LABBRO * d + H_LABBRO * nf)[0]        # il labbro tocca y = 0 davanti
    B = np.array([off, Z_TABLET])

    def P(s, n):
        return B + s * d + n * nf

    piastra = poly([P(-T_LABBRO, -T_PIASTRA), P(L_APPOGGIO, -T_PIASTRA), P(L_APPOGGIO, 0), P(0, 0),
                    P(0, H_LABBRO), P(-T_LABBRO, H_LABBRO)])
    # retro della piastra: z = zq + tan(th) * (y - yq)
    q = B - T_PIASTRA * nf

    def z_retro(y):
        return q[1] + math.tan(th) * (y - q[0])

    y_retro0, y_retro1 = 113.0, 117.0
    retro = poly([(y_retro0, 0), (y_retro1, 0), (y_retro1, z_retro(y_retro1) + 1.0), (y_retro0, z_retro(y_retro0) + 1.0)])
    z_fronte = P(-T_LABBRO, H_LABBRO)[1]
    pavimento = rect(0, 0, y_retro1, T_PARETI_SUPP)
    return piastra, retro, pavimento, z_fronte


def supporto_tablet():
    p = Part('supporto_tablet')
    piastra, retro, pavimento, z_fronte = _profilo_supporto()
    X0, X1 = 0.0, LARGH_SUPPORTO
    for pz in (piastra, retro, pavimento):
        p.add(pz, 'x', X0, X1)
    # parete frontale e borchie per le viti, con il foro (quadrato 2,6 mm) dove serve
    h = 1.3
    fx0, fx1, fz0, fz1 = FINESTRA_USB
    tagli = sorted([X0, X1, fx0, fx1] + [x + s for x in X_VITI_SUPP for s in (-6.0, -h, h, 6.0)])
    for a, b in zip(tagli[:-1], tagli[1:]):
        xm = (a + b) / 2
        vicino = [x for x in X_VITI_SUPP if abs(xm - x) < 6.0]
        nel_foro = [x for x in X_VITI_SUPP if abs(xm - x) < h]
        if fx0 <= xm <= fx1:
            p.add(rect(0, 0, T_PARETI_SUPP, fz0), 'x', a, b)
            p.add(rect(0, fz1, T_PARETI_SUPP, z_fronte), 'x', a, b)
        elif nel_foro:
            p.add(rect(0, 0, T_PARETI_SUPP, Z_VITI_SUPP - h), 'x', a, b)
            p.add(rect(0, Z_VITI_SUPP + h, T_PARETI_SUPP, z_fronte), 'x', a, b)
            p.add(rect(T_PARETI_SUPP - 0.2, Z_VITI_SUPP - 6, 14, Z_VITI_SUPP - h), 'x', a, b)
            p.add(rect(T_PARETI_SUPP - 0.2, Z_VITI_SUPP + h, 14, Z_VITI_SUPP + 6), 'x', a, b)
        else:
            p.add(rect(0, 0, T_PARETI_SUPP, z_fronte), 'x', a, b)
            if vicino:
                p.add(rect(T_PARETI_SUPP - 0.2, Z_VITI_SUPP - 6, 14, Z_VITI_SUPP + 6), 'x', a, b)
    return p


# ================================================================== elenco

def tutti():
    return {
        'scocca': scocca(),
        'fondo': fondo(),
        'piatto': piatto(),
        'rondella': rondella(),
        'supporto_sensore': supporto_sensore(),
        'morsetto_fader': morsetto_fader(),
        'manopola': manopola(),
        'collare_play': collare('PLAY'),
        'collare_cue': collare('CUE'),
        'supporto_tablet': supporto_tablet(),
    }
