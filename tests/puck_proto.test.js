// Protocollo del puck con schermo: la stessa codifica in JavaScript (web/js/midi.js) e in C++ (firmware).
// Uso: node tests/puck_proto.test.js [percorso del programma di prova C++]
// Se il programma non c'è lo compila con g++ (tests/puck_proto_host.cpp).
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
global.self = global;
require(path.join(__dirname, '..', 'web', 'js', 'midi.js'));
const { PuckProto: P, Midi } = global.SolcoMidi;

let fails = 0;
const check = (name, ok, info) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || info === undefined ? '' : '  → ' + info)); if (!ok) fails++; };
const hex = (b) => Array.from(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((a, x) => { a[x] = v[x]; return a; }, {}) : v));
const unhex = (s) => { const o = []; for (let i = 0; i < s.length; i += 2) o.push(parseInt(s.slice(i, i + 2), 16)); return o; };

// ---------- solo JavaScript ----------
check('asciiFold accenti', P.asciiFold('Città è già più') === 'Citta e gia piu', P.asciiFold('Città è già più'));
check('asciiFold simboli', P.asciiFold('Beyoncé – “Halo” … ß') === 'Beyonce - "Halo" ... ss', P.asciiFold('Beyoncé – “Halo” … ß'));
check('asciiFold non latini → ?', P.asciiFold('DJ 東京 Mix') === 'DJ ? Mix', P.asciiFold('DJ 東京 Mix'));
check('asciiFold taglia', P.asciiFold('abcdefgh', 5) === 'abcde');
check('Camelot codici', P.camCode('1A') === 1 && P.camCode('1B') === 2 && P.camCode('8A') === 15 && P.camCode('12B') === 24 && P.camCode('') === 0 && P.camCode('13A') === 0);
check('Camelot nomi', P.camName(1) === '1A' && P.camName(24) === '12B' && P.camName(15) === '8A' && P.camName(0) === '');
for (let k = 1; k <= 24; k++) if (P.camCode(P.camName(k)) !== k) check('Camelot andata e ritorno ' + k, false);

const items = [
  { bpm: 1260, cam: 15, dur: 343, fl: 5, id: 't1abcd', title: 'Così Celeste (Extended Mix)', artist: 'Zucchero & Co.' },
  { bpm: 0, cam: 0, dur: 0, fl: 0, id: 'tz9', title: '', artist: '' },
  { bpm: 16383, cam: 24, dur: 16383, fl: 7, id: 'tmax', title: 'X'.repeat(60), artist: 'Y'.repeat(50) },
];
const appMsgs = {
  state: { flags: 0b1011011, pos: 1234, dur: 3456, bpm: 12600, pitch: -235, tseq: 7, deck: 2 },
  state2: { flags: 0, pos: 0x1fffff, dur: 0, bpm: 0, pitch: 0xfffff, tseq: 127, deck: 1 },
  track: { tseq: 9, bpm: 12450, cam: P.camCode('8A'), dur: 3021, title: 'Città Vuota', artist: 'Mina', genre: 'Pop' },
  wave: { tseq: 9, bins: Array.from({ length: 120 }, (_, i) => (i * 37) % 128) },
  lhead: { req: 5, total: 356, sel: 12, sort: 2, compat: 0, genre: 'Tech House' },
  lhead2: { req: 1, total: 0, sel: P.PK_NONE, sort: 5, compat: 1, genre: '' },
  litems: { req: 5, start: 10, items },
  genres: { list: [{ n: 12, name: 'Tech House' }, { n: 3, name: 'Disco / Funk' }, { n: 1, name: 'Música Ligera' }] },
  result: { code: 1, text: 'Stai suonando: caricare comunque?' },
  hellok: { deck: 1, version: '1.6.0' },
};
const encName = (k) => k.replace(/\d+$/, '');
for (const [k, o] of Object.entries(appMsgs)) {
  const b = P.enc[encName(k)](o);
  check('codifica ' + k + ' solo 7 bit', b.slice(1, -1).every((x) => x < 128) && b[0] === 0xF0 && b[b.length - 1] === 0xF7);
  const d = P.decode(b);
  check('JS andata e ritorno ' + k, !!d && d.cmd === b[4], JSON.stringify(d));
}
check('troncato → null', P.decode(P.enc.state(appMsgs.state).slice(0, 10).concat([0xF7])) === null);
check('non del puck → null', P.decode([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]) === null);

// la classe Midi passa i SysEx del puck a onPuckMsg (anche come Uint8Array, come fa Web MIDI)
{
  const m = new Midi(() => {});
  let got = null;
  m.onPuckMsg = (x) => { got = x; };
  m.handle(new Uint8Array(P.enc.hello({ proto: 1, model: 2, fw: '2.0' })), 0);
  check('Midi.handle → onPuckMsg', got && got.cmd === P.PK.HELLO && got.model === 2 && got.fw === '2.0', JSON.stringify(got));
}

// ---------- confronto con il C++ del firmware ----------
let bin = process.argv[2] || '/tmp/puck_proto_host';
if (!fs.existsSync(bin)) {
  try {
    execFileSync('g++', ['-std=c++17', '-O1', '-I', path.join(__dirname, '..', 'firmware', 'puck', 'solco_puck_sw'),
      path.join(__dirname, 'puck_proto_host.cpp'), '-o', bin], { stdio: 'inherit' });
  } catch (e) { console.log('FAIL compilazione C++'); process.exit(1); }
}
const run = (mode, input) => execFileSync(bin, [mode], { input: input || '' }).toString().trim().split('\n');

// tablet → puck: il C++ legge quello che scrive il JavaScript
{
  const keys = Object.keys(appMsgs);
  const lines = run('decode', keys.map((k) => hex(P.enc[encName(k)](appMsgs[k]))).join('\n') + '\n');
  keys.forEach((k, i) => {
    const c = JSON.parse(lines[i]);
    const j = P.decode(P.enc[encName(k)](appMsgs[k]));
    if (!c) { check('C++ legge ' + k, false, lines[i]); return; }
    if (j.cam !== undefined && j.cmd === P.PK.TRACK) check('C++ nome Camelot ' + k, c.camName === P.camName(j.cam), c.camName);
    delete c.camName;
    check('C++ legge ' + k, canon(c) === canon(j), '\n  C++ ' + canon(c) + '\n  JS  ' + canon(j));
  });
}
// valori attesi dopo la codifica (limiti e testi puliti)
{
  const d = P.decode(P.enc.litems(appMsgs.litems));
  check('titolo tagliato a 48', d.items[2].title.length === 48 && d.items[2].artist.length === 32);
  check('testo ripulito', d.items[0].title === 'Cosi Celeste (Extended Mix)', d.items[0].title);
  const s = P.decode(P.enc.state(appMsgs.state));
  check('pitch con segno', s.pitch === -235 && s.bpm === 12600 && s.deck === 2);
}
// puck → tablet: il JavaScript legge quello che scrive il C++
{
  const lines = run('encode');
  const want = [
    { cmd: P.PK.HELLO, proto: 1, model: 2, fw: '2.0' },
    { cmd: P.PK.LREQ, req: 5, sort: 2, compat: 0, start: P.PK_NONE, count: 30, genre: '' },
    { cmd: P.PK.LREQ, req: 127, sort: 4, compat: 1, start: 1234, count: 12, genre: 'tech house' },
    { cmd: P.PK.LOAD, force: 0, id: 't1x2y3z' },
    { cmd: P.PK.LOAD, force: 1, id: 'tabc' },
    { cmd: P.PK.BROWSE, on: 1 },
    { cmd: P.PK.BROWSE, on: 0 },
    { cmd: P.PK.GREQ },
    { cmd: P.PK.TREQ },
  ];
  want.forEach((w, i) => {
    const d = P.decode(unhex(lines[i] || ''));
    const same = d && Object.keys(w).every((k) => d[k] === w[k]);
    check('JS legge dal puck #' + i, same, JSON.stringify(d));
    // e il JavaScript scrive gli stessi byte
    const name = { 16: 'hello', 17: 'lreq', 18: 'load', 19: 'browse', 20: 'greq', 21: 'treq' }[w.cmd];
    check('stessi byte JS/C++ #' + i, hex(P.enc[name](w)) === lines[i], hex(P.enc[name](w)) + ' / ' + lines[i]);
  });
}
// pacchetti Bluetooth: un SysEx lungo diviso e ricomposto (anche con note di rotazione in mezzo)
{
  const big = P.enc.litems({ req: 1, start: 0, items: items.concat(items) });
  const all = [P.enc.state(appMsgs.state), P.enc.wave(appMsgs.wave), big, P.enc.greq()];
  const lines = run('ble', all.map(hex).join('\n') + '\n');
  all.forEach((m, i) => {
    const parts = (lines[i] || '').split(' ');
    check('Bluetooth MTU 20/23/185 #' + i + ' (' + m.length + ' byte)', parts.length === 3 && parts.every((p) => p === hex(m)), lines[i]);
  });
}

console.log(fails ? fails + ' prove fallite' : 'tutte le prove del protocollo del puck passano');
process.exit(fails ? 1 : 0);
