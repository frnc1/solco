"""Porta-puck: supporto per M5StickS3 da incollare sull'etichetta del disco di controllo.

Il foro centrale è più largo del perno (Ø 7,24 mm): il supporto gira col DISCO, non col
piatto, così quando tieni fermo il disco o fai scratch il puck lo sente.
Lo stick (48 × 24 × 15 mm) va dentro intero, schermo in su, a incastro leggero.

Uso: python3 porta_puck.py   → ../stampa/porta_puck.stl e ../anteprime/porta_puck.png
"""
import os

from solco_cad import Part, Piece, check_shell, circle, nest_contours, rect, render, text_contours, write_stl

QUI = os.path.dirname(os.path.abspath(__file__))
FONT = '/usr/share/fonts/opentype/inter/Inter-Black.otf'

R_BASE = 45.0        # Ø 90 mm: sta dentro l'etichetta di un 12" (circa Ø 100 mm)
H_BASE = 2.0
R_FORO = 4.5         # Ø 9 mm sul perno da 7,24 mm: non stringe
STICK_L, STICK_W = 48.0, 24.0
GIOCO = 0.3          # per lato
PAR = 2.0            # spessore delle pareti
H_PAR = 5.0          # altezza delle pareti sopra la base (lasciano liberi i tasti laterali)
Y0 = 7.0             # bordo interno della tasca (dal centro)
USB = 14.0           # apertura sui lati corti (cavo USB-C, ricarica senza togliere lo stick)


def porta_puck():
    p = Part('porta_puck')
    p.add(Piece(circle(0, 0, R_BASE, 240), [circle(0, 0, R_FORO, 64)]), 'z', 0, H_BASE)

    L, W = STICK_L + 2 * GIOCO, STICK_W + 2 * GIOCO
    x0, x1 = -L / 2, L / 2
    y0, y1 = Y0, Y0 + W
    z0, z1 = H_BASE, H_BASE + H_PAR
    # pareti lunghe (piene, comprendono gli angoli)
    p.add(rect(x0 - PAR, y0 - PAR, x1 + PAR, y0), 'z', z0, z1)
    p.add(rect(x0 - PAR, y1, x1 + PAR, y1 + PAR), 'z', z0, z1)
    # pareti corte, con l'apertura al centro
    yc = (y0 + y1) / 2
    for xa, xb in ((x0 - PAR, x0), (x1, x1 + PAR)):
        p.add(rect(xa, y0, xb, yc - USB / 2), 'z', z0, z1)
        p.add(rect(xa, yc + USB / 2, xb, y1), 'z', z0, z1)

    # scritta in rilievo sul lato opposto (fa anche da piccolo contrappeso)
    cont, w, h = text_contours('SOLCO', 8.0, FONT)
    cx, cy = 0.0, -22.0
    cont = [c + [cx - w / 2, cy - h / 2] for c in cont]
    depth, parent = nest_contours(cont)
    for i, (c, d) in enumerate(zip(cont, depth)):
        if d % 2 == 0:
            fori = [cont[j] for j in range(len(cont)) if parent[j] == i]
            p.add(Piece(c, fori), 'z', H_BASE, H_BASE + 0.8)
    return p


if __name__ == '__main__':
    part = porta_puck()
    ok = all(check_shell(s) and s.volume() > 0 for s in part.shells)
    lo, hi = part.bounds()
    print('porta_puck: gusci %d, ingombro %.1f × %.1f × %.1f mm, gusci chiusi: %s' % (
        len(part.shells), hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 'sì' if ok else 'NO'))
    out = os.path.join(QUI, '..', 'stampa', 'porta_puck.stl')
    write_stl(out, part.mesh(), 'SOLCO porta-puck')
    render([part], os.path.join(QUI, '..', 'anteprime', 'porta_puck.png'), title='Porta-puck (M5StickS3) — foro Ø 9 sul perno')
    print('scritto', os.path.relpath(out, QUI))
