"""Disegna lo schema dei collegamenti sui morsetti della Terminal PiCowbell (vista dall'alto, USB in alto)."""
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

QUI = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(QUI, '..', 'anteprime', 'schema_collegamenti.png')

SX = ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND',
      'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'GP14', 'GP15']
DX = ['VBUS', 'VSYS', 'GND', '3V3_EN', '3V3', 'ADC_VREF', 'GP28', 'AGND', 'GP27', 'GP26', 'RUN',
      'GP22', 'GND', 'GP21', 'GP20', 'GP19', 'GP18', 'GND', 'GP17', 'GP16']
USO = {
    'GP0': ('HOT CUE A', 'p'), 'GP1': ('HOT CUE B', 'p'), 'GP2': ('HOT CUE C', 'p'), 'GP3': ('HOT CUE D', 'p'),
    'GP4': ('usato dalla presa STEMMA QT', 'x'), 'GP5': ('usato dalla presa STEMMA QT', 'x'),
    'GP6': ('HOT CUE E', 'p'), 'GP7': ('HOT CUE F', 'p'), 'GP8': ('HOT CUE G', 'p'), 'GP9': ('HOT CUE H', 'p'),
    'GP10': ('LOOP IN', 'p'), 'GP11': ('LOOP OUT', 'p'), 'GP12': ('RELOOP', 'p'), 'GP13': ('AUTO 4', 'p'),
    'GP14': ('◀ JUMP', 'p'), 'GP15': ('JUMP ▶', 'p'),
    'GP16': ('PLAY (con prolunga)', 'p'), 'GP17': ('CUE (con prolunga)', 'p'), 'GP18': ('KEY LOCK', 'p'),
    'GP19': ('SHIFT', 'p'), 'GP20': ('BACK', 'p'),
    'GP21': ('TOCCO JOG: filo dal rame + resistenza 1 MΩ', 't'),
    'GP22': ('manopola SW', 'm'), 'GP27': ('manopola CLK', 'm'), 'GP28': ('manopola DT', 'm'),
    '3V3': ('manopola +', 'm'), 'GND': ('massa: filo da un WAGO', 'g'),
    'AGND': ('—', 'x'), 'ADC_VREF': ('—', 'x'), 'GP26': ('libero', 'x'), 'RUN': ('—', 'x'),
    'VBUS': ('—', 'x'), 'VSYS': ('—', 'x'), '3V3_EN': ('—', 'x'),
}
COL = {'p': '#2f6fb3', 'm': '#7a5bb5', 't': '#b5651d', 'g': '#222222', 'x': '#9a9a9a'}

fig = plt.figure(figsize=(13, 10.5), dpi=110)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, 130)
ax.set_ylim(0, 105)
ax.axis('off')
ax.add_patch(FancyBboxPatch((50, 8), 30, 84, boxstyle='round,pad=0.6', fc='#1d1d1f', ec='#1d1d1f'))
ax.add_patch(Rectangle((60.5, 89.5), 9, 5, fc='#bdbdbd', ec='#777'))
ax.text(65, 96.5, 'USB del Pico', ha='center', fontsize=10)
ax.text(65, 50, 'Raspberry Pi Pico H\nsulla Terminal PiCowbell\n(vista dall\'alto)', ha='center', va='center',
        color='white', fontsize=10.5)
for i in range(20):
    y = 88 - i * 4.0
    for lato, nomi, x_m, x_t, ha in (('s', SX, 50.6, 48.5, 'right'), ('d', DX, 79.4, 81.5, 'left')):
        nome = nomi[i]
        uso, k = USO.get(nome, ('—', 'x'))
        ax.add_patch(Rectangle((x_m - 1.6, y - 1.4), 3.2, 2.8, fc='#3fa34d' if k != 'x' else '#5b5b5b', ec='none'))
        ax.text(x_m + (2.4 if lato == 's' else -2.4), y, nome, ha='left' if lato == 's' else 'right', va='center',
                color='white', fontsize=8.5)
        ax.text(x_t, y, uso, ha=ha, va='center', color=COL[k], fontsize=10.5,
                fontweight='bold' if k in 'pmt' else 'normal')
ax.text(65, 3.2, 'Ogni pulsante ha due fili: uno va al morsetto indicato, l\'altro a un connettore WAGO di massa.\n'
        'Jog magnetica (AS5600) e fader (NeoSlider) si collegano alla presa STEMMA QT: niente morsetti.',
        ha='center', fontsize=10.5)
ax.text(65, 101.5, 'SOLCO — collegamenti sui morsetti', ha='center', fontsize=15, fontweight='bold')
fig.savefig(OUT, facecolor='white')
print('schema salvato:', OUT)
