/*
 * SOLCO — analisi del brano: forma d'onda a 3 bande, BPM e griglia, tonalità.
 * Funziona come Web Worker; se il worker non è disponibile la stessa funzione
 * viene usata nel thread principale (window.SolcoAnalysis.analyze).
 */
'use strict';
(function (root) {

  const CPS = 150; // colonne di forma d'onda al secondo

  /* ---------------- filtri biquad (RBJ) ---------------- */
  function biquad(type, f0, sr, Q) {
    Q = Q || Math.SQRT1_2;
    const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * Q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; } // passa banda
    const a0 = 1 + a;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * c) / a0, a2: (1 - a) / a0, z1: 0, z2: 0 };
  }
  // forma trasposta II: y = b0 x + z1 ; z1 = b1 x - a1 y + z2 ; z2 = b2 x - a2 y

  /* ---------------- FFT radix-2 ---------------- */
  function makeFFT(N) {
    const rev = new Uint32Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
    return function fft(re, im) {
      for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const tr = re[b] * cos[k] - im[b] * sin[k];
            const ti = re[b] * sin[k] + im[b] * cos[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  /* ---------------- forma d'onda ---------------- */
  function waveform(x, sr) {
    const colLen = sr / CPS;
    const cols = Math.ceil(x.length / colLen);
    const lo = new Uint8Array(cols), mi = new Uint8Array(cols), hi = new Uint8Array(cols), pk = new Uint8Array(cols);
    const f1 = biquad('lp', 180, sr), f2 = biquad('hp', 2600, sr);
    let col = 0, next = colLen, mL = 0, mM = 0, mH = 0, mP = 0;
    const enc = (v) => { v = v > 1 ? 1 : v; return Math.round(255 * Math.pow(v, 0.85)); };
    let z11 = 0, z12 = 0, z21 = 0, z22 = 0;
    const a = f1, b = f2;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const l = a.b0 * v + z11; z11 = a.b1 * v - a.a1 * l + z12; z12 = a.b2 * v - a.a2 * l;
      const h = b.b0 * v + z21; z21 = b.b1 * v - b.a1 * h + z22; z22 = b.b2 * v - b.a2 * h;
      const m = v - l - h;
      const al = l < 0 ? -l : l, am = m < 0 ? -m : m, ah = h < 0 ? -h : h, ap = v < 0 ? -v : v;
      if (al > mL) mL = al; if (am > mM) mM = am; if (ah > mH) mH = ah; if (ap > mP) mP = ap;
      if (i + 1 >= next) {
        lo[col] = enc(mL); mi[col] = enc(mM * 1.15); hi[col] = enc(mH * 1.4); pk[col] = enc(mP);
        col++; next += colLen; mL = mM = mH = mP = 0;
      }
    }
    if (col < cols) { lo[col] = enc(mL); mi[col] = enc(mM * 1.15); hi[col] = enc(mH * 1.4); pk[col] = enc(mP); }
    return { lo, mi, hi, pk, cps: CPS };
  }

  /* ---------------- decimazione (per BPM e tonalità) ---------------- */
  function decimate(x, sr) {
    const q = Math.max(1, Math.round(sr / 12000));
    const sr2 = sr / q;
    const f1 = biquad('lp', 0.36 * sr2, sr, 0.54), f2 = biquad('lp', 0.36 * sr2, sr, 1.31);
    const y = new Float32Array(Math.floor(x.length / q));
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0, j = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const u = f1.b0 * v + a1; a1 = f1.b1 * v - f1.a1 * u + a2; a2 = f1.b2 * v - f1.a2 * u;
      const w = f2.b0 * u + b1; b1 = f2.b1 * u - f2.a1 * w + b2; b2 = f2.b2 * u - f2.a2 * w;
      if (i % q === q - 1 && j < y.length) y[j++] = w;
    }
    return { y, sr2 };
  }

  /* ---------------- inviluppo degli attacchi ---------------- */
  function onsetEnvelope(y, sr2) {
    const fps = 200;
    const hop = sr2 / fps;
    const T = Math.floor(y.length / hop) - 2;
    const fl = biquad('lp', 140, sr2), fh = biquad('hp', 2200, sr2), fm = biquad('bp', 600, sr2, 0.8);
    const eL = new Float32Array(T), eH = new Float32Array(T), eM = new Float32Array(T);
    let l1 = 0, l2 = 0, h1 = 0, h2 = 0, m1 = 0, m2 = 0;
    let t = 0, acc = 0, accH = 0, accM = 0, cnt = 0, next = hop;
    for (let i = 0; i < y.length && t < T; i++) {
      const v = y[i];
      const l = fl.b0 * v + l1; l1 = fl.b1 * v - fl.a1 * l + l2; l2 = fl.b2 * v - fl.a2 * l;
      const h = fh.b0 * v + h1; h1 = fh.b1 * v - fh.a1 * h + h2; h2 = fh.b2 * v - fh.a2 * h;
      const m = fm.b0 * v + m1; m1 = fm.b1 * v - fm.a1 * m + m2; m2 = fm.b2 * v - fm.a2 * m;
      acc += l * l; accH += h * h; accM += m * m; cnt++;
      if (i + 1 >= next) { eL[t] = acc / cnt; eH[t] = accH / cnt; eM[t] = accM / cnt; t++; acc = accH = accM = 0; cnt = 0; next += hop; }
    }
    // compressione logaritmica e derivata positiva
    const norm = (e) => { let mx = 1e-12; for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i]; return mx; };
    const nL = norm(eL), nH = norm(eH), nM = norm(eM);
    const o = new Float32Array(T);
    let pL = 0, pH = 0, pM = 0;
    for (let i = 0; i < T; i++) {
      const cL = Math.log(1 + 1000 * eL[i] / nL), cH = Math.log(1 + 1000 * eH[i] / nH), cM = Math.log(1 + 1000 * eM[i] / nM);
      const dL = cL - pL, dH = cH - pH, dM = cM - pM;
      o[i] = (dL > 0 ? dL : 0) + 0.5 * (dH > 0 ? dH : 0) + 0.35 * (dM > 0 ? dM : 0);
      pL = cL; pH = cH; pM = cM;
    }
    // sottrae una media mobile (soglia adattiva)
    const W = 40, out = new Float32Array(T);
    let s = 0;
    for (let i = 0; i < T; i++) {
      s += o[i]; if (i >= W) s -= o[i - W];
      const mean = s / Math.min(i + 1, W);
      const v = o[i] - mean;
      out[i] = v > 0 ? v : 0;
    }
    return { o: out, fps, hop };
  }

  /* ---------------- tempo e griglia ---------------- */
  function tempoAndGrid(env, firstSoundSec) {
    const o = env.o, fps = env.fps, T = o.length;
    if (T < fps * 8) return null;
    // autocorrelazione
    const lagMin = Math.floor(60 * fps / 200), lagMax = Math.ceil(60 * fps / 60) * 2 + 2;
    let mean = 0; for (let i = 0; i < T; i++) mean += o[i]; mean /= T;
    const z = new Float32Array(T); for (let i = 0; i < T; i++) z[i] = o[i] - mean;
    const acf = new Float32Array(lagMax + 1);
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let s = 0; for (let i = 0; i + lag < T; i++) s += z[i] * z[i + lag];
      acf[lag] = s / (T - lag);
    }
    let best = -Infinity, bestLag = 0;
    for (let lag = lagMin; lag <= Math.ceil(60 * fps / 60); lag++) {
      const bpm = 60 * fps / lag;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 126) / 0.42, 2));
      const sc = (acf[lag] + 0.5 * (acf[2 * lag] || 0) + 0.25 * (acf[Math.round(lag / 2)] || 0)) * prior;
      if (sc > best) { best = sc; bestLag = lag; }
    }
    // interpolazione parabolica
    let lagF = bestLag;
    if (bestLag > lagMin && bestLag < lagMax) {
      const a = acf[bestLag - 1], b = acf[bestLag], c = acf[bestLag + 1];
      const den = a - 2 * b + c;
      if (den !== 0) lagF = bestLag + 0.5 * (a - c) / den;
    }
    let bpm0 = 60 * fps / lagF;
    // ricerca fine: istogramma della fase per ciascun BPM candidato
    const B = 120, hist = new Float32Array(B);
    let bestBpm = bpm0, bestScore = -Infinity, bestPhase = 0;
    const score = (bpm, keep) => {
      const P = 60 * fps / bpm;
      hist.fill(0);
      for (let i = 0; i < T; i++) {
        if (o[i] === 0) continue;
        const ph = (i % P) / P;
        hist[Math.floor(ph * B) % B] += o[i];
      }
      let tot = 0, mx = -1, mi = 0;
      for (let k = 0; k < B; k++) {
        tot += hist[k];
        const v = hist[(k + B - 1) % B] * 0.5 + hist[k] + hist[(k + 1) % B] * 0.5;
        if (v > mx) { mx = v; mi = k; }
      }
      const sc = mx / (tot / B + 1e-9);
      if (keep) {
        const a = hist[(mi + B - 1) % B], b = hist[mi], c = hist[(mi + 1) % B];
        const den = a - 2 * b + c;
        const off = den !== 0 ? 0.5 * (a - c) / den : 0;
        bestPhase = ((mi + 0.5 + off) / B) * P; // in frame dell'inviluppo
      }
      return sc;
    };
    for (let bpm = bpm0 - 1.6; bpm <= bpm0 + 1.6; bpm += 0.02) {
      const sc = score(bpm, false);
      if (sc > bestScore) { bestScore = sc; bestBpm = bpm; }
    }
    let bpm = bestBpm;
    const rounded = Math.round(bpm);
    if (Math.abs(bpm - rounded) < 0.06) bpm = rounded; else bpm = Math.round(bpm * 100) / 100;
    score(bpm, true);
    const period = 60 / bpm;
    const phaseSec = bestPhase / fps; // inizio del frame in cui arriva l'attacco
    // la battuta 1 è quella più vicina al primo suono
    let k0 = Math.round((Math.max(0, firstSoundSec) - phaseSec) / period);
    let gridStart = phaseSec + k0 * period;
    if (gridStart < -period / 2) gridStart += period * Math.ceil((-gridStart) / period);
    return { bpm, gridStart, confidence: bestScore };
  }

  /* ---------------- tonalità ---------------- */
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const CAM_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  const CAM_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  const NAME_MAJ = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const NAME_MIN = ['Cm', 'C♯m', 'Dm', 'E♭m', 'Em', 'Fm', 'F♯m', 'Gm', 'G♯m', 'Am', 'B♭m', 'Bm'];

  function keyInfo(pc, minor) {
    return { pc, minor, name: minor ? NAME_MIN[pc] : NAME_MAJ[pc], camelot: (minor ? CAM_MIN[pc] : CAM_MAJ[pc]) + (minor ? 'A' : 'B') };
  }

  function detectKey(y, sr2) {
    const N = 4096, fft = makeFFT(N);
    const re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const kMin = Math.ceil(55 * N / sr2), kMax = Math.min(N / 2 - 1, Math.floor(1760 * N / sr2));
    const pcOf = new Int8Array(N / 2), wOf = new Float32Array(N / 2);
    for (let k = kMin; k <= kMax; k++) {
      const f = k * sr2 / N, p = 12 * Math.log2(f / 440) + 69, rp = Math.round(p);
      pcOf[k] = ((rp % 12) + 12) % 12;
      wOf[k] = Math.max(0, 1 - 2 * Math.abs(p - rp));
    }
    const chroma = new Float64Array(12);
    const frame = new Float64Array(12);
    for (let s = 0; s + N <= y.length; s += N) {
      for (let i = 0; i < N; i++) { re[i] = y[s + i] * win[i]; im[i] = 0; }
      fft(re, im);
      frame.fill(0);
      for (let k = kMin; k <= kMax; k++) frame[pcOf[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]) * wOf[k];
      let mx = 0; for (let c = 0; c < 12; c++) if (frame[c] > mx) mx = frame[c];
      if (mx <= 1e-6) continue;
      for (let c = 0; c < 12; c++) chroma[c] += frame[c] / mx;
    }
    const corr = (prof, rot) => {
      let mx = 0, my = 0;
      for (let i = 0; i < 12; i++) { mx += chroma[(i + rot) % 12]; my += prof[i]; }
      mx /= 12; my /= 12;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < 12; i++) {
        const a = chroma[(i + rot) % 12] - mx, b = prof[i] - my;
        sxy += a * b; sxx += a * a; syy += b * b;
      }
      return sxy / Math.sqrt(sxx * syy + 1e-12);
    };
    let best = -2, second = -2, bestPc = 0, bestMinor = false;
    for (let pc = 0; pc < 12; pc++) {
      for (const minor of [false, true]) {
        const c = corr(minor ? KK_MIN : KK_MAJ, pc);
        if (c > best) { second = best; best = c; bestPc = pc; bestMinor = minor; }
        else if (c > second) second = c;
      }
    }
    const info = keyInfo(bestPc, bestMinor);
    info.confidence = best - second;
    return info;
  }

  /* ---------------- analisi completa ---------------- */
  function analyze(mono, sr, progress) {
    const say = progress || function () {};
    const n = mono.length;
    const wave = waveform(mono, sr);
    say(0.35);
    // primo suono e volume medio
    let firstSound = 0;
    for (let c = 0; c < wave.pk.length; c++) { if (wave.pk[c] > 14) { firstSound = c / CPS; break; } }
    let rs = 0; const stp = 7;
    for (let i = 0; i < n; i += stp) rs += mono[i] * mono[i];
    const rms = Math.sqrt(rs / Math.max(1, Math.floor(n / stp)));
    const { y, sr2 } = decimate(mono, sr);
    say(0.55);
    const env = onsetEnvelope(y, sr2);
    const grid = tempoAndGrid(env, firstSound);
    say(0.8);
    const key = detectKey(y, sr2);
    say(1);
    return {
      duration: n / sr, wave, firstSound, rms,
      bpm: grid ? grid.bpm : 0, gridStart: grid ? grid.gridStart : 0, bpmConfidence: grid ? grid.confidence : 0,
      key
    };
  }

  const api = { analyze, keyInfo, CPS };
  const isWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
  if (isWorker) {
    self.onmessage = (e) => {
      const m = e.data;
      if (m.t !== 'analyze') return;
      try {
        const res = analyze(m.mono, m.sr, (p) => self.postMessage({ t: 'progress', id: m.id, p }));
        const w = res.wave;
        self.postMessage({ t: 'done', id: m.id, res }, [w.lo.buffer, w.mi.buffer, w.hi.buffer, w.pk.buffer]);
      } catch (err) {
        self.postMessage({ t: 'error', id: m.id, message: String(err && err.message || err) });
      }
    };
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SolcoAnalysis = api;
  }
})(typeof self !== 'undefined' ? self : this);
