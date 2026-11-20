/*
 * SOLCO — motore audio del lettore.
 * Gira dentro un AudioWorklet (thread audio). Lo stesso codice viene caricato
 * anche in Node per i test (vedi tests/engine.test.js).
 *
 * Il brano arriva come due Int16Array (L/R) alla frequenza del contesto audio,
 * più una versione mono decimata x4 (Float32) usata dal time-stretch.
 */
'use strict';

const INV16 = 1 / 32768;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function fmod(a, b) { const r = a % b; return r < 0 ? r + b : r; }

/* ------------------------------------------------------------------ */
/* Time-stretch WSOLA (blocco tonalità): cambia velocità senza cambiare  */
/* l'intonazione. Lavora direttamente sul brano in memoria.             */
/* ------------------------------------------------------------------ */
class Stretcher {
  constructor(dsp) {
    this.dsp = dsp;
    const sr = dsp.sr;
    const H = Math.max(256, Math.round((sr * 0.0213) / 8) * 8); // ~1024 a 48 kHz
    this.H = H;
    this.N = 2 * H;
    this.D = Math.round((sr * 0.012) / 4) * 4;                 // raggio di ricerca ~12 ms
    this.win = new Float32Array(this.N);
    for (let j = 0; j < this.N; j++) this.win[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / this.N);
    this.accL = new Float32Array(this.N);
    this.accR = new Float32Array(this.N);
    this.outL = new Float32Array(H);
    this.outR = new Float32Array(H);
    this.idx = H;
    this.prevS = 0;
    this.active = false;
  }

  /* Avvio senza scatti alla posizione P (intera). */
  reset(P) {
    const d = this.dsp, H = this.H, w = this.win, L = d.L, R = d.R, len = d.len;
    P = Math.round(P);
    this.prevS = P - H;
    for (let j = 0; j < H; j++) {
      const k = P + j, g = w[H + j];
      if (k >= 0 && k < len) { this.accL[j] = L[k] * INV16 * g; this.accR[j] = R[k] * INV16 * g; }
      else { this.accL[j] = 0; this.accR[j] = 0; }
    }
    this.accL.fill(0, H);
    this.accR.fill(0, H);
    this.idx = H;
    this.active = true;
  }

  /* Posizione nel brano del prossimo campione in uscita (approssimata). */
  srcPos() { return this.prevS + this.idx; }

  hop(P) {
    const d = this.dsp, H = this.H, N = this.N, w = this.win;
    const L = d.L, R = d.R, len = d.len;
    const nat = this.prevS + H;
    const s = this.search(Math.round(P), nat);
    const aL = this.accL, aR = this.accR;
    if (s >= 0 && s + N <= len) {
      for (let j = 0; j < N; j++) { const g = w[j] * INV16; aL[j] += L[s + j] * g; aR[j] += R[s + j] * g; }
    } else {
      for (let j = 0; j < N; j++) {
        const k = s + j;
        if (k < 0 || k >= len) continue;
        const g = w[j] * INV16;
        aL[j] += L[k] * g; aR[j] += R[k] * g;
      }
    }
    this.outL.set(aL.subarray(0, H));
    this.outR.set(aR.subarray(0, H));
    aL.copyWithin(0, H); aR.copyWithin(0, H);
    aL.fill(0, H); aR.fill(0, H);
    this.prevS = s;
    this.idx = 0;
  }

  /* Cerca vicino a "ideal" il punto che continua meglio la forma d'onda
     che parte da "nat" (continuazione naturale del segmento precedente). */
  search(ideal, nat) {
    const d = this.dsp, M = d.M4, H = this.H;
    if (!M) return ideal;
    const q = 4, Lc = H / q, Dc = this.D / q, mlen = M.length;
    const r0 = Math.floor(nat / q), c0 = Math.floor(ideal / q);
    if (r0 < 0 || r0 + Lc > mlen) return ideal;
    let best = c0, bestSc = -Infinity;
    const lo = Math.max(0, c0 - Dc), hi = Math.min(mlen - Lc, c0 + Dc);
    for (let c = lo; c <= hi; c++) {
      let xy = 0, yy = 1e-12;
      for (let j = 0; j < Lc; j++) { const y = M[c + j]; xy += M[r0 + j] * y; yy += y * y; }
      const sc = xy / Math.sqrt(yy);
      if (sc > bestSc) { bestSc = sc; best = c; }
    }
    const L = d.L, R = d.R, len = d.len;
    let fb = best * q, fsc = -Infinity;
    if (nat < 0 || nat + H > len) return fb;
    for (let s = best * q - q; s <= best * q + q; s++) {
      if (s < 0 || s + H > len) continue;
      let xy = 0, yy = 1e-9;
      for (let j = 0; j < H; j += 2) {
        const y = L[s + j] + R[s + j];
        xy += (L[nat + j] + R[nat + j]) * y; yy += y * y;
      }
      const sc = xy / Math.sqrt(yy);
      if (sc > fsc) { fsc = sc; fb = s; }
    }
    return fb;
  }
}

/* ------------------------------------------------------------------ */
/* Il lettore vero e proprio.                                           */
/* ------------------------------------------------------------------ */
class DeckDSP {
  constructor(sr, post) {
    this.sr = sr;
    this.post = post || function () {};
    this.L = null; this.R = null; this.M4 = null; this.len = 0;
    this.pos = 0;
    this.playing = false;
    this.tempo = 1;
    this.keyLock = false;
    this.reverse = false;
    this.motor = 0;                 // 0..1 velocità del "motore" (avvio/frenata)
    this.startSec = 0;              // tempo di avvio (0 = istantaneo)
    this.brakeSec = 0;              // tempo di frenata (0 = istantaneo)
    this.minRamp = Math.round(sr * 0.003);
    // nudge (spinta sul bordo della jog)
    this.nudgeAcc = 0; this.bend = 0; this.nudgeGain = 0.12; this.maxBend = 0.6;
    // scratch
    this.touch = false;
    this.scrubLeft = 0;
    this.scratchTarget = 0;
    this.secPerRev = 1.8;           // un giro di jog = 1,8 s di brano (come un 33 giri)
    this.scratchTau = 0.008;
    this.relFrom = 0; this.relLeft = 0; this.relTotal = Math.round(sr * 0.06);
    this.curRate = 0;
    // giradischi (puck): il disco comanda il brano, come un DVS in modo relativo.
    // Puck con orario e angolo (firmware 1.1): il brano segue la POSIZIONE del disco.
    // Puck vecchi (solo giri al minuto): il brano segue la velocità.
    this.vc = false; this.vcTarget = 0; this.vcCur = 0;
    this.vcFilt = 0; this.vcPrevRaw = 0; this.vcScrUntil = 0;
    this.vcSpr = 1.8;                         // secondi di brano per giro, alla velocità di riferimento
    const VCN = 64;
    this.vcTp = new Float64Array(VCN); this.vcA = new Float64Array(VCN); this.vcW = new Float64Array(VCN);
    this.vcHead = 0; this.vcN = 0; this.vcLastArr = -1;
    this.vcMins = new Float64Array(8); this.vcMinsN = 0; this.vcMinsI = 0;
    this.vcChunkMin = 0; this.vcChunkStart = -1; this.vcOff = 0;
    this.vcLateH = new Float32Array(100); this.vcLateN = 0;
    this.vcDelay = 0.010; this.vcTau = 0.008; this.vcPct = 0.6; this.vcVS = 0;
    this.vcAnchored = false; this.vcAncPos = 0; this.vcAncA = 0; this.vcSign = 1;
    this._va = 0; this._vw = 0; this._vwl = 0; this.vcVT = 0;
    // loop
    this.loopIn = -1; this.loopOut = -1; this.loopOn = false;
    // slip
    this.slip = false; this.slipPos = 0; this.inExc = false;
    // griglia
    this.firstBeat = 0; this.beatLen = 0;
    // dissolvenza anti-click sui salti
    this.xfPos = 0; this.xfRate = 0; this.xfLeft = 0; this.xfLen = Math.max(32, Math.round(sr * 0.004));
    this._l = 0; this._r = 0;
    this.st = new Stretcher(this);
    this.repEvery = Math.round(sr * 0.015);
    this.repCount = 0;
    this.ct = 0;
    this.endSent = false;
  }

  /* ---------------- messaggi dal thread principale ---------------- */
  onMessage(m) {
    switch (m.t) {
      case 'load':
        this.L = m.L; this.R = m.R; this.M4 = m.M4 || null; this.len = m.len;
        this.playing = false; this.motor = 0; this.curRate = 0;
        this.loopOn = false; this.loopIn = -1; this.loopOut = -1;
        this.inExc = false; this.touch = false; this.scrubLeft = 0; this.bend = 0; this.nudgeAcc = 0;
        this.reverse = false; this.st.active = false; this.xfLeft = 0; this.relLeft = 0;
        this.pos = clamp(m.pos || 0, 0, this.len);
        this.endSent = false;
        this.post({ t: 'loaded', len: this.len, id: m.id });
        this.report(true);
        break;
      case 'unload':
        this.L = this.R = this.M4 = null; this.len = 0; this.pos = 0; this.playing = false; this.motor = 0;
        this.st.active = false; this.loopOn = false;
        this.report(true);
        break;
      case 'play': this.playing = true; this.endSent = false; break;
      case 'pause': this.playing = false; break;
      case 'seek': this.seek(m.to); break;
      case 'tempo': this.tempo = m.v; break;
      case 'keyLock': this.keyLock = !!m.on; break;
      case 'reverse': this.reverse = !!m.on; break;
      case 'slip': this.slip = !!m.on; if (!this.slip) this.inExc = false; break;
      case 'grid': this.firstBeat = m.first; this.beatLen = m.len; break;
      case 'vc':
        this.vc = !!m.on;
        if (this.vc) {
          this.vcCur = this.curRate; this.vcTarget = this.curRate; this.vcFilt = this.curRate;
          this.touch = false; this.bend = 0; this.nudgeAcc = 0; this.vcAnchored = false;
        } else { this.playing = false; this.vcN = 0; }
        break;
      case 'vcRate': this.vcRate(+m.r || 0); break;
      case 'vcPt': this.vcPoint(+m.tp, +m.a, +m.w || 0, !!m.reset); break;
      case 'vcCfg':
        if (m.spr > 0 && m.spr !== this.vcSpr) { this.vcSpr = +m.spr; this.vcAnchored = false; }
        if (m.pct > 0 && m.pct < 1) this.vcPct = +m.pct;     // margine contro i ritardi: 0,6 pronta, 0,9 precisa
        break;
      case 'touch':
        if (this.vc) break;               // col giradischi comanda il disco, non la jog a schermo
        if (m.on && !this.touch) { this.touch = true; this.scratchTarget = this.pos; }
        else if (!m.on && this.touch) {
          this.touch = false;
          if (this.playing) { this.relFrom = this.curRate; this.relLeft = this.relTotal; this.motor = 1; }
        }
        break;
      case 'jog': this.jog(m.d); break;
      case 'jump': this.jump(m.to, !!m.q); break;
      case 'beatJump':
        if (this.beatLen > 0) {
          const to = this.pos + m.beats * this.beatLen;
          if (this.loopOn && m.moveLoop) { const dl = m.beats * this.beatLen; this.loopIn += dl; this.loopOut += dl; }
          this.seek(to);
        }
        break;
      case 'loop':
        this.loopIn = m.in; this.loopOut = m.out; this.loopOn = !!m.on && m.out > m.in;
        this.report(true);
        break;
      case 'loopInNow': {
        this.loopIn = m.q ? this.nearestBeat(this.pos) : this.pos;
        if (this.loopOut <= this.loopIn) { this.loopOut = -1; this.loopOn = false; }
        this.report(true);
        break;
      }
      case 'loopOutNow': {
        if (this.loopIn < 0) break;
        let out = m.q ? this.nearestBeat(this.pos) : this.pos;
        if (out <= this.loopIn + 64) out = this.beatLen > 0 ? this.loopIn + this.beatLen : this.loopIn + this.sr * 0.5;
        this.loopOut = out; this.loopOn = true;
        if (this.pos >= this.loopOut) this.wrapLoop();
        this.report(true);
        break;
      }
      case 'beatLoop': {
        if (this.beatLen <= 0) break;
        const bl = this.beatLen;
        const start = m.q ? this.beatFloor(this.pos) : this.pos;
        this.loopIn = start; this.loopOut = start + m.beats * bl; this.loopOn = true;
        if (this.pos >= this.loopOut) this.wrapLoop();
        this.report(true);
        break;
      }
      case 'loopScale': {
        if (this.loopIn < 0 || this.loopOut <= this.loopIn) break;
        const nl = (this.loopOut - this.loopIn) * m.f;
        if (nl < 32) break;
        this.loopOut = this.loopIn + nl;
        if (this.loopOn && this.pos >= this.loopOut) this.wrapLoop();
        this.report(true);
        break;
      }
      case 'reloop':
        if (this.loopOn) { this.loopOn = false; }
        else if (this.loopIn >= 0 && this.loopOut > this.loopIn) {
          this.loopOn = true;
          if (this.pos < this.loopIn || this.pos >= this.loopOut) this.seek(this.loopIn);
        }
        this.report(true);
        break;
      case 'loopOff': this.loopOn = false; this.report(true); break;
      case 'mark': {
        const p = m.q ? this.nearestBeat(this.pos) : this.pos;
        this.post({ t: 'marked', id: m.id, pos: p });
        break;
      }
      case 'params':
        if (m.secPerRev) this.secPerRev = m.secPerRev;
        if (m.nudgeGain) this.nudgeGain = m.nudgeGain;
        if (m.brakeSec !== undefined) this.brakeSec = m.brakeSec;
        if (m.startSec !== undefined) this.startSec = m.startSec;
        break;
      default: break;
    }
  }

  nearestBeat(p) {
    if (this.beatLen <= 0) return p;
    const k = Math.round((p - this.firstBeat) / this.beatLen);
    return this.firstBeat + k * this.beatLen;
  }
  beatFloor(p) {
    if (this.beatLen <= 0) return p;
    const k = Math.floor((p - this.firstBeat) / this.beatLen + 1e-6);
    return this.firstBeat + k * this.beatLen;
  }

  seek(to) {
    if (!this.L) return;
    const old = this.pos;
    this.pos = clamp(to, 0, this.len);
    this.vcAncPos += this.pos - old;          // giradischi: il disco resta dov'è, il brano salta
    this.startXfade(old, this.st.active ? 1 : this.curRate);
    if (this.st.active) this.st.reset(this.pos);
    if (this.touch || this.scrubLeft > 0) this.scratchTarget = this.pos;
    this.endSent = false;
  }

  jump(to, q) {
    let dest = to;
    if (q && this.beatLen > 0 && this.playing) {
      const bl = this.beatLen;
      let dd = fmod(this.pos - this.firstBeat, bl) - fmod(to - this.firstBeat, bl);
      if (dd > bl / 2) dd -= bl; else if (dd < -bl / 2) dd += bl;
      dest = to + dd;
    }
    this.seek(dest);
  }

  jog(d) {
    if (!this.L) return;
    const frames = d * this.secPerRev * this.sr;
    if (this.touch) { this.scratchTarget += frames; return; }
    if (!this.playing) {
      if (this.scrubLeft <= 0) this.scratchTarget = this.pos;
      this.scratchTarget = clamp(this.scratchTarget + frames, 0, this.len);
      this.scrubLeft = Math.round(this.sr * 0.08);
      return;
    }
    this.nudgeAcc += d;
  }

  /* ---------------- giradischi ---------------- */

  // puck vecchi: solo velocità. Filtro: diretto su scratch e spinte, morbido a velocità costante.
  vcRate(raw) {
    const now = this.ct;
    const accel = Math.abs(raw - this.vcPrevRaw);
    this.vcPrevRaw = raw;
    const diff = Math.abs(raw - this.vcFilt);
    if (Math.abs(raw) < 0.003) {
      this.vcFilt = 0; this.vcTarget = 0;
    } else if (accel > 0.018 || diff > 0.035 || raw < 0) {
      this.vcFilt = raw; this.vcTarget = raw; this.vcScrUntil = now + 0.25;
    } else {
      this.vcFilt += (diff > 0.003 ? 0.25 : 0.05) * (raw - this.vcFilt);
      this.vcTarget = this.vcFilt;
    }
  }

  // puck con orario e angolo: tp = orario del puck (s), a = angolo del disco (giri), w = giri al secondo
  vcPoint(tp, a, w, reset) {
    const arr = this.ct;
    const N = this.vcTp.length;
    if (reset) {
      this.vcMinsN = 0; this.vcChunkStart = -1; this.vcLateH.fill(0); this.vcLateN = 0;
    }
    if (reset || this.vcN === 0 || arr - this.vcLastArr > 0.3) { this.vcN = 0; this.vcAnchored = false; }
    if (this.vcN > 0 && tp <= this.vcTp[(this.vcHead + N - 1) % N]) return;   // doppione o fuori ordine
    // orologio del puck -> orologio audio: il ritardo più piccolo degli ultimi ~4 s
    const lat = arr - tp;
    if (this.vcLateN > 0 && Math.abs(lat - this.vcOff) > 0.25) {   // orario del puck ripartito: si ricomincia
      this.vcMinsN = 0; this.vcChunkStart = -1; this.vcLateH.fill(0); this.vcLateN = 0;
      this.vcN = 0; this.vcAnchored = false;
    }
    if (this.vcChunkStart < 0 || arr - this.vcChunkStart >= 0.5) {
      if (this.vcChunkStart >= 0) {
        this.vcMins[this.vcMinsI] = this.vcChunkMin;
        this.vcMinsI = (this.vcMinsI + 1) % this.vcMins.length;
        this.vcMinsN = Math.min(this.vcMins.length, this.vcMinsN + 1);
      }
      this.vcChunkStart = arr; this.vcChunkMin = lat;
    } else if (lat < this.vcChunkMin) this.vcChunkMin = lat;
    let off = this.vcChunkMin;
    for (let k = 0; k < this.vcMinsN; k++) if (this.vcMins[k] < off) off = this.vcMins[k];
    // all'inizio si assesta in fretta, poi si muove piano (2 ms al secondo: non si sente)
    const settle = this.vcLateN < 50;
    if (this.vcN === 0 && this.vcLateN === 0) this.vcOff = off;
    else this.vcOff += clamp(off - this.vcOff, settle ? -0.0003 : -0.00002, settle ? 0.0003 : 0.00002);
    // ritardi oltre il minimo (mezzi millisecondi), con memoria di ~1,5 s
    const late = Math.max(0, lat - this.vcOff);
    const H = this.vcLateH;
    H[Math.min(H.length - 1, Math.floor(late / 0.0005))] += 1;
    if (++this.vcLateN % 25 === 0) for (let k = 0; k < H.length; k++) H[k] *= 0.85;
    let tot = 0;
    for (let k = 0; k < H.length; k++) tot += H[k];
    let acc = 0, p90 = 0;
    for (let k = 0; k < H.length; k++) { acc += H[k]; if (acc >= tot * this.vcPct) { p90 = (k + 1) * 0.0005; break; } }
    const want = clamp(p90 + 0.0015, 0.003, 0.045);
    // il margine si sposta solo quando serve davvero, e piano: ogni spostamento è un piccolo cambio di velocità
    if (settle) this.vcDelay += (want - this.vcDelay) * 0.3;
    else if (want > this.vcDelay + 0.001) this.vcDelay += Math.min(want - this.vcDelay, 0.00002);
    else if (want < this.vcDelay - 0.003) this.vcDelay -= 0.000005;
    // nuovo campione
    const i = this.vcHead;
    this.vcTp[i] = tp; this.vcA[i] = a; this.vcW[i] = w;
    this.vcHead = (i + 1) % N; this.vcN = Math.min(N, this.vcN + 1);
    this.vcLastArr = arr;
  }

  // angolo e velocità del disco all'orario tq del puck (Hermite tra due campioni, oltre l'ultimo prosegue dritto)
  vcEval(tq) {
    const N = this.vcTp.length, n = this.vcN, h0 = this.vcHead;
    const T = this.vcTp, A = this.vcA, W = this.vcW;
    let i1 = (h0 + N - 1) % N;
    if (tq >= T[i1]) { this._va = A[i1] + W[i1] * (tq - T[i1]); this._vw = W[i1]; this._vwl = W[i1]; return; }
    for (let k = 1; k < n; k++) {
      const i0 = (h0 + N - 1 - k) % N;
      if (tq >= T[i0]) {
        const h = T[i1] - T[i0], s = (tq - T[i0]) / h, s2 = s * s, s3 = s2 * s;
        const p0 = A[i0], p1 = A[i1], m0 = W[i0] * h, m1 = W[i1] * h;
        this._va = (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
        this._vw = ((6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * m0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * m1) / h;
        this._vwl = W[i0] + (W[i1] - W[i0]) * s;     // velocità misurata dal puck, interpolata
        return;
      }
      i1 = i0;
    }
    this._va = A[i1]; this._vw = 0; this._vwl = 0;
  }

  startXfade(oldPos, oldRate) {
    this.xfPos = oldPos;
    this.xfRate = oldRate;
    this.xfLeft = this.xfLen;
  }

  wrapLoop() {
    const old = this.pos;
    const ll = this.loopOut - this.loopIn;
    let p = this.loopIn + fmod(this.pos - this.loopOut, ll);
    if (p >= this.loopOut) p = this.loopIn;
    this.pos = p;
    this.vcAncPos += p - old;
    this.startXfade(old, this.st.active ? 1 : this.curRate);
    if (this.st.active) this.st.reset(this.pos);
  }

  /* Legge un campione stereo con interpolazione cubica (Hermite). */
  read(p) {
    const L = this.L, R = this.R, len = this.len;
    const i = Math.floor(p), f = p - i;
    if (i < 1 || i + 2 >= len) {
      let l = 0, r = 0;
      if (i >= 0 && i < len) { l = L[i] * INV16; r = R[i] * INV16; }
      this._l = l; this._r = r;
      return;
    }
    let y0 = L[i - 1], y1 = L[i], y2 = L[i + 1], y3 = L[i + 2];
    let c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    this._l = (((c3 * f + c2) * f + c1) * f + y1) * INV16;
    y0 = R[i - 1]; y1 = R[i]; y2 = R[i + 1]; y3 = R[i + 2];
    c1 = 0.5 * (y2 - y0); c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3; c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    this._r = (((c3 * f + c2) * f + c1) * f + y1) * INV16;
  }

  /* ---------------------- elaborazione audio ---------------------- */
  process(oL, oR, n, ct) {
    if (!this.L) {
      for (let i = 0; i < n; i++) { oL[i] = 0; oR[i] = 0; }
      this.ct = ct + n / this.sr;
      this.repCount += n;
      this.report(false);
      return;
    }
    const sr = this.sr, st = this.st;
    this.ct = ct + n / sr;
    this.repCount += n;
    const blockSec = n / sr;

    // spinta sulla jog -> variazione di velocità temporanea
    if (this.nudgeAcc !== 0 || this.bend !== 0) {
      const vel = this.nudgeAcc / blockSec;
      this.nudgeAcc = 0;
      const target = clamp(vel * this.nudgeGain, -this.maxBend, this.maxBend);
      const k = 1 - Math.exp(-blockSec / 0.025);
      this.bend += (target - this.bend) * k;
      if (target === 0 && Math.abs(this.bend) < 1e-4) this.bend = 0;
    }

    const vcPos = this.vc && this.vcN > 0;
    if (vcPos) {
      // posizione del disco qualche millesimo fa (margine contro i ritardi del Bluetooth)
      this.vcEval(this.ct - this.vcOff - this.vcDelay);
      const sgn = this.reverse ? -1 : 1;
      const vRaw = this._vw * this.vcSpr * sgn;          // dalla traiettoria (segue ogni dettaglio)
      const vM = this._vwl * this.vcSpr * sgn;           // misurata dal puck (più liscia)
      // scratch, presa del disco, spinte forti: velocità lontana dalla normale o che cambia in fretta
      if (Math.abs(vM - 1) > 0.15 || Math.abs(vM - this.vcVT) > 0.03) this.vcScrUntil = this.ct + 0.25;
      // a velocità costante si usa la velocità misurata dal puck (più liscia della traiettoria), ammorbidita;
      // un cambio vero (spinta, pitch) si segue in 5 ms
      if (this.ct < this.vcScrUntil) this.vcVS = vRaw;
      else this.vcVS += (vM - this.vcVS) * (1 - Math.exp(-blockSec / (Math.abs(vM - this.vcVS) > 0.003 ? 0.005 : 0.03)));
      this.vcVT = this.vcVS;
      this.vcCur = this.vcVT;
      this.bend = 0; this.relLeft = 0; this.motor = 1;
    } else if (this.vc) {
      // puck vecchi: velocità del disco, quasi diretta durante lo scratch
      const tau = this.ct < this.vcScrUntil ? 0.002 : 0.012;
      this.vcCur += (this.vcTarget - this.vcCur) * (1 - Math.exp(-blockSec / tau));
      if (this.vcTarget === 0 && Math.abs(this.vcCur) < 0.003) this.vcCur = 0;
      this.playing = Math.abs(this.vcCur) > 0.005;
      this.bend = 0; this.relLeft = 0; this.motor = 1;
    }
    const scratching = this.touch || this.scrubLeft > 0;
    if (this.vc && scratching) this.vcAnchored = false;   // jog a schermo a disco fermo: poi si riaggancia
    if (this.scrubLeft > 0) this.scrubLeft -= n;

    // slip: la posizione "ombra" continua ad avanzare mentre fai scratch, reverse o loop
    const exc = this.slip && (scratching || this.reverse || this.loopOn);
    if (exc && !this.inExc) { this.inExc = true; this.slipPos = this.pos; }
    if (this.inExc) {
      if (this.playing) this.slipPos += (this.vc ? Math.abs(this.vcCur) : this.tempo) * n;
      if (!exc) {
        this.inExc = false;
        const old = this.pos;
        this.pos = clamp(this.slipPos, 0, this.len);
        this.vcAncPos += this.pos - old;
        this.startXfade(old, st.active ? 1 : this.curRate);
        if (st.active) st.reset(this.pos);
      }
    }

    const base = (this.vc ? this.vcCur : this.tempo * (1 + this.bend)) * (this.reverse ? -1 : 1);
    let r0 = this.curRate, r1;
    if (scratching) {
      const err = this.scratchTarget - this.pos;
      r1 = clamp(err / Math.max(n, this.scratchTau * sr), -14, 14);
      this.motor = this.playing ? 1 : 0;
    } else if (vcPos) {
      // il brano insegue la posizione del disco: velocità del disco + correzione dell'errore
      const sign = this.reverse ? -1 : 1;
      if (!this.vcAnchored || sign !== this.vcSign) {
        this.vcAncPos = this.pos; this.vcAncA = this._va; this.vcAnchored = true; this.vcSign = sign;
      }
      const spr = this.vcSpr * sr;
      let tgt = this.vcAncPos + sign * (this._va - this.vcAncA) * spr;
      if (tgt < 0) { this.vcAncPos -= tgt; tgt = 0; } else if (tgt > this.len) { this.vcAncPos -= tgt - this.len; tgt = this.len; }
      const vT = this.vcVT;
      const e = tgt - (this.pos + 0.5 * n * (r0 + vT));
      if (Math.abs(e) > 0.004 * sr) this.vcScrUntil = this.ct + 0.25;
      // durante lo scratch l'errore si recupera in 8 ms; a velocità costante in 0,2 s (niente tremolio)
      const tau = this.ct < this.vcScrUntil ? this.vcTau : 0.2;
      r1 = clamp(vT + e / Math.max(n, tau * sr), -16, 16);
      if (Math.abs(r1) < 1e-4 && Math.abs(vT) < 1e-4) r1 = 0;
      this.playing = Math.abs(vT) > 0.02 || Math.abs(r1) > 0.05;
    } else if (this.vc) {
      r1 = base;
    } else {
      // rampa del motore (avvio / frenata)
      const want = this.playing ? 1 : 0;
      if (this.motor !== want) {
        const rampS = want > this.motor ? Math.max(this.minRamp, this.startSec * sr) : Math.max(this.minRamp, this.brakeSec * sr);
        const stepB = n / rampS;
        this.motor = want > this.motor ? Math.min(1, this.motor + stepB) : Math.max(0, this.motor - stepB);
      }
      r1 = base * this.motor;
      if (this.relLeft > 0) {
        const a = 1 - this.relLeft / this.relTotal;
        r1 = this.relFrom + (r1 - this.relFrom) * Math.min(1, a + n / this.relTotal);
        this.relLeft = Math.max(0, this.relLeft - n);
      }
    }

    // key lock: col giradischi solo vicino alla velocità normale e non durante scratch e spinte forti
    const useStretch = this.keyLock && !scratching && this.relLeft === 0 && this.motor >= 1 &&
      !this.reverse && this.playing && Math.abs(base - 1) > 2e-4 &&
      (!this.vc || (this.ct >= this.vcScrUntil && Math.abs(base - 1) < 0.15));

    if (useStretch && !st.active) st.reset(this.pos);
    else if (!useStretch && st.active) { this.startXfade(st.srcPos(), 1); st.active = false; }

    const len = this.len;
    const loopOn = this.loopOn, lIn = this.loopIn, lOut = this.loopOut;
    const xfLen = this.xfLen;

    for (let i = 0; i < n; i++) {
      const rate = r0 + (r1 - r0) * ((i + 1) / n);
      let l, r;
      if (st.active) {
        if (st.idx >= st.H) st.hop(this.pos);
        l = st.outL[st.idx]; r = st.outR[st.idx]; st.idx++;
      } else if (rate !== 0 || this.xfLeft > 0) {
        this.read(this.pos); l = this._l; r = this._r;
      } else {
        l = 0; r = 0;
      }
      if (this.xfLeft > 0) {
        const a = this.xfLeft / xfLen;
        this.read(this.xfPos);
        l = l * (1 - a) + this._l * a;
        r = r * (1 - a) + this._r * a;
        this.xfPos += this.xfRate;
        this.xfLeft--;
      }
      oL[i] = l; oR[i] = r;
      this.pos += rate;
      if (loopOn && rate > 0 && this.pos >= lOut && lOut > lIn) this.wrapLoop();
      if (this.pos >= len) {
        this.pos = len;
        if (this.playing && !scratching) { this.playing = false; this.motor = 0; r1 = 0; r0 = 0; }
      } else if (this.pos < 0) { this.pos = 0; }
    }
    this.curRate = r1;
    if (this.pos >= len && !this.endSent) { this.endSent = true; this.post({ t: 'end' }); }
    this.report(false);
  }

  report(force) {
    if (!force && this.repCount < this.repEvery) return;
    this.repCount = 0;
    this.post({
      t: 'pos', p: this.pos, r: this.curRate, pl: this.playing, ct: this.ct,
      lo: this.loopOn, li: this.loopIn, lt: this.loopOut,
      sl: this.inExc, sp: this.slipPos, sc: this.touch || this.scrubLeft > 0,
      kl: this.st.active, b: this.bend, vc: this.vc ? this.vcCur : null
    });
  }
}

/* ------------------------------------------------------------------ */
if (typeof registerProcessor === 'function') {
  class SolcoProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new DeckDSP(sampleRate, (m) => this.port.postMessage(m));
      this.port.onmessage = (e) => this.dsp.onMessage(e.data);
    }
    process(inputs, outputs) {
      const out = outputs[0];
      const l = out[0], r = out[1] || out[0];
      this.dsp.process(l, r, l.length, currentTime);
      return true;
    }
  }
  registerProcessor('solco-deck', SolcoProcessor);
}
if (typeof module !== 'undefined' && module.exports) module.exports = { DeckDSP, Stretcher };
if (typeof window !== 'undefined') window.SolcoDSP = { DeckDSP };
