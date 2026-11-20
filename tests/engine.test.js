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
    d.process(l, r, 128, (d.__t || 0) + b * 128 / SR);
    out.set(l, b * 128);
  }
  d.__t = (d.__t || 0) + blocks * 128 / SR;
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
// 8b) giradischi (puck): la velocità arriva dal disco
{
  const t = makeSine(20, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'vc', on: true });
  d.onMessage({ t: 'vcRate', r: 1 });
  run(d, 2);
  check('giradischi: disco a 33 giri → il brano va a velocità normale', Math.abs(d.pos / SR - 2) < 0.03, (d.pos / SR).toFixed(3) + ' s');
  check('giradischi: il brano risulta in riproduzione', d.playing === true);
  let p0 = d.pos;
  d.onMessage({ t: 'vcRate', r: 1.08 });
  run(d, 2);
  check('giradischi: pitch +8% → +8%', Math.abs((d.pos - p0) / SR - 2.16) < 0.03, ((d.pos - p0) / SR).toFixed(3) + ' s');
  d.onMessage({ t: 'play' }); d.onMessage({ t: 'pause' }); d.onMessage({ t: 'tempo', v: 0.5 });
  p0 = d.pos;
  run(d, 1);
  check('giradischi: play/pausa/fader del tempo non contano', Math.abs((d.pos - p0) / SR - 1.08) < 0.03, ((d.pos - p0) / SR).toFixed(3) + ' s');
  d.onMessage({ t: 'vcRate', r: 0 });
  run(d, 0.2);
  p0 = d.pos;
  run(d, 1);
  check('giradischi: disco fermo → brano fermo', Math.abs(d.pos - p0) < 5 && d.playing === false, (d.pos - p0).toFixed(1) + ' campioni');
  d.onMessage({ t: 'vcRate', r: -2 });
  run(d, 0.5);
  check('giradischi: disco all’indietro → il brano torna indietro', d.pos < p0 - SR * 0.9, ((d.pos - p0) / SR).toFixed(3) + ' s');
  d.onMessage({ t: 'touch', on: true });
  check('giradischi: il tocco sulla jog a schermo è ignorato', d.touch === false);
  d.onMessage({ t: 'keyLock', on: true });
  d.onMessage({ t: 'vcRate', r: 1.05 });
  run(d, 0.5);
  check('giradischi: key lock attivo vicino alla velocità normale', d.st.active === true);
  d.onMessage({ t: 'vcRate', r: 2.5 });
  run(d, 0.3);
  check('giradischi: key lock spento durante lo scratch', d.st.active === false);
  d.onMessage({ t: 'vc', on: false });
  run(d, 0.1);
  p0 = d.pos;
  run(d, 0.5);
  check('giradischi spento: il deck torna fermo e ai comandi normali', d.pos === p0 && d.playing === false);
}

// 8c) giradischi, puck 1.1: il brano segue la POSIZIONE del disco
{
  const t = makeSine(30, 440);
  const { d } = newDeck(t);
  d.onMessage({ t: 'seek', to: SR * 5 });
  d.onMessage({ t: 'vc', on: true });
  d.onMessage({ t: 'vcCfg', spr: 1.8 });
  // il disco: angolo (giri) e velocità (giri/s) nel tempo del puck
  let tp = 100, ang = 3.25, w = 1 / 1.8;
  const step = (sec, wf) => {           // ogni 10 ms un campione, consegnato tra un blocco e l'altro
    const blocks = Math.round(sec * SR / 128);
    let acc = 0;
    for (let b = 0; b < blocks; b++) {
      acc += 128 / SR;
      while (acc >= 0.01) {
        acc -= 0.01; tp += 0.01;
        const nw = wf ? wf(tp) : w;
        ang += (w + nw) / 2 * 0.01; w = nw;
        d.onMessage({ t: 'vcPt', tp, a: ang, w });
      }
      run(d, 128 / SR);
    }
  };
  step(1.0);
  let p0 = d.pos;
  step(2.0);
  check('posizione: disco a 33⅓ → velocità normale', Math.abs((d.pos - p0) / SR - 2) < 0.005, ((d.pos - p0) / SR).toFixed(4) + ' s');
  // scratch avanti e indietro, il disco torna al punto: il brano deve tornare allo stesso punto
  w = 0; step(0.3, () => 0);
  const pa = d.pos, aa = ang;
  let ts0 = tp;
  step(2.0, (x) => 0.14 * Math.PI * 2.5 * Math.sin(2 * Math.PI * 2.5 * (x - ts0)));
  w = 0; step(0.3, () => 0);
  const slip = (d.pos - pa) - (ang - aa) * 1.8 * SR;     // il brano deve spostarsi esattamente quanto il disco
  check('posizione: dopo 5 scratch il brano è dove dice il disco (< 1 ms)', Math.abs(slip) / SR < 0.001, (slip / SR * 1000).toFixed(3) + ' ms');
  // CUE durante la riproduzione: salta e continua a seguire il disco da lì
  step(0.5, () => 1 / 1.8);
  d.onMessage({ t: 'seek', to: SR * 2 });
  step(1.0);
  check('posizione: dopo un salto il brano riparte da lì al passo del disco', Math.abs(d.pos / SR - 3) < 0.03, (d.pos / SR).toFixed(3) + ' s');
  // loop: gira nel loop seguendo il disco
  d.onMessage({ t: 'loop', in: SR * 3.1, out: SR * 3.6, on: true });
  step(2.0);
  check('posizione: col loop resta nel loop', d.pos >= SR * 3.1 - 1 && d.pos <= SR * 3.6 + 1, (d.pos / SR).toFixed(3) + ' s');
  d.onMessage({ t: 'loop', on: false });
  // il puck tace: si continua all'ultima velocità
  p0 = d.pos;
  run(d, 1.0);
  check('posizione: puck muto → continua all’ultima velocità', Math.abs((d.pos - p0) / SR - 1) < 0.02, ((d.pos - p0) / SR).toFixed(3) + ' s');
  // torna dopo una pausa (anche se l'orario del puck è ripartito): si riaggancia senza saltare
  p0 = d.pos; tp += 3; ang += 7.77;
  step(0.5);
  check('posizione: al ritorno del puck nessun salto', Math.abs((d.pos - p0) / SR - 0.5) < 0.03, ((d.pos - p0) / SR).toFixed(3) + ' s');
  // REV: il brano va all'indietro mentre il disco va avanti
  d.onMessage({ t: 'reverse', on: true });
  p0 = d.pos;
  step(0.5);
  check('posizione: con REV il brano va all’indietro', (d.pos - p0) / SR < -0.45, ((d.pos - p0) / SR).toFixed(3) + ' s');
  d.onMessage({ t: 'reverse', on: false });
  // key lock: attivo a velocità normale, spento durante lo scratch
  d.onMessage({ t: 'keyLock', on: true });
  step(0.8, () => 1.04 / 1.8);
  check('posizione: key lock attivo col pitch a +4%', d.st.active === true);
  ts0 = tp;
  step(0.2, (x) => 2.5 * Math.sin(2 * Math.PI * 4 * (x - ts0)));
  check('posizione: key lock spento durante lo scratch', d.st.active === false);
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
