"""Genera i file da stampare (STL per pezzo, 3MF per piatto), le anteprime e i controlli.
Uso: python3 genera.py [--veloce]   (--veloce salta anteprime e sezioni)"""
import os
import sys
import time

import numpy as np

import parti
from solco_cad import (ROT_X180, ROT_X_TO_Z, check_shell, render, slice_raster, write_3mf,
                       write_stl)

QUI = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(QUI, '..', 'stampa')
PREV = os.path.join(QUI, '..', 'anteprime')
PIANO = 256.0
MARGINE = 4.0
os.makedirs(OUT, exist_ok=True)
os.makedirs(PREV, exist_ok=True)
veloce = '--veloce' in sys.argv

t0 = time.time()
P = parti.tutti()
print('pezzi costruiti in %.1f s' % (time.time() - t0))

# ------------------------------------------------------------------ controlli dei gusci
for nome, part in P.items():
    cattivi = [i for i, s in enumerate(part.shells) if not check_shell(s) or s.volume() <= 0]
    lo, hi = part.bounds()
    print('%-18s gusci %3d  ingombro %6.1f × %6.1f × %5.1f mm  %s' % (
        nome, len(part.shells), *(hi - lo), 'OK' if not cattivi else 'GUSCI DIFETTOSI %r' % cattivi[:5]))
    assert not cattivi

# ------------------------------------------------------------------ orientamento di stampa
ORIENT = {
    'scocca': ROT_X180,            # pannello sul piatto: scritte incise sulla faccia liscia
    'fondo': np.eye(3),
    'piatto': ROT_X180,            # faccia superiore della jog sul piatto
    'rondella': ROT_X180,
    'supporto_sensore': np.eye(3),
    'morsetto_fader': np.eye(3),
    'manopola': ROT_X180,
    'collare_play': ROT_X180,
    'collare_cue': ROT_X180,
    'supporto_tablet': ROT_X_TO_Z,  # di fianco: il profilo sul piatto
}
STAMPA = {n: P[n].transformed(ORIENT[n]).on_bed(0, 0) for n in P}

# ------------------------------------------------------------------ piatti (posizioni in mm sul piatto 256 × 256)
PIATTI = [
    ('1_scocca', 'Scocca: pannello, pareti e sede dei cuscinetti', [('scocca', 128, 128)]),
    ('2_fondo', 'Fondo con appoggio della scheda', [('fondo', 128, 128)]),
    ('3_jog_e_minuteria', 'Jog e pezzi piccoli', [
        ('piatto', 80, 128), ('supporto_sensore', 206, 46), ('rondella', 178, 105),
        ('manopola', 218, 105), ('collare_play', 178, 145), ('collare_cue', 178, 185),
        ('morsetto_fader', 230, 190)]),
    ('4_supporto_tablet', 'Supporto del tablet (si stampa di fianco)', [('supporto_tablet', 128, 128)]),
]

for nome, part in STAMPA.items():
    write_stl(os.path.join(OUT, nome + '.stl'), part.mesh(), 'SOLCO ' + nome)

for codice, titolo, voci in PIATTI:
    oggetti = []
    boxes = []
    for nome, x, y in voci:
        part = STAMPA[nome]
        if nome == 'morsetto_fader':
            part = part.transformed(np.eye(3)).on_bed(0, 0)
        placed = part.transformed(np.eye(3), (x, y, 0))
        lo, hi = placed.bounds()
        assert lo[0] >= MARGINE and lo[1] >= MARGINE and hi[0] <= PIANO - MARGINE and hi[1] <= PIANO - MARGINE, \
            (codice, nome, lo, hi)
        assert hi[2] <= 250, (codice, nome, hi[2])
        for (n2, a, b) in boxes:
            assert (hi[0] + 2 <= a[0] or b[0] + 2 <= lo[0] or hi[1] + 2 <= a[1] or b[1] + 2 <= lo[1]), \
                ('sovrapposti', codice, nome, n2)
        boxes.append((nome, lo, hi))
        oggetti.append((nome, placed.mesh()))
    write_3mf(os.path.join(OUT, 'piatto_%s.3mf' % codice), oggetti, 'SOLCO — ' + titolo)
    print('piatto %-22s %s' % (codice, ', '.join(v[0] for v in voci)))

if veloce:
    sys.exit(0)

# ------------------------------------------------------------------ anteprime
cx, cy = parti.C
montaggio = [
    P['scocca'],
    P['piatto'].transformed(np.eye(3), (cx, cy, 0)),
    P['manopola'].transformed(np.eye(3), (parti.MANOPOLA[0], parti.MANOPOLA[1], 0)),
    P['collare_play'].transformed(np.eye(3), (24.0, 30.0, 0)),
    P['collare_cue'].transformed(np.eye(3), (24.0, 66.0, 0)),
    P['supporto_tablet'].transformed(np.eye(3), (20.0, parti.D, -parti.H_SCOCCA - 3.0)),
    P['fondo'],
]
colori = ['#30343a', '#b9bcc2', '#d8d8d8', '#c8c8c8', '#c8c8c8', '#3c4148', '#262a2f']
render(montaggio, os.path.join(PREV, 'montaggio.png'), view=(-28, 30), colors=colori,
       title='SOLCO — un\'unità montata (senza tablet)')
render(montaggio, os.path.join(PREV, 'montaggio_alto.png'), view=(0, 72), colors=colori)
sotto = [P['scocca'], P['supporto_sensore'].transformed(np.eye(3), (cx, cy, 0)),
         P['rondella'].transformed(np.eye(3), (cx, cy, 0)),
         P['piatto'].transformed(np.eye(3), (cx, cy, 0)), P['morsetto_fader']]
render(sotto, os.path.join(PREV, 'scocca_sotto.png'), view=(-30, -55), colors=['#30343a', '#4a6fa5', '#b87333', '#b9bcc2', '#7a8b5c'],
       title='Scocca vista da sotto (senza fondo)')
for codice, titolo, voci in PIATTI:
    parts = []
    for nome, x, y in voci:
        parts.append(STAMPA[nome].transformed(np.eye(3), (x, y, 0)))
    render(parts, os.path.join(PREV, 'piatto_%s.png' % codice), view=(-35, 45), title=titolo)

# ------------------------------------------------------------------ sezioni (come le vede lo slicer)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

sez = [('scocca', 0.3, 'pannello: scritte incise (primo strato)'), ('scocca', 1.5, 'pannello'),
       ('scocca', 8.0, 'mozzo cuscinetti e nervature'), ('scocca', 30.0, 'pareti e colonne'),
       ('supporto_tablet', 100.0, 'supporto tablet'), ('piatto', 0.2, 'jog: faccia superiore')]
fig, axs = plt.subplots(2, 3, figsize=(18, 12))
for ax, (nome, z, tit) in zip(axs.flat, sez):
    part = STAMPA[nome]
    lo, hi = part.bounds()
    img = slice_raster(part, z, lo[0] - 2, lo[1] - 2, hi[0] + 2, hi[1] + 2, res=0.25)
    ax.imshow(img, origin='lower', cmap='Greys', extent=(lo[0] - 2, hi[0] + 2, lo[1] - 2, hi[1] + 2))
    ax.set_title('%s — z %.1f mm' % (tit, z))
    ax.set_aspect('equal')
fig.tight_layout()
fig.savefig(os.path.join(PREV, 'sezioni.png'), dpi=90)
print('anteprime pronte in %.1f s' % (time.time() - t0))
