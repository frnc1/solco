// Test dell'analisi (BPM, griglia, tonalità) su brani techno sintetici.
'use strict';
const A = require('../web/js/analysis.js');
const fs = require('fs');

let failures = 0;
function check(name, cond, info) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  → ' + info : ''));
  if (!cond) failures++;
}

// Genera un loop techno: cassa in 4, charleston in levare, basso e accordi in La minore.
function synth({ bpm, sec, sr, offset, key }) {
  const n = Math.round(sec * sr);
  const x = new Float32Array(n);
  const beat = 60 / bpm;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  // progressione (radici MIDI) e accordi
  const prog = key === 'Am'
    ? [[45, [57, 60, 64]], [41, [53, 57, 60]], [43, [55, 59, 62]], [45, [57, 60, 64]]]   // Am F G Am
    : [[38, [50, 54, 57]], [43, [55, 59, 62]], [45, [57, 61, 64]], [38, [50, 54, 57]]]; // D G A D
  for (let i = 0; i < n; i++) {
    const t = i / sr - offset;
    if (t < 0) continue;
    const b = Math.floor(t / beat), tb = t - b * beat;
    // cassa
    if (b >= 0) {
      const f = 45 + 80 * Math.exp(-tb * 40);
      const ph = 2 * Math.PI * (45 * tb + 80 * (1 - Math.exp(-tb * 40)) / 40);
      x[i] += 0.9 * Math.sin(ph) * Math.exp(-tb * 7) * (f > 0 ? 1 : 0);
    }
    // charleston sul levare
    const th = tb - beat / 2;
    if (th >= 0 && th < 0.05) x[i] += 0.18 * rnd() * Math.exp(-th * 90);
    // basso (radice dell'accordo), sedicesimi
    const bar = Math.floor(b / 4) % 4;
    const [root, chord] = prog[bar];
    const t16 = t % (beat / 4);
    const env16 = Math.exp(-t16 * 18);
    const fb = mtof(root);
    x[i] += 0.22 * Math.sin(2 * Math.PI * fb * t) * env16 * (tb > beat * 0.25 ? 1 : 0.2);
    // accordo sostenuto
    let pad = 0;
    for (const m of chord) pad += Math.sin(2 * Math.PI * mtof(m) * t) + 0.3 * Math.sin(2 * Math.PI * mtof(m + 12) * t);
    x[i] += 0.05 * pad;
  }
  return x;
}

for (const tc of [
  { bpm: 128, sec: 75, sr: 48000, offset: 0.25, key: 'Am', expKey: '8A' },
  { bpm: 126.5, sec: 75, sr: 44100, offset: 0.6, key: 'D', expKey: '10B' },
  { bpm: 140, sec: 60, sr: 48000, offset: 0.0, key: 'Am', expKey: '8A' },
  { bpm: 122, sec: 60, sr: 48000, offset: 1.37, key: 'D', expKey: '10B' },
]) {
  const x = synth(tc);
  const t0 = Date.now();
  const r = A.analyze(x, tc.sr);
  const ms = Date.now() - t0;
  const label = `${tc.bpm} BPM, ${tc.sr} Hz`;
  check(`${label}: BPM`, Math.abs(r.bpm - tc.bpm) < 0.02, r.bpm + ' (conf ' + r.bpmConfidence.toFixed(1) + ')');
  const per = 60 / tc.bpm;
  let off = ((r.gridStart - tc.offset) % per + per) % per; if (off > per / 2) off -= per;
  check(`${label}: griglia sulla cassa`, Math.abs(off) < 0.012, (off * 1000).toFixed(1) + ' ms');
  check(`${label}: battuta 1 all'inizio`, Math.abs(r.gridStart - tc.offset) < per / 2, r.gridStart.toFixed(3) + ' s');
  check(`${label}: tonalità`, r.key.camelot === tc.expKey, r.key.name + ' / ' + r.key.camelot);
  check(`${label}: forma d'onda`, r.wave.lo.length === Math.ceil(x.length / (tc.sr / 150)), r.wave.lo.length + ' colonne');
  console.log(`      (analisi di ${tc.sec} s in ${ms} ms)`);
  if (tc.bpm === 128) {
    // salva un WAV per i test dell'interfaccia
    const sr = tc.sr, n = x.length, buf = Buffer.alloc(44 + n * 4);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, x[i] * 0.8)) * 32767; buf.writeInt16LE(v | 0, 44 + i * 4); buf.writeInt16LE(v | 0, 46 + i * 4); }
    fs.mkdirSync(__dirname + '/media', { recursive: true });
    fs.writeFileSync(__dirname + '/media/test-128.wav', buf);
  }
}
console.log(failures ? `\n${failures} test falliti` : '\nTutti i test passati');
process.exit(failures ? 1 : 0);
