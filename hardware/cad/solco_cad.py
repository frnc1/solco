"""
SOLCO — piccola libreria CAD "a prismi" per generare i pezzi da stampare.

Ogni pezzo è l'unione di prismi: un profilo 2D (contorno esterno + fori) estruso lungo un asse.
I prismi possono sovrapporsi: i programmi di slicing (Bambu Studio, PrusaSlicer, Orca) li uniscono.
I vuoti (fori, scritte incise) si ottengono non coprendo quella zona con nessun prisma.

Coordinate: millimetri. Assi: 'z' → profilo nel piano (x, y); 'x' → profilo nel piano (y, z);
'y' → profilo nel piano (z, x).
"""
import math
import struct
import zipfile

import numpy as np

# ============================================================== earcut (porting di mapbox/earcut)


class _Node:
    __slots__ = ('i', 'x', 'y', 'prev', 'next', 'steiner')

    def __init__(self, i, x, y):
        self.i = i
        self.x = x
        self.y = y
        self.prev = None
        self.next = None
        self.steiner = False


def _insert(i, x, y, last):
    p = _Node(i, x, y)
    if last is None:
        p.prev = p
        p.next = p
    else:
        p.next = last.next
        p.prev = last
        last.next.prev = p
        last.next = p
    return p


def _remove(p):
    p.next.prev = p.prev
    p.prev.next = p.next


def _area(p, q, r):
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)


def _equals(a, b):
    return a.x == b.x and a.y == b.y


def _signed_area(pts):
    s = 0.0
    n = len(pts)
    j = n - 1
    for i in range(n):
        s += (pts[j][0] - pts[i][0]) * (pts[i][1] + pts[j][1])
        j = i
    return s


def _linked_list(pts, start_index, clockwise):
    last = None
    n = len(pts)
    if clockwise == (_signed_area(pts) > 0):
        for k in range(n):
            last = _insert(start_index + k, pts[k][0], pts[k][1], last)
    else:
        for k in range(n - 1, -1, -1):
            last = _insert(start_index + k, pts[k][0], pts[k][1], last)
    if last is not None and _equals(last, last.next):
        _remove(last)
        last = last.next
    return last


def _filter_points(start, end=None):
    if start is None:
        return start
    if end is None:
        end = start
    p = start
    while True:
        again = False
        if not p.steiner and (_equals(p, p.next) or _area(p.prev, p, p.next) == 0):
            _remove(p)
            p = end = p.prev
            if p is p.next:
                break
            again = True
        else:
            p = p.next
        if not again and p is end:
            break
    return end


def _point_in_triangle(ax, ay, bx, by, cx, cy, px, py):
    return ((cx - px) * (ay - py) >= (ax - px) * (cy - py) and
            (ax - px) * (by - py) >= (bx - px) * (ay - py) and
            (bx - px) * (cy - py) >= (cx - px) * (by - py))


def _is_ear(ear):
    a, b, c = ear.prev, ear, ear.next
    if _area(a, b, c) >= 0:
        return False
    ax, bx, cx, ay, by, cy = a.x, b.x, c.x, a.y, b.y, c.y
    x0 = min(ax, bx, cx)
    y0 = min(ay, by, cy)
    x1 = max(ax, bx, cx)
    y1 = max(ay, by, cy)
    p = c.next
    while p is not a:
        if (x0 <= p.x <= x1 and y0 <= p.y <= y1 and
                _point_in_triangle(ax, ay, bx, by, cx, cy, p.x, p.y) and
                _area(p.prev, p, p.next) >= 0):
            return False
        p = p.next
    return True


def _sign(v):
    return 1 if v > 0 else (-1 if v < 0 else 0)


def _on_segment(p, q, r):
    return (min(p.x, r.x) <= q.x <= max(p.x, r.x) and min(p.y, r.y) <= q.y <= max(p.y, r.y))


def _intersects(p1, q1, p2, q2):
    o1 = _sign(_area(p1, q1, p2))
    o2 = _sign(_area(p1, q1, q2))
    o3 = _sign(_area(p2, q2, p1))
    o4 = _sign(_area(p2, q2, q1))
    if o1 != o2 and o3 != o4:
        return True
    if o1 == 0 and _on_segment(p1, p2, q1):
        return True
    if o2 == 0 and _on_segment(p1, q2, q1):
        return True
    if o3 == 0 and _on_segment(p2, p1, q2):
        return True
    if o4 == 0 and _on_segment(p2, q1, q2):
        return True
    return False


def _intersects_polygon(a, b):
    p = a
    while True:
        if (p.i != a.i and p.next.i != a.i and p.i != b.i and p.next.i != b.i and
                _intersects(p, p.next, a, b)):
            return True
        p = p.next
        if p is a:
            return False


def _locally_inside(a, b):
    if _area(a.prev, a, a.next) < 0:
        return _area(a, b, a.next) >= 0 and _area(a, a.prev, b) >= 0
    return _area(a, b, a.prev) < 0 or _area(a, a.next, b) < 0


def _middle_inside(a, b):
    p = a
    inside = False
    px = (a.x + b.x) / 2
    py = (a.y + b.y) / 2
    while True:
        if ((p.y > py) != (p.next.y > py)) and p.next.y != p.y and \
                (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x):
            inside = not inside
        p = p.next
        if p is a:
            return inside


def _is_valid_diagonal(a, b):
    return (a.next.i != b.i and a.prev.i != b.i and not _intersects_polygon(a, b) and
            ((_locally_inside(a, b) and _locally_inside(b, a) and _middle_inside(a, b) and
              (_area(a.prev, a, b.prev) != 0 or _area(a, b.prev, b) != 0)) or
             (_equals(a, b) and _area(a.prev, a, a.next) > 0 and _area(b.prev, b, b.next) > 0)))


def _split_polygon(a, b):
    a2 = _Node(a.i, a.x, a.y)
    b2 = _Node(b.i, b.x, b.y)
    an = a.next
    bp = b.prev
    a.next = b
    b.prev = a
    a2.next = an
    an.prev = a2
    b2.next = a2
    a2.prev = b2
    bp.next = b2
    b2.prev = bp
    return b2


def _cure_local_intersections(start, tris):
    p = start
    while True:
        a = p.prev
        b = p.next.next
        if (not _equals(a, b) and _intersects(a, p, p.next, b) and
                _locally_inside(a, b) and _locally_inside(b, a)):
            tris.append((a.i, p.i, b.i))
            _remove(p)
            _remove(p.next)
            p = start = b
        p = p.next
        if p is start:
            break
    return _filter_points(p)


def _split_earcut(start, tris):
    a = start
    while True:
        b = a.next.next
        while b is not a.prev:
            if a.i != b.i and _is_valid_diagonal(a, b):
                c = _split_polygon(a, b)
                a = _filter_points(a, a.next)
                c = _filter_points(c, c.next)
                _earcut_linked(a, tris, 0)
                _earcut_linked(c, tris, 0)
                return
            b = b.next
        a = a.next
        if a is start:
            return


def _earcut_linked(ear, tris, pas):
    if ear is None:
        return
    stop = ear
    while ear.prev is not ear.next:
        prev = ear.prev
        nxt = ear.next
        if _is_ear(ear):
            tris.append((prev.i, ear.i, nxt.i))
            _remove(ear)
            ear = nxt.next
            stop = nxt.next
            continue
        ear = nxt
        if ear is stop:
            if pas == 0:
                _earcut_linked(_filter_points(ear), tris, 1)
            elif pas == 1:
                ear = _cure_local_intersections(_filter_points(ear), tris)
                _earcut_linked(ear, tris, 2)
            else:
                _split_earcut(ear, tris)
            break


def _get_leftmost(start):
    p = start
    left = start
    while True:
        if p.x < left.x or (p.x == left.x and p.y < left.y):
            left = p
        p = p.next
        if p is start:
            return left


def _sector_contains_sector(m, p):
    return _area(m.prev, m, p.prev) < 0 and _area(p.next, m, m.next) < 0


def _find_hole_bridge(hole, outer):
    p = outer
    hx, hy = hole.x, hole.y
    qx = -math.inf
    m = None
    while True:
        if hy <= p.y and hy >= p.next.y and p.next.y != p.y:
            x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y)
            if x <= hx and x > qx:
                qx = x
                m = p if p.x < p.next.x else p.next
                if x == hx:
                    return m
        p = p.next
        if p is outer:
            break
    if m is None:
        return None
    stop = m
    mx, my = m.x, m.y
    tan_min = math.inf
    p = m
    while True:
        if (hx >= p.x and p.x >= mx and hx != p.x and
                _point_in_triangle(hx if hy < my else qx, hy, mx, my, qx if hy < my else hx, hy, p.x, p.y)):
            tan = abs(hy - p.y) / (hx - p.x)
            if _locally_inside(p, hole) and (tan < tan_min or (tan == tan_min and (
                    p.x > m.x or (p.x == m.x and _sector_contains_sector(m, p))))):
                m = p
                tan_min = tan
        p = p.next
        if p is stop:
            break
    return m


def _eliminate_hole(hole, outer):
    bridge = _find_hole_bridge(hole, outer)
    if bridge is None:
        return outer
    bridge_rev = _split_polygon(bridge, hole)
    _filter_points(bridge_rev, bridge_rev.next)
    return _filter_points(bridge, bridge.next)


def earcut(outer, holes=()):
    """Triangola un poligono con fori. Restituisce triangoli come indici nella lista
    concatenata [outer, hole1, hole2, ...]."""
    tris = []
    outer_node = _linked_list(outer, 0, True)
    if outer_node is None or outer_node.next is outer_node.prev:
        return tris
    if holes:
        queue = []
        start = len(outer)
        for h in holes:
            lst = _linked_list(h, start, False)
            start += len(h)
            if lst is None:
                continue
            if lst is lst.next:
                lst.steiner = True
            queue.append(_get_leftmost(lst))
        queue.sort(key=lambda n: n.x)
        for h in queue:
            outer_node = _eliminate_hole(h, outer_node)
    _earcut_linked(outer_node, tris, 0)
    return tris


# ============================================================== geometria 2D

def _clean(pts, eps=1e-6):
    pts = np.asarray(pts, dtype=float)
    keep = [0]
    for i in range(1, len(pts)):
        if np.hypot(*(pts[i] - pts[keep[-1]])) > eps:
            keep.append(i)
    pts = pts[keep]
    if len(pts) > 1 and np.hypot(*(pts[0] - pts[-1])) <= eps:
        pts = pts[:-1]
    return pts


def area2(pts):
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def ccw(pts):
    pts = _clean(pts)
    return pts if area2(pts) > 0 else pts[::-1].copy()


def cw(pts):
    pts = _clean(pts)
    return pts if area2(pts) < 0 else pts[::-1].copy()


class Piece:
    """Un contorno esterno con eventuali fori (tutti chiusi, senza sovrapposizioni)."""

    def __init__(self, outer, holes=()):
        self.outer = ccw(outer)
        self.holes = [cw(h) for h in holes]

    def with_holes(self, *more):
        return Piece(self.outer, list(self.holes) + [cw(h) for h in more])

    def bbox(self):
        return self.outer[:, 0].min(), self.outer[:, 1].min(), self.outer[:, 0].max(), self.outer[:, 1].max()


def circle(cx, cy, r, n=None):
    if n is None:
        n = max(24, min(160, int(2 * math.pi * r / 0.8)))
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.column_stack([cx + r * np.cos(t), cy + r * np.sin(t)])


def rect(x0, y0, x1, y1):
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=float)


def rrect(x0, y0, x1, y1, r, seg=10):
    r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
    if r <= 0:
        return rect(x0, y0, x1, y1)
    pts = []
    for (cx, cy, a0) in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        for k in range(seg + 1):
            a = math.radians(a0 + 90 * k / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.array(pts)


def slot(x0, y0, x1, y1, w, seg=10):
    """Asola con estremi arrotondati dal punto (x0,y0) al punto (x1,y1), larghezza w."""
    ang = math.atan2(y1 - y0, x1 - x0)
    r = w / 2
    pts = []
    for (cx, cy, a0) in ((x1, y1, ang - math.pi / 2), (x0, y0, ang + math.pi / 2)):
        for k in range(seg + 1):
            a = a0 + math.pi * k / seg
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.array(pts)


def poly(points):
    return np.asarray(points, dtype=float)


def ring(cx, cy, r_out, r_in, n=None):
    return Piece(circle(cx, cy, r_out, n), [circle(cx, cy, r_in, n)])


def toothed_circle(cx, cy, r, depth, teeth):
    pts = []
    for k in range(teeth * 2):
        a = 2 * math.pi * k / (teeth * 2)
        rr = r if k % 2 == 0 else r - depth
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return np.array(pts)


def point_in_poly(pt, pts):
    x, y = pt
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------- testo (contorni dei caratteri)

_FONT_CACHE = {}


def text_contours(s, cap_height, font='/usr/share/fonts/opentype/inter/Inter-Black.otf'):
    """Contorni dei caratteri di s, con altezza delle maiuscole = cap_height (mm).
    Restituisce (lista di contorni, larghezza, altezza) con origine in basso a sinistra."""
    from matplotlib.font_manager import FontProperties
    from matplotlib.textpath import TextPath
    if font not in _FONT_CACHE:
        _FONT_CACHE[font] = FontProperties(fname=font)
    fp = _FONT_CACHE[font]
    ref = TextPath((0, 0), 'H', size=100, prop=fp).get_extents()
    size = cap_height * 100 / ref.height
    tp = TextPath((0, 0), s, size=size, prop=fp)
    polys = [_clean(p) for p in tp.to_polygons(closed_only=True)]
    polys = [p for p in polys if len(p) >= 3 and abs(area2(p)) > 1e-4]
    if not polys:
        return [], 0, 0
    allp = np.vstack(polys)
    x0, y0 = allp.min(axis=0)
    x1, y1 = allp.max(axis=0)
    return [p - [x0, y0] for p in polys], x1 - x0, y1 - y0


def nest_contours(contours):
    """Organizza i contorni per profondità: (contorno, profondità, indice genitore)."""
    n = len(contours)
    depth = [0] * n
    parent = [-1] * n
    areas = [abs(area2(c)) for c in contours]
    for i in range(n):
        best = -1
        for j in range(n):
            if i == j or areas[j] <= areas[i]:
                continue
            if point_in_poly(contours[i][0], contours[j]):
                depth[i] += 1
                if best < 0 or areas[j] < areas[best]:
                    best = j
        parent[i] = best
    return depth, parent


# ============================================================== mesh

class Mesh:
    def __init__(self, V=None, F=None):
        self.V = np.zeros((0, 3)) if V is None else np.asarray(V, dtype=float)
        self.F = np.zeros((0, 3), dtype=np.int64) if F is None else np.asarray(F, dtype=np.int64)

    def copy(self):
        return Mesh(self.V.copy(), self.F.copy())

    def volume(self):
        a = self.V[self.F[:, 0]]
        b = self.V[self.F[:, 1]]
        c = self.V[self.F[:, 2]]
        return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6)

    def transformed(self, M, t=(0, 0, 0)):
        M = np.asarray(M, dtype=float)
        V = self.V @ M.T + np.asarray(t, dtype=float)
        F = self.F if np.linalg.det(M) > 0 else self.F[:, ::-1]
        return Mesh(V, F.copy())

    def translated(self, t):
        return Mesh(self.V + np.asarray(t, dtype=float), self.F.copy())


def _tjunction_hits(pts, T):
    """Vertici che cadono all'interno di un lato di un triangolo (giunzioni a T)."""
    E = np.vstack([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    m = len(T)
    hits = {}
    P = pts
    for s0 in range(0, len(E), 400):
        e = E[s0:s0 + 400]
        A = P[e[:, 0]]
        Bv = P[e[:, 1]]
        d = Bv - A                                   # (k,2)
        L2 = (d * d).sum(axis=1)                     # (k,)
        lo = np.minimum(A, Bv) - 1e-9
        hi = np.maximum(A, Bv) + 1e-9
        inb = ((P[None, :, 0] >= lo[:, None, 0]) & (P[None, :, 0] <= hi[:, None, 0]) &
               (P[None, :, 1] >= lo[:, None, 1]) & (P[None, :, 1] <= hi[:, None, 1]))
        ei, vi = np.nonzero(inb)
        if not len(ei):
            continue
        w = P[vi] - A[ei]
        cr = d[ei, 0] * w[:, 1] - d[ei, 1] * w[:, 0]
        t = (w * d[ei]).sum(axis=1) / np.where(L2[ei] == 0, 1, L2[ei])
        ok = (np.abs(cr) <= 1e-7 * L2[ei] + 1e-12) & (t > 1e-9) & (t < 1 - 1e-9) & (L2[ei] > 0)
        ok &= (vi != e[ei, 0]) & (vi != e[ei, 1])
        for k, v, tt in zip(ei[ok] + s0, vi[ok], t[ok]):
            tri = k % m
            slot = k // m                            # 0: lato a-b, 1: b-c, 2: c-a
            hits.setdefault((tri, slot), []).append((tt, v))
    return hits


def _fix_missing(pts, T):
    """earcut può lasciare vertici allineati sul lato di un triangolo: spezza quei triangoli
    finché le facce superiori combaciano esattamente con le pareti (niente lati aperti)."""
    for _ in range(12):
        if not len(T):
            return T
        hits = _tjunction_hits(pts, T)
        if not hits:
            return T
        per_tri = {}
        for (tri, slot), lst in hits.items():
            per_tri.setdefault(tri, (slot, lst))
        out = []
        for ti, (a, b, c) in enumerate(T.tolist()):
            if ti not in per_tri:
                out.append((a, b, c))
                continue
            slot, lst = per_tri[ti]
            v = [a, b, c]
            x, y, z = v[slot], v[(slot + 1) % 3], v[(slot + 2) % 3]
            chain = [x] + [vv for _, vv in sorted(lst)] + [y]
            for u, w in zip(chain[:-1], chain[1:]):
                out.append((u, w, z))
        T = np.array(out, dtype=np.int64).reshape(-1, 3)
    return T


def triangulate_piece(piece):
    outer = [tuple(p) for p in piece.outer]
    holes = [[tuple(p) for p in h] for h in piece.holes]
    tris = earcut(outer, holes)
    pts = np.vstack([piece.outer] + piece.holes) if piece.holes else piece.outer
    T = np.array(tris, dtype=np.int64).reshape(-1, 3)
    T = _fix_missing(pts, T)
    if len(T):
        a, b, c = pts[T[:, 0]], pts[T[:, 1]], pts[T[:, 2]]
        cr = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
        flip = cr < 0
        T[flip] = T[flip][:, ::-1]
    return pts, T


def _map(axis, u, v, w):
    if axis == 'z':
        return np.column_stack([u, v, w])
    if axis == 'x':
        return np.column_stack([w, u, v])
    if axis == 'y':
        return np.column_stack([v, w, u])
    raise ValueError(axis)


def prism(piece, axis, w0, w1):
    """Estrude un Piece lungo l'asse dato tra w0 e w1. Restituisce un Mesh chiuso."""
    if w1 < w0:
        w0, w1 = w1, w0
    pts, T = triangulate_piece(piece)
    n = len(pts)
    u, v = pts[:, 0], pts[:, 1]
    V = np.vstack([_map(axis, u, v, np.full(n, w0)), _map(axis, u, v, np.full(n, w1))])
    faces = [T[:, ::-1], T + n]          # fondo (verso -asse) e cima (verso +asse)
    off = 0
    for ring_pts in [piece.outer] + piece.holes:
        m = len(ring_pts)
        idx = np.arange(m) + off
        nxt = np.roll(idx, -1)
        faces.append(np.column_stack([idx, nxt, nxt + n]))
        faces.append(np.column_stack([idx, nxt + n, idx + n]))
        off += m
    mesh = Mesh(V, np.vstack(faces))
    if mesh.volume() < 0:      # l'asse 'y' e 'x' hanno orientamenti diversi: normalizza
        mesh.F = mesh.F[:, ::-1]
    return mesh


class Part:
    """Un pezzo da stampare: insieme di prismi (gusci chiusi)."""

    def __init__(self, name):
        self.name = name
        self.shells = []

    def add(self, piece, axis, w0, w1):
        if isinstance(piece, np.ndarray):
            piece = Piece(piece)
        self.shells.append(prism(piece, axis, w0, w1))
        return self

    def add_mesh(self, mesh):
        self.shells.append(mesh)
        return self

    def mesh(self):
        Vs, Fs, off = [], [], 0
        for s in self.shells:
            Vs.append(s.V)
            Fs.append(s.F + off)
            off += len(s.V)
        return Mesh(np.vstack(Vs), np.vstack(Fs))

    def transformed(self, M, t=(0, 0, 0)):
        p = Part(self.name)
        p.shells = [s.transformed(M, t) for s in self.shells]
        return p

    def bounds(self):
        V = np.vstack([s.V for s in self.shells])
        return V.min(axis=0), V.max(axis=0)

    def on_bed(self, cx=None, cy=None):
        """Appoggia il pezzo sul piano (z min = 0) e lo centra in (cx, cy)."""
        lo, hi = self.bounds()
        t = [0.0, 0.0, -lo[2]]
        if cx is not None:
            t[0] = cx - (lo[0] + hi[0]) / 2
        if cy is not None:
            t[1] = cy - (lo[1] + hi[1]) / 2
        return self.transformed(np.eye(3), t)


ROT_X180 = np.array([[1, 0, 0], [0, -1, 0], [0, 0, -1]], dtype=float)   # capovolge (sotto-sopra)
ROT_Z90 = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], dtype=float)
ROT_X_TO_Z = np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]], dtype=float)  # (x,y,z) → (y,z,x)


# ============================================================== controlli

def check_shell(mesh):
    """Ogni lato deve essere condiviso da esattamente due triangoli con verso opposto."""
    from collections import Counter
    F = mesh.F
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    c = Counter(map(tuple, e.tolist()))
    for (a, b), k in c.items():
        if k != 1 or c.get((b, a), 0) != 1:
            return False
    return True


def slice_raster(part, z, x0, y0, x1, y1, res=0.25):
    """Sezione del pezzo all'altezza z con regola 'non zero' (come gli slicer): matrice booleana."""
    segs = []
    for s in part.shells:
        V, F = s.V, s.F
        a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        za, zb, zc = a[:, 2] - z, b[:, 2] - z, c[:, 2] - z
        mask = ~(((za > 0) & (zb > 0) & (zc > 0)) | ((za < 0) & (zb < 0) & (zc < 0)))
        if not mask.any():
            continue
        n = np.cross(b - a, c - a)
        for tri, nn in zip(np.stack([a, b, c], axis=1)[mask], n[mask]):
            d = tri[:, 2] - z
            pts = []
            for i in range(3):
                j = (i + 1) % 3
                if (d[i] < 0) != (d[j] < 0):
                    t = d[i] / (d[i] - d[j])
                    pts.append(tri[i, :2] + t * (tri[j, :2] - tri[i, :2]))
            if len(pts) != 2:
                continue
            p, q = pts
            dirn = np.array([-nn[1], nn[0]])
            if np.dot(q - p, dirn) < 0:
                p, q = q, p
            segs.append((p[0], p[1], q[0], q[1]))
    W = int(math.ceil((x1 - x0) / res))
    H = int(math.ceil((y1 - y0) / res))
    img = np.zeros((H, W), dtype=bool)
    if not segs:
        return img
    S = np.array(segs)
    xs = x0 + (np.arange(W) + 0.5) * res
    for r in range(H):
        y = y0 + (r + 0.5) * res
        ya, yb = S[:, 1], S[:, 3]
        sel = (ya <= y) != (yb <= y)
        if not sel.any():
            continue
        s = S[sel]
        t = (y - s[:, 1]) / (s[:, 3] - s[:, 1])
        xc = s[:, 0] + t * (s[:, 2] - s[:, 0])
        sg = np.where(s[:, 3] > s[:, 1], 1, -1)
        order = np.argsort(xc)
        xc, sg = xc[order], sg[order]
        # numero di avvolgimento a destra di ogni pixel
        k = np.searchsorted(xc, xs)
        csum = np.concatenate([[0], np.cumsum(sg[::-1])])[::-1]   # somma dei segni da k in poi
        wind = csum[k]
        img[r] = wind != 0
    return img


# ============================================================== esportazione

def write_stl(path, mesh, name='solco'):
    V, F = mesh.V, mesh.F
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1)
    ln[ln == 0] = 1
    n = n / ln[:, None]
    data = np.zeros(len(F), dtype=[('n', '<f4', 3), ('a', '<f4', 3), ('b', '<f4', 3), ('c', '<f4', 3), ('x', '<u2')])
    data['n'], data['a'], data['b'], data['c'] = n, a, b, c
    with open(path, 'wb') as f:
        f.write(name.encode()[:80].ljust(80, b' '))
        f.write(struct.pack('<I', len(F)))
        f.write(data.tobytes())


def write_3mf(path, objects, title='SOLCO'):
    """objects: lista di (nome, Mesh) già posizionati sul piano (coordinate del piatto)."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<model unit="millimeter" xml:lang="it-IT" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
           '<metadata name="Title">%s</metadata>' % title,
           '<metadata name="Designer">SOLCO</metadata>',
           '<resources>']
    for k, (name, mesh) in enumerate(objects, start=1):
        out.append('<object id="%d" type="model" name="%s"><mesh><vertices>' % (k, name))
        out.append(''.join('<vertex x="%.4f" y="%.4f" z="%.4f"/>' % tuple(v) for v in mesh.V))
        out.append('</vertices><triangles>')
        out.append(''.join('<triangle v1="%d" v2="%d" v3="%d"/>' % tuple(f) for f in mesh.F))
        out.append('</triangles></mesh></object>')
    out.append('</resources><build>')
    for k in range(1, len(objects) + 1):
        out.append('<item objectid="%d"/>' % k)
    out.append('</build></model>')
    ct = ('<?xml version="1.0" encoding="UTF-8"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
          '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('3D/3dmodel.model', '\n'.join(out))


# ============================================================== anteprime

def render(parts, path, view=(-55, 28), size=(1200, 900), colors=None, title=None, light=(0.35, -0.55, 0.75)):
    """Anteprima ombreggiata con z-buffer (rasterizzazione semplice in numpy)."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    az, el = map(math.radians, view)
    Rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    Rx = np.array([[1, 0, 0], [0, math.cos(el), -math.sin(el)], [0, math.sin(el), math.cos(el)]])
    R = Rx @ Rz
    Lv = np.asarray(light, dtype=float)
    Lv /= np.linalg.norm(Lv)
    palette = colors or ['#3a3f47', '#c9ccd1', '#b87333', '#4a6fa5', '#7a8b5c', '#9b5d73']
    tris, cols = [], []
    for k, p in enumerate(parts):
        base = np.array(matplotlib.colors.to_rgb(palette[k % len(palette)]))
        for sh in p.shells:
            V = sh.V @ R.T
            F = sh.F
            n = np.cross(sh.V[F[:, 1]] - sh.V[F[:, 0]], sh.V[F[:, 2]] - sh.V[F[:, 0]])
            ln = np.linalg.norm(n, axis=1)
            ok = ln > 1e-12
            n = n[ok] / ln[ok, None]
            T = V[F[ok]]
            nv = n @ R.T
            vis = nv[:, 1] < 0
            sh_ = 0.30 + 0.70 * np.clip(n[vis] @ Lv, 0, 1)
            tris.append(T[vis])
            cols.append(np.clip(base[None, :] * sh_[:, None] + 0.06, 0, 1))
    T = np.vstack(tris)
    Cc = np.vstack(cols)
    Wd, Hd = size
    xs, ys = T[:, :, 0], T[:, :, 2]
    lo = np.array([xs.min(), ys.min()])
    hi = np.array([xs.max(), ys.max()])
    top = 70 if title else 30
    scale = min((Wd - 60) / (hi[0] - lo[0]), (Hd - top - 30) / (hi[1] - lo[1]))
    ox = (Wd - (hi[0] - lo[0]) * scale) / 2
    oy = 30 + (Hd - top - 30 - (hi[1] - lo[1]) * scale) / 2
    sx = (xs - lo[0]) * scale + ox
    sy = Hd - ((ys - lo[1]) * scale + oy)
    dz = T[:, :, 1]
    zbuf = np.full((Hd, Wd), np.inf)
    img = np.ones((Hd, Wd, 3)) * np.array([0.957, 0.957, 0.949])
    for i in range(len(T)):
        x0 = max(int(math.floor(sx[i].min())), 0)
        x1 = min(int(math.ceil(sx[i].max())), Wd - 1)
        y0 = max(int(math.floor(sy[i].min())), 0)
        y1 = min(int(math.ceil(sy[i].max())), Hd - 1)
        if x1 < x0 or y1 < y0:
            continue
        ax_, bx_, cx_ = sx[i]
        ay_, by_, cy_ = sy[i]
        den = (by_ - cy_) * (ax_ - cx_) + (cx_ - bx_) * (ay_ - cy_)
        if abs(den) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        l1 = ((by_ - cy_) * (gx - cx_) + (cx_ - bx_) * (gy - cy_)) / den
        l2 = ((cy_ - ay_) * (gx - cx_) + (ax_ - cx_) * (gy - cy_)) / den
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
        if not inside.any():
            continue
        z = l1 * dz[i, 0] + l2 * dz[i, 1] + l3 * dz[i, 2]
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        upd = inside & (z < sub)
        sub[upd] = z[upd]
        img[y0:y1 + 1, x0:x1 + 1][upd] = Cc[i]
    fig = plt.figure(figsize=(Wd / 100, Hd / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.imshow(img, interpolation='antialiased')
    ax.axis('off')
    if title:
        ax.text(24, 40, title, fontsize=17, color='#222', va='center')
    fig.savefig(path)
    plt.close(fig)
