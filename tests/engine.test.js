// Test del motore audio (DeckDSP) in Node. Esegui: node tests/engine.test.js
'use strict';
const { DeckDSP } = require('../web/js/worklet.js');

const SR = 48000;
let failures = 0;
function check(name, cond, info) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  → ' + info : ''));
  if (!cond) failures++;
}

function makeSine(sec, freq, amp = 0.5) {
  const n = Math.round(sec * SR);
  const L = new Int16Array(n), R = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * freq * i / SR) * amp * 32767);
    L[i] = v; R[i] = v;
  }
  return { L, R, n };
}
function decim4(L, R) {
  const m = new Float32Array(Math.floor(L.length / 4));
  for (let i = 0; i < m.length; i++) {
    let s = 0; for (let k = 0; k < 4; k++) s += L[4 * i + k] + R[4 * i + k];
    m[i] = s / (8 * 32768);
  }
  return m;
}
function newDeck(track) {
  const msgs = [];
  const d = new DeckDSP(SR, (m) => msgs.push(m));
  d.onMessage({ t: 'load', L: track.L, R: track.R, M4: decim4(track.L, track.R), len: track.n, pos: 0 });
  return { d, msgs };
}
function run(d, sec) {
  const blocks = Math.round(sec * SR / 128);
  const out = new Float32Array(blocks * 128);
  const l = new Float32Array(128), r = new Float32Array(128);
  for (let b = 0; b < blocks; b++) {
    d.process(l, r, 128, b * 128 / SR);
    out.set(l, b * 128);
  }
  return out;
}
function freqOf(sig, from = 0) {
  let zc = 0, first = -1, last = -1;
  for (let i = from + 1; i < sig.length; i++) {
    if (sig[i - 1] < 0 && sig[i] >= 0) { zc++; if (first < 0) first = i; last = i; }
  }
  return (zc - 1) / ((last - first) / SR);
}
function maxJump(sig, from = 0) {
  let m = 0;
  for (let i = from + 1; i < sig.length; i++) m = Math.max(m, Math.abs(sig[i] - sig[i - 1]));
  return m;
}

// 1) riproduzione normale
{
  const t = makeSine(10, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'play' });
  const out = run(d, 1);
  check('play: avanza di 1 s', Math.abs(d.pos - SR) < 300, (d.pos / SR).toFixed(4) + ' s');
  check('play: frequenza 440 Hz', Math.abs(freqOf(out, 2000) - 440) < 1, freqOf(out, 2000).toFixed(2));
}
// 2) tempo +8% senza blocco tonalità
{
  const t = makeSine(10, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'tempo', v: 1.08 });
  d.onMessage({ t: 'play' });
  const out = run(d, 1);
  check('tempo +8%: posizione', Math.abs(d.pos / SR - 1.08) < 0.01, (d.pos / SR).toFixed(4));
  check('tempo +8%: intonazione sale', Math.abs(freqOf(out, 2000) - 475.2) < 1.5, freqOf(out, 2000).toFixed(2));
}
// 3) tempo +8% CON blocco tonalità
{
  const t = makeSine(10, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'tempo', v: 1.08 });
  d.onMessage({ t: 'keyLock', on: true });
  d.onMessage({ t: 'play' });
  const out = run(d, 2);
  check('key lock: posizione +8%', Math.abs(d.pos / SR - 2.16) < 0.02, (d.pos / SR).toFixed(4));
  check('key lock: intonazione invariata', Math.abs(freqOf(out, 4000) - 440) < 2, freqOf(out, 4000).toFixed(2));
  const slope = 2 * Math.PI * 440 / SR * 0.5;
  check('key lock: niente scatti', maxJump(out, 4000) < slope * 1.6, (maxJump(out, 4000) / slope).toFixed(2) + '× pendenza');
}
// 3b) key lock a -6% e +16%
for (const tv of [0.94, 1.16]) {
  const t = makeSine(10, 220);
  const { d } = newDeck(t);
  d.onMessage({ t: 'tempo', v: tv });
  d.onMessage({ t: 'keyLock', on: true });
  d.onMessage({ t: 'play' });
  const out = run(d, 2);
  check('key lock ' + Math.round((tv - 1) * 100) + '%: intonazione', Math.abs(freqOf(out, 4000) - 220) < 1.5, freqOf(out, 4000).toFixed(2));
}
// 4) loop
{
  const t = makeSine(10, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'loop', in: SR * 1.0, out: SR * 1.5, on: true });
  d.onMessage({ t: 'seek', to: SR * 1.0 });
  d.onMessage({ t: 'play' });
  let minP = Infinity, maxP = -Infinity;
  for (let k = 0; k < 30; k++) { run(d, 0.1); minP = Math.min(minP, d.pos); maxP = Math.max(maxP, d.pos); }
  check('loop: resta tra 1,0 e 1,5 s', minP >= SR * 1.0 - 1 && maxP < SR * 1.5, (minP / SR).toFixed(3) + '–' + (maxP / SR).toFixed(3));
}
// 5) scratch: mano sul piatto, poi mezzo giro avanti
{
  const t = makeSine(10, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'seek', to: SR * 2 });
  d.onMessage({ t: 'play' });
  run(d, 0.5);
  d.onMessage({ t: 'touch', on: true });
  run(d, 0.1);
  const p0 = d.pos;
  check('scratch: toccando il piatto si ferma', Math.abs(d.curRate) < 0.02, d.curRate.toFixed(4));
  for (let k = 0; k < 10; k++) { d.onMessage({ t: 'jog', d: 0.05 }); run(d, 0.01); }
  run(d, 0.1);
  check('scratch: mezzo giro = 0,9 s', Math.abs((d.pos - p0) / SR - 0.9) < 0.01, ((d.pos - p0) / SR).toFixed(4));
  d.onMessage({ t: 'touch', on: false });
  run(d, 0.3);
  check('scratch: rilasciando riparte', Math.abs(d.curRate - 1) < 0.01, d.curRate.toFixed(3));
}
// 6) reverse
{
  const t = makeSine(10, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'seek', to: SR * 5 });
  d.onMessage({ t: 'play' });
  d.onMessage({ t: 'reverse', on: true });
  run(d, 1);
  check('reverse: torna indietro', Math.abs(d.pos / SR - 4) < 0.02, (d.pos / SR).toFixed(3));
}
// 7) slip + loop
{
  const t = makeSine(20, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'slip', on: true });
  d.onMessage({ t: 'grid', first: 0, len: SR * 0.5 });
  d.onMessage({ t: 'seek', to: SR * 4 });
  d.onMessage({ t: 'play' });
  d.onMessage({ t: 'beatLoop', beats: 1, q: true });
  run(d, 2);
  d.onMessage({ t: 'loopOff' });
  run(d, 0.05);
  check('slip: uscendo dal loop riprende da dove sarebbe', Math.abs(d.pos / SR - 6.05) < 0.02, (d.pos / SR).toFixed(3));
}
// 8) salto di battute e hot cue quantizzata
{
  const t = makeSine(20, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'grid', first: SR * 0.1, len: SR * 0.46875 }); // 128 BPM
  d.onMessage({ t: 'seek', to: SR * 3 });
  d.onMessage({ t: 'play' });
  d.onMessage({ t: 'beatJump', beats: 16 });
  check('beat jump: +16 battute', Math.abs((d.pos - SR * 3) - 16 * SR * 0.46875) < 2, ((d.pos - SR * 3) / SR).toFixed(3) + ' s');
  const before = d.pos, bl = SR * 0.46875;
  const ph = ((before - SR * 0.1) % bl + bl) % bl;
  d.onMessage({ t: 'jump', to: SR * 0.1 + 8 * bl, q: true });
  const ph2 = ((d.pos - SR * 0.1) % bl + bl) % bl;
  check('hot cue quantizzata: mantiene la fase', Math.abs(ph - ph2) < 2, ph.toFixed(0) + ' / ' + ph2.toFixed(0));
}
// 9) prestazioni: 60 s con blocco tonalità
{
  const t = makeSine(90, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'tempo', v: 1.06 });
  d.onMessage({ t: 'keyLock', on: true });
  d.onMessage({ t: 'play' });
  const t0 = process.hrtime.bigint();
  run(d, 60);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('prestazioni: 60 s di audio elaborati velocemente', ms < 3000, ms.toFixed(0) + ' ms (' + (60000 / ms).toFixed(0) + '× tempo reale)');
}
console.log(failures ? `\n${failures} test falliti` : '\nTutti i test passati');
process.exit(failures ? 1 : 0);
