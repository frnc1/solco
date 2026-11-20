"""Porta-puck per M5Stack StopWatch, centrato sul perno del giradischi.

Misure prese dal modello 3D ufficiale M5Stack (M5_Hardware/Products/C152_StopWatch/Structures/StopWatch.stl):
  - corpo Ø 51,9 × 15 mm; il bordo sotto è arrotondato (raggio 24,96 a 0,5 mm dal fondo,
    25,38 a 1 mm, 25,58 a 1,5 mm, 25,66 a 2 mm, 25,70 a 3,5 mm);
  - tasti sul fianco a 45° e 315° (sporgono fino a r 27,7 da 4,1 mm in su) e a 135° (da 7 mm in su);
  - USB-C a 180°, da 6,8 a 10,3 mm dal fondo; presa HY2.0 a 225°, da 4,8 mm in su.

Com'è fatto:
  - base Ø 90 sull'etichetta del disco (biadesivo), foro Ø 9,2 sul perno: gira col DISCO;
  - sopra il perno c'è spazio libero fino a 20 mm dal disco;
  - lo StopWatch si incastra in una sede CONICA (15°) che lo prende sul bordo arrotondato:
    si centra da solo, non balla e non gira nella sede (cuneo), qualunque sia la tolleranza
    di stampa (±0,15 mm sul raggio = sta 0,6 mm più su o più giù, sempre staccato dal fondo);
  - il bordo della sede si ferma sotto i tasti; apertura di 40° davanti all'USB-C per la ricarica.

Uso: python3 porta_stopwatch.py → ../stampa/porta_stopwatch.stl, ../stampa/porta_stopwatch.3mf,
     ../anteprime/porta_stopwatch.png (e porta_stopwatch_montato.png se c'è il modello M5Stack).
"""
import math
import os
import sys

import numpy as np

from solco_cad import Mesh, Part, check_shell, earcut, render, write_3mf, write_stl

QUI = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- parametri
N_ANG = 360                  # suddivisione angolare (1°)
R_BASE, H_BASE = 45.0, 2.0   # base Ø 90
R_FORO, Z_FORO = 4.6, 20.0   # foro Ø 9,2 per il perno, chiuso a 20 mm dal disco
SMUSSO_FORO = 0.8            # invito all'imbocco del foro
R_GAMBO = 11.0               # raggio del cono di sostegno alla base (sale a 45°)
R_COPPA = 28.6               # raggio esterno della sede
FONDO = 1.6                  # spessore sopra il foro
Z_F = Z_FORO + FONDO         # fondo della sede (21,6)
K = math.tan(math.radians(15))  # conicità della sede (raggio/altezza)
H0 = 1.25                    # StopWatch staccato dal fondo, valore nominale
RB = 24.847                  # raggio della sede all'altezza del fondo: con H0 il contatto cade a 1,4 mm dal fondo dello StopWatch
H_PARETE = 4.0               # altezza del bordo sopra il fondo (sotto i tasti in ogni caso)
SMUSSO = 0.6                 # smussi del bordo
APERTURA = 20                # mezza apertura davanti all'USB-C (gradi), centrata a 180°


def raggio_sede(zp):
    return RB + K * zp


def profili():
    """Vertici (r, z) e i due profili chiusi (antiorari nel piano r-z):
    con la parete e senza (apertura USB-C). Condividono tutti i vertici tranne la parete."""
    zt = Z_F + H_PARETE
    rl = raggio_sede(H_PARETE - SMUSSO)
    P = {
        'p0': (R_FORO + SMUSSO_FORO, 0.0), 'p1': (R_BASE - 0.6, 0.0), 'p2': (R_BASE, 0.6),
        'p3': (R_BASE, H_BASE - 0.4), 'p4': (R_BASE - 0.4, H_BASE), 'p5': (R_GAMBO, H_BASE),
        'p6': (R_COPPA, H_BASE + (R_COPPA - R_GAMBO)),
        'A': (R_COPPA, Z_F),
        'w1': (R_COPPA, zt - SMUSSO), 'w2': (R_COPPA - SMUSSO, zt),
        'w3': (rl + SMUSSO, zt), 'w4': (rl, zt - SMUSSO),
        'B': (RB, Z_F),
        'q1': (0.0, Z_F), 'q2': (0.0, Z_FORO), 'q3': (R_FORO, Z_FORO), 'q4': (R_FORO, SMUSSO_FORO),
    }
    assert P['p6'][1] <= Z_F
    con_parete = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'A', 'w1', 'w2', 'w3', 'w4', 'B', 'q1', 'q2', 'q3', 'q4']
    senza = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'A', 'B', 'q1', 'q2', 'q3', 'q4']
    return P, con_parete, senza


def tornio(P, settori, n=N_ANG):
    """Rivoluzione a settori: settori = [(j0, j1, profilo)], j in passi di 360/n gradi.
    Profili diversi in settori vicini vengono chiusi da una faccia piana sul confine.
    Restituisce un unico guscio chiuso."""
    nomi = list(P)
    V, idx = [], {}

    def vid(nome, j):
        r, z = P[nome]
        j %= n
        key = (nome, 0) if r == 0 else (nome, j)
        if key not in idx:
            t = 2 * math.pi * j / n
            idx[key] = len(V)
            V.append((r * math.cos(t), r * math.sin(t), z))
        return idx[key]

    F = []
    for j0, j1, prof in settori:
        m = len(prof)
        for i in range(m):
            p, q = prof[i], prof[(i + 1) % m]
            if P[p][0] == 0 and P[q][0] == 0:
                continue
            for j in range(j0, j1):
                a, b, c, d = vid(p, j), vid(q, j), vid(q, j + 1), vid(p, j + 1)
                for tri in ((a, b, c), (a, c, d)):
                    if len(set(tri)) == 3:
                        F.append(tri)
    # facce sui confini tra settori con profili diversi
    for s in range(len(settori)):
        j_conf = settori[s][1]
        prof1, prof2 = settori[s][2], settori[(s + 1) % len(settori)][2]
        e1 = {frozenset((prof1[i], prof1[(i + 1) % len(prof1)])) for i in range(len(prof1))}
        e2 = {frozenset((prof2[i], prof2[(i + 1) % len(prof2)])) for i in range(len(prof2))}
        diff = e1 ^ e2
        if not diff:
            continue
        # anello chiuso dei lati diversi
        adj = {}
        for e in diff:
            a, b = tuple(e)
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        start = next(iter(adj))
        anello, prev, cur = [start], None, start
        while True:
            nxt = [x for x in adj[cur] if x != prev][0]
            if nxt == start:
                break
            anello.append(nxt)
            prev, cur = cur, nxt
        pts = [P[a] for a in anello]
        tris = np.array(earcut(pts), dtype=int).reshape(-1, 3)
        for t in tris:
            F.append(tuple(vid(anello[k], j_conf) for k in t))
    F = np.array(F, dtype=np.int64)
    mesh = Mesh(np.array(V), F)
    _orienta(mesh)
    return mesh


def _orienta(mesh):
    """Rende coerente il verso dei triangoli (propagazione sui lati) e normali verso l'esterno."""
    F = mesh.F
    from collections import defaultdict, deque
    lati = defaultdict(list)
    for k, f in enumerate(F):
        for a, b in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0])):
            lati[frozenset((a, b))].append(k)
    fatto = np.zeros(len(F), bool)
    for s in range(len(F)):
        if fatto[s]:
            continue
        fatto[s] = True
        coda = deque([s])
        while coda:
            k = coda.popleft()
            f = F[k]
            for a, b in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0])):
                for h in lati[frozenset((a, b))]:
                    if h == k or fatto[h]:
                        continue
                    g = F[h]
                    stesso = any((g[i], g[(i + 1) % 3]) == (a, b) for i in range(3))
                    if stesso:
                        F[h] = g[::-1]
                    fatto[h] = True
                    coda.append(h)
    if mesh.volume() < 0:
        mesh.F = F[:, ::-1].copy()


def porta_stopwatch():
    P, con, senza = profili()
    a = int(round(APERTURA * N_ANG / 360))
    mezzo = N_ANG // 2
    # parete da -160° a 160°, poi apertura per l'USB-C da 160° a 200°
    mesh = tornio(P, [(mezzo + a - N_ANG, mezzo - a, con), (mezzo - a, mezzo + a, senza)])
    p = Part('porta_stopwatch')
    p.add_mesh(mesh)
    return p


# ---------------------------------------------------------------- verifica con il modello M5Stack
STL_M5 = os.environ.get('STOPWATCH_STL', os.path.expanduser(
    '~/m5stack/m5_hardware/Products/C152_StopWatch/Structures/StopWatch.stl'))


def carica_stopwatch():
    """Triangoli del modello M5Stack (solo l'oggetto montato), nel sistema del supporto:
    fondo dello StopWatch a z=0, schermo verso +z, USB-C verso -x."""
    import struct
    b = open(STL_M5, 'rb').read()
    n = struct.unpack('<I', b[80:84])[0]
    dt = np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')])
    T = np.frombuffer(b, dtype=dt, count=n, offset=84)['v'].astype(float)
    T = T[T.mean(axis=1)[:, 2] > -30]           # il file contiene anche una copia esplosa
    # modello: x = spessore (0 fondo, 15 schermo), angolo = atan2(z, y)
    return np.stack([T[..., 1], T[..., 2], T[..., 0]], axis=-1)


def raggio_max(T, theta, zs):
    """Raggio esterno dello StopWatch (triangoli T) lungo la direzione theta, alle quote zs."""
    A, Bv, C = T[:, 0], T[:, 1], T[:, 2]
    E1, E2 = Bv - A, C - A
    O = np.stack([60 * np.cos(theta) * np.ones_like(zs), 60 * np.sin(theta) * np.ones_like(zs), zs], 1)
    D = np.tile([-np.cos(theta), -np.sin(theta), 0.0], (len(zs), 1))
    Pv = np.cross(D[:, None, :], E2[None])
    det = np.einsum('rtk,tk->rt', Pv, E1)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    Tv = O[:, None, :] - A[None]
    u = np.einsum('rtk,rtk->rt', Tv, Pv) * inv
    Q = np.cross(Tv, E1[None])
    v = np.einsum('rtk,rtk->rt', D[:, None, :], Q) * inv
    t = np.einsum('tk,rtk->rt', E2, Q) * inv
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
    out = np.where(hit, t, np.inf).min(axis=1)
    return np.where(np.isfinite(out), 60 - out, 0)


def verifica(T):
    """Abbassa lo StopWatch nella sede finché tocca. Restituisce l'altezza del suo fondo sopra
    il fondo della sede, il gioco minimo tra sede e corpo e la distanza tra bordo e tasti."""
    zs = np.arange(0, 6.01, 0.05)
    angoli = [d for d in range(0, 360, 2) if abs(((d - 180) + 180) % 360 - 180) > APERTURA]
    prof = {d: raggio_max(T, math.radians(d), zs) for d in angoli}
    s = max(((prof[d] - RB) / K - zs)[zs <= H_PARETE].max() for d in angoli)
    dentro = zs + s <= H_PARETE
    gioco = min((raggio_sede(zs[dentro] + s) - prof[d][dentro]).min() for d in angoli)
    # primo punto sopra il bordo in cui il corpo sporge oltre il raggio interno della sede (tasti)
    sporge = [zs[i] for d in angoli for i in range(len(zs)) if prof[d][i] > raggio_sede(H_PARETE)]
    margine_tasti = min(sporge) + s - H_PARETE
    return s, gioco, margine_tasti


def sezione(T, s, path):
    """Disegno in sezione: supporto (a destra con il bordo, a sinistra l'apertura USB-C) e StopWatch."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    P, con, senza = profili()
    fig, ax = plt.subplots(figsize=(10, 5.2), dpi=120)
    for prof, seg in ((con, 1), (senza, -1)):
        pts = np.array([P[k] for k in prof])
        ax.fill(seg * pts[:, 0], pts[:, 1], color='#3a3f47')
    zs = np.arange(0, 15.0, 0.05)
    for d, seg in ((0, 1), (180, -1)):
        r = raggio_max(T, math.radians(d), zs)
        z = zs + Z_F + s
        m = r > 0
        ax.fill_betweenx(z[m], 0, seg * r[m], color='#c9ccd1', alpha=0.9, lw=0)
    ax.axhline(0, color='#8a6d3b', lw=3)
    ax.text(-44, -1.6, 'etichetta del disco (biadesivo)', fontsize=9, color='#8a6d3b')
    ax.annotate('spazio per il perno: fino a %.0f mm' % Z_FORO, xy=(0, Z_FORO - 1), xytext=(-44, 9),
                fontsize=9, arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.annotate('sede conica: lo prende\nsul bordo arrotondato', xy=(25.5, Z_F + s + 1.4), xytext=(31, 11),
                fontsize=9, arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.annotate('apertura per l\'USB-C', xy=(-27, Z_F + 2.5), xytext=(-44, 30),
                fontsize=9, arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.annotate('tasti sopra il bordo', xy=(26.5, Z_F + s + 4.6), xytext=(31, 33),
                fontsize=9, arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.set_aspect('equal')
    ax.set_xlim(-47, 47)
    ax.set_ylim(-3, 41)
    ax.set_xlabel('mm')
    ax.set_title('Sezione: porta-puck e StopWatch (modello ufficiale M5Stack)', fontsize=11)
    for sp in ('top', 'right'):
        ax.spines[sp].set_visible(False)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


if __name__ == '__main__':
    part = porta_stopwatch()
    mesh = part.mesh()
    ok = check_shell(mesh) and mesh.volume() > 0
    lo, hi = part.bounds()
    print('porta_stopwatch: %.1f × %.1f × %.1f mm, %d triangoli, guscio unico chiuso: %s, volume %.1f cm³' % (
        hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], len(mesh.F), 'sì' if ok else 'NO', mesh.volume() / 1000))
    if not ok:
        sys.exit(1)
    out = os.path.join(QUI, '..', 'stampa', 'porta_stopwatch.stl')
    write_stl(out, mesh, 'SOLCO porta-puck StopWatch')
    write_3mf(os.path.join(QUI, '..', 'stampa', 'porta_stopwatch.3mf'), [('porta_stopwatch', mesh)],
              'SOLCO — porta-puck StopWatch')
    vista = (55, 28)
    render([part], os.path.join(QUI, '..', 'anteprime', 'porta_stopwatch.png'), view=vista,
           title='Porta-puck StopWatch: base Ø 90, sede conica, apertura per l\'USB-C')
    if os.path.exists(STL_M5):
        from solco_cad import circle
        T = carica_stopwatch()
        s, g, mt = verifica(T)
        print('StopWatch nella sede: fondo a %.2f mm sopra il fondo della sede, gioco minimo %.3f mm, '
              'tasti %.2f mm sopra il bordo' % (s, g, mt))
        sw = Part('stopwatch')
        V = T.reshape(-1, 3) + [0, 0, Z_F + s]
        sw.add_mesh(Mesh(V, np.arange(len(V)).reshape(-1, 3)))
        vetro = Part('schermo')          # il modello M5Stack non ha il vetro: solo per l'anteprima
        vetro.add(circle(0, 0, 25.4, 200), 'z', Z_F + s + 14.2, Z_F + s + 14.9)
        render([part, sw, vetro], os.path.join(QUI, '..', 'anteprime', 'porta_stopwatch_montato.png'),
               view=vista, colors=['#3a3f47', '#c9ccd1', '#111318'],
               title='Con lo StopWatch (modello ufficiale M5Stack): USB-C davanti all\'apertura')
        sezione(T, s, os.path.join(QUI, '..', 'anteprime', 'porta_stopwatch_sezione.png'))
    print('scritto', os.path.relpath(out, QUI))
