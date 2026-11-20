// Simulazione del giradischi col puck: disco vero → puck (giroscopio a 800 Hz) → Bluetooth con ritardi
// irregolari → app (midi.js) → motore audio. Misura ritardo, scivolamento del punto e tremolio del tempo.
// Uso: node tests/vc_sim.js [worklet alternativo da confrontare]
'use strict';
global.self = global;
const path = require('path');
require('../web/js/midi.js');
const SolcoMidi = self.SolcoMidi;
const SR = 48000, BLK = 128, BASE = 100 / 3, SPR = 60 / BASE;

// ---------------- generatore pseudo-casuale ripetibile ----------------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// ---------------- il disco: velocità vera (giri/s) nel tempo ----------------
const W0 = BASE / 60;
const T_END = 12.0;
const SCR1 = [5.6, 8.0, 2.5, 0.14];   // inizio, fine, frequenza, ampiezza (giri): avanti e indietro, torna al punto
const SCR2 = [8.0, 9.0, 4.0, 0.10];
function scratchVel(t, [a, b, f, A]) { if (t < a || t >= b) return null; return A * Math.PI * f * Math.sin(2 * Math.PI * f * (t - a)); }
function smooth01(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
function omega(t) {
  let pitch = 1 + 0.0005 * Math.sin(2 * Math.PI * 0.55 * t);                    // wow del giradischi
  if (t >= 2 && t < 3) pitch *= 1 + 0.03 * (t - 2); else if (t >= 3) pitch *= 1.03; // pitch fader +3%
  if (t >= 4 && t < 4.4) pitch *= 1 - 0.05 * Math.sin(Math.PI * (t - 4) / 0.4);     // spinta sul bordo
  const plat = W0 * pitch;
  if (t >= 5.0 && t < 5.6) return plat * (1 - smooth01((t - 5.0) / 0.05)) + 0.002 * 2 * Math.PI * 7 * Math.cos(2 * Math.PI * 7 * t) * smooth01((t - 5.05) / 0.05) * (t < 5.55 ? 1 : 0);
  const s1 = scratchVel(t, SCR1); if (s1 !== null) return s1;
  const s2 = scratchVel(t, SCR2); if (s2 !== null) return s2;
  if (t >= 9.0 && t < 9.3) return 0;
  if (t >= 9.3) return plat * smooth01((t - 9.3) / 0.08);
  return plat;
}
// angolo (giri) integrato finemente
const DT = 1 / 8000, NT = Math.ceil(T_END / DT) + 2;
const theta = new Float64Array(NT);
for (let i = 1; i < NT; i++) theta[i] = theta[i - 1] + omega((i - 0.5) * DT) * DT;
const thetaAt = (t) => { const x = Math.max(0, t / DT), i = Math.min(NT - 2, Math.floor(x)), f = x - i; return theta[i] + (theta[i + 1] - theta[i]) * f; };

// ---------------- il puck (stessa logica del firmware) ----------------
function puckPackets(fw, seed) {
  const r = rng(seed), out = [];
  const clk = (t) => (t * (1 + 40e-6) + 7.3);           // orologio del puck: sfasato e un po' più veloce
  const bias = 0.4, biasErr = 0.02;                       // °/s
  let acc = 0, n = 0, rpmOut = 0, revs = 0, lastT = -1, angT = 0, nextSend = 0.0, lastMove = 0;
  for (let k = 0; k * (1 / 800) < T_END; k++) {
    const t = k / 800;
    const dps = omega(t) * 360 + bias + 0.13 * gauss(r);
    const gz = Math.round(dps / 0.061) * 0.061;           // risoluzione del BMI270 a ±2000 °/s
    if (lastT >= 0) { const rps = (gz - (bias + biasErr)) / 360; if (Math.abs(rps * 60) >= 0.05) revs += rps * (t - lastT); }
    lastT = t; angT = clk(t);
    acc += gz; n++;
    if (t >= nextSend) {
      const dps10 = acc / n; acc = 0; n = 0;
      const rpm = (dps10 - (bias + biasErr)) / 6;
      const d = rpm - rpmOut;
      if (Math.abs(d) > 0.6) rpmOut = rpm; else rpmOut += 0.25 * d;
      const o = Math.abs(rpmOut) < 0.05 ? 0 : rpmOut;
      if (o !== 0) lastMove = t;
      const tUnits = Math.floor(angT * 1e4);
      out.push({ t, msgs: fw === '1.1' ? SolcoMidi.puckBytes(o, tUnits, revs) : SolcoMidi.puckBytes(o) });
      nextSend = t + ((o === 0 && t - lastMove > 2) ? 0.05 : 0.01);
    }
  }
  return out;
}

// ---------------- Bluetooth + Android + pagina: ritardi irregolari ----------------
function deliver(packets, seed, ci) {
  const r = rng(seed), phase = r() * ci;
  let last = 0;
  const res = [];
  let ev = phase, q = [];
  let i = 0;
  while (i < packets.length || q.length) {
    while (i < packets.length && packets[i].t <= ev) { if (q.length < 12) q.push(packets[i]); i++; }   // buffer del puck pieno: si perde
    const take = q.splice(0, 4);                          // al massimo 4 pacchetti per evento di collegamento
    if (take.length) {
      let d = 0.002 + -Math.log(1 - r()) * 0.0015;          // Android + pagina
      if (r() < 0.03) d += 0.01 + r() * 0.02;               // pagina occupata a disegnare
      const at = Math.max(last, ev + d); last = at;
      for (const p of take) res.push({ at, msgs: p.msgs });
    }
    ev += ci;
    if (i >= packets.length && !q.length) break;
  }
  return res;
}

// ---------------- un giro completo ----------------
function simulate(DSPmod, fw, seed, ci, pct, probe) {
  const { DeckDSP } = DSPmod;
  const len = SR * 40;
  const L = new Int16Array(len), R = new Int16Array(len);
  const d = new DeckDSP(SR, () => {});
  if (pct) d.vcPct = pct;
  d.onMessage({ t: 'load', L, R, M4: new Float32Array(len / 4), len, pos: SR * 5 });
  const midi = new SolcoMidi.Midi(() => {});
  const toDsp = [];
  let on = false;
  midi.onPuck = (m) => {
    if (m.rpm === undefined) return;
    if (!on) { on = true; toDsp.push({ at: m.ts / 1000, m: { t: 'vc', on: true } }); toDsp.push({ at: m.ts / 1000, m: { t: 'vcCfg', spr: SPR } }); }
    if (m.tp !== undefined) toDsp.push({ at: m.ts / 1000 + 0.0005, m: { t: 'vcPt', tp: m.tp, a: m.a, w: m.rpm / 60, reset: m.reset } });
    else toDsp.push({ at: m.ts / 1000 + 0.0005, m: { t: 'vcRate', r: m.rpm / BASE } });
  };
  for (const p of deliver(puckPackets(fw, seed), seed + 1, ci)) for (const b of p.msgs) midi.handle(b, p.at * 1000);
  toDsp.sort((a, b) => a.at - b.at);
  const nb = Math.floor(T_END * SR / BLK);
  const pos = new Float64Array(nb + 1), rate = new Float64Array(nb);
  const l = new Float32Array(BLK), rr = new Float32Array(BLK);
  let k = 0;
  pos[0] = d.pos;
  for (let b = 0; b < nb; b++) {
    const t0 = b * BLK / SR;
    while (k < toDsp.length && toDsp[k].at <= t0) d.onMessage(toDsp[k++].m);
    d.process(l, rr, BLK, t0);
    pos[b + 1] = d.pos; rate[b] = d.curRate;
    if (probe) probe(d, b);
  }
  return { pos, rate };
}

// ---------------- misure ----------------
function measure({ pos, rate }) {
  const bt = (b) => b * BLK / SR;                         // tempo alla fine del blocco b-1 = inizio di b
  const nb = rate.length;
  // ritardo: la velocità del brano somiglia di più a quella del disco spostata di L
  let bestL = 0, bestE = Infinity;
  for (let L = 0; L <= 0.12; L += 0.0005) {
    let e = 0;
    for (let b = Math.floor(5.7 * SR / BLK); b < Math.floor(8.9 * SR / BLK); b++) { const x = rate[b] - omega(bt(b + 1) - L) * SPR; e += x * x; }
    if (e < bestE) { bestE = e; bestL = L; }
  }
  const P = (t) => pos[Math.round(t * SR / BLK)];
  const ms = (s) => s / SR * 1000;
  // disco fermo prima (5,59 s) e dopo (9,25 s) gli scratch: il brano deve essersi spostato quanto il disco
  const drift = ms((P(9.25) - P(5.59)) - (thetaAt(9.25) - thetaAt(5.59)) * SPR * SR);
  const ref = P(5.45), th0 = thetaAt(5.45 - bestL);
  let se = 0, cnt = 0;
  for (let b = Math.floor(5.7 * SR / BLK); b < Math.floor(8.95 * SR / BLK); b++) {
    const want = ref + (thetaAt(bt(b + 1) - bestL) - th0) * SPR * SR;
    se += (pos[b + 1] - want) ** 2; cnt++;
  }
  const trackRms = ms(Math.sqrt(se / cnt));
  // tremolio del tempo a velocità costante (10–12 s): scarto dalla media su 100 ms
  let jit = 0, jc = 0, meanErr = 0;
  const w = Math.round(0.1 * SR / BLK);
  for (let b = Math.floor(10 * SR / BLK); b < nb - w; b++) {
    let m = 0; for (let k = -w; k <= w; k++) m += rate[b + k]; m /= 2 * w + 1;
    jit += (rate[b] - m) ** 2; jc++;
    meanErr += rate[b] - omega(bt(b + 1) - bestL) * SPR;
  }
  // scivolamento nel mix: dopo pitch fader e spinta, rispetto a dove dovrebbe essere (1 s → 4,9 s)
  const mixDrift = ms((P(4.9) - P(1.0)) - (thetaAt(4.9 - bestL) - thetaAt(1.0 - bestL)) * SPR * SR);
  return { L: bestL * 1000, drift, trackRms, jitter: Math.sqrt(jit / jc) * 100, speedErr: meanErr / jc * 100, mixDrift };
}

const NEW = require('../web/js/worklet.js');
if (process.env.PROBE) {
  // diagnosi: da dove viene il tremolio a velocità costante
  const rows = [];
  simulate(NEW, '1.1', 115, 0.015, 0, (d, b) => { if (b * BLK / SR > 10) rows.push([d.vcVT, d._vw * d.vcSpr, d.curRate, d.vcDelay, d.vcOff, d.ct < d.vcScrUntil ? 1 : 0]); });
  const sd = (k) => { const m = rows.reduce((a, r) => a + r[k], 0) / rows.length; return Math.sqrt(rows.reduce((a, r) => a + (r[k] - m) ** 2, 0) / rows.length); };
  if (process.env.PROBE === '3') {
    const r = simulate(NEW, '1.1', +(process.env.SEED || 115), 0.015, 0);
    const w = Math.round(0.1 * SR / BLK), dev = [];
    for (let b = Math.floor(10 * SR / BLK); b < r.rate.length - w; b++) {
      let m = 0; for (let k = -w; k <= w; k++) m += r.rate[b + k]; m /= 2 * w + 1;
      dev.push([Math.abs(r.rate[b] - m), b * BLK / SR]);
    }
    dev.sort((x, y) => y[0] - x[0]);
    console.log(dev.slice(0, 12).map((x) => (x[0] * 100).toFixed(3) + '% @' + x[1].toFixed(3)).join('  '));
    const sorted = dev.map((x) => x[0]).sort((a, b) => a - b);
    console.log('mediana', (sorted[sorted.length >> 1] * 100).toFixed(4) + '%', 'p99', (sorted[Math.floor(sorted.length * 0.99)] * 100).toFixed(3) + '%');
    process.exit(0);
  }
  if (process.env.PROBE === '2') {
    simulate(NEW, '1.1', 115, 0.015, 0, (d, b) => { const t = b * BLK / SR; if (t > 10.5 && t < 10.56) console.log(t.toFixed(4), d.curRate.toFixed(5), d.vcVT.toFixed(5), (omega(t) * SPR).toFixed(5), (d.ct - d.vcOff - d.vcDelay).toFixed(4), d.vcN); });
    process.exit(0);
  }
  console.log('sd vT', sd(0), 'sd vRaw', sd(1), 'sd rate', sd(2), 'sd delay', sd(3), 'sd off', sd(4), 'scratch%', rows.reduce((a, r) => a + r[5], 0) / rows.length);
  process.exit(0);
}
const variants = process.env.PCT ? process.env.PCT.split(',').map((p) => ['posizione, margine p' + p, NEW, '1.1', +p / 100]) : [
  ['tua versione (APK), puck 1.0', require(process.argv[2] || '/tmp/vcsim/worklet_utente.js'), '1.0'],
  ['nuova, puck 1.0 (solo velocità)', NEW, '1.0'],
  ['nuova, puck 1.1 (posizione)', NEW, '1.1'],
];
for (const ci of [0.0075, 0.015, 0.030]) {
  console.log('\nBluetooth: un pacchetto ogni ' + (ci * 1000) + ' ms, ritardi irregolari');
  console.log('variante'.padEnd(34) + 'ritardo  scivol.scratch  errore scratch  scivol.mix  tremolio');
  for (const [name, mod, fw, pct] of variants) {
    const runs = [1, 2, 3].map((s) => measure(simulate(mod, fw, 100 * s + Math.round(ci * 1e4), ci, pct)));
    const avg = (k) => runs.reduce((a, r) => a + Math.abs(r[k]), 0) / runs.length;
    const mx = (k) => Math.max(...runs.map((r) => Math.abs(r[k])));
    console.log(name.padEnd(34) + (avg('L').toFixed(1) + ' ms').padEnd(9) +
      (avg('drift').toFixed(2) + ' ms (max ' + mx('drift').toFixed(1) + ')').padEnd(17) +
      (avg('trackRms').toFixed(2) + ' ms').padEnd(16) + (avg('mixDrift').toFixed(2) + ' ms').padEnd(12) +
      avg('jitter').toFixed(3) + '%');
  }
}
