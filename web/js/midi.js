/*
 * SOLCO — comandi fisici via MIDI (Web MIDI nel browser, ponte nativo nell'APK),
 * con mappatura configurabile e modalità "apprendi".
 */
'use strict';
(function (root) {

  // funzioni assegnabili: id, etichetta, tipo
  const FUNCS = [
    ['play', 'Play / Pausa', 'btn'], ['cue', 'Cue', 'btn'],
    ['jog', 'Jog (rotazione)', 'jog'], ['jogTouch', 'Jog (tocco)', 'btn'], ['tempo', 'Fader tempo', 'abs'],
    ['keylock', 'Key lock', 'btn'], ['range', 'Range tempo', 'btn'], ['tempoReset', 'Tempo a zero', 'btn'],
    ['hot1', 'Hot cue A', 'btn'], ['hot2', 'Hot cue B', 'btn'], ['hot3', 'Hot cue C', 'btn'], ['hot4', 'Hot cue D', 'btn'],
    ['hot5', 'Hot cue E', 'btn'], ['hot6', 'Hot cue F', 'btn'], ['hot7', 'Hot cue G', 'btn'], ['hot8', 'Hot cue H', 'btn'],
    ['loopIn', 'Loop in', 'btn'], ['loopOut', 'Loop out', 'btn'], ['reloop', 'Reloop / Exit', 'btn'],
    ['autoLoop', 'Auto loop', 'btn'], ['loopHalve', 'Loop ½', 'btn'], ['loopDouble', 'Loop ×2', 'btn'],
    ['jumpBack', 'Beat jump ◀', 'btn'], ['jumpFwd', 'Beat jump ▶', 'btn'],
    ['memStore', 'Memorizza cue', 'btn'], ['memPrev', 'Cue memoria ◀', 'btn'], ['memNext', 'Cue memoria ▶', 'btn'],
    ['reverse', 'Reverse', 'btn'], ['slip', 'Slip', 'btn'], ['quantize', 'Quantize', 'btn'], ['jogmode', 'Modo vinile', 'btn'],
    ['browse', 'Sfoglia (manopola)', 'rel'], ['load', 'Carica / Conferma', 'btn'], ['back', 'Indietro', 'btn'],
    ['trackPrev', 'Brano precedente', 'btn'], ['trackNext', 'Brano successivo', 'btn'], ['shift', 'Shift', 'btn'],
  ];

  // mappatura del controller SOLCO (firmware in /firmware)
  function defaultMap() {
    const n = (fn, num) => ({ fn, type: 'note', ch: 0, num, mode: 'btn' });
    return [
      n('play', 0x01), n('cue', 0x02), n('keylock', 0x03), n('range', 0x04), n('tempoReset', 0x05),
      n('reverse', 0x06), n('slip', 0x07), n('quantize', 0x08), n('jogmode', 0x09), n('shift', 0x0A),
      n('hot1', 0x10), n('hot2', 0x11), n('hot3', 0x12), n('hot4', 0x13), n('hot5', 0x14), n('hot6', 0x15), n('hot7', 0x16), n('hot8', 0x17),
      n('loopIn', 0x20), n('loopOut', 0x21), n('reloop', 0x22), n('autoLoop', 0x23), n('loopHalve', 0x24), n('loopDouble', 0x25),
      n('jumpBack', 0x26), n('jumpFwd', 0x27), n('memPrev', 0x28), n('memNext', 0x29), n('memStore', 0x2A),
      n('trackPrev', 0x30), n('trackNext', 0x31), n('load', 0x33), n('back', 0x34), n('jogTouch', 0x40),
      { fn: 'browse', type: 'cc', ch: 0, num: 0x40, mode: 'rel2c' },
      { fn: 'jog', type: 'pb', ch: 15, num: 0, mode: 'abs14' },
      { fn: 'tempo', type: 'pb', ch: 14, num: 0, mode: 'abs14' },
    ];
  }

  class Midi {
    constructor(onAction) {
      this.onAction = onAction;          // (fn, value, evt)
      this.map = defaultMap();
      this.index = new Map();
      this.reindex();
      this.access = null;
      this.devices = [];                 // nomi dei dispositivi collegati
      this.nativeDevices = [];
      this.learnFn = null; this.learnCb = null;
      this.monitor = null;               // callback per il monitor MIDI
      this.jogLast = null;
      this.ticksPerRev = 2048;
      this.onDevices = null;
      // ponte per l'app Android: il codice nativo chiama queste funzioni
      root.solcoMidiIn = (bytes, ts) => this.handle(bytes, ts || performance.now());
      root.solcoMidiBatch = (list) => { const now = performance.now(); for (let i = 0; i < list.length; i++) this.handle(list[i], now); };
      root.solcoMidiDevices = (names) => { this.nativeDevices = names || []; this.updateDevices(); };
    }

    setMap(m) { if (Array.isArray(m) && m.length) { this.map = m; this.reindex(); } }
    resetMap() { this.map = defaultMap(); this.reindex(); }
    reindex() {
      this.index.clear();
      for (const e of this.map) this.index.set(e.type + ':' + e.ch + ':' + (e.type === 'pb' ? 0 : e.num), e);
    }

    async init() {
      if (!navigator.requestMIDIAccess) return false;
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (e) { return false; }
      const attach = () => {
        this.access.inputs.forEach((inp) => { inp.onmidimessage = (ev) => this.handle(ev.data, ev.timeStamp); });
        this.updateDevices();
      };
      this.access.onstatechange = attach;
      attach();
      return true;
    }

    updateDevices() {
      const names = [];
      if (this.access) this.access.inputs.forEach((i) => { if (i.state !== 'disconnected') names.push(i.name || 'MIDI'); });
      this.devices = names.concat(this.nativeDevices);
      if (this.onDevices) this.onDevices(this.devices);
    }

    learn(fn, cb) { this.learnFn = fn; this.learnCb = cb; this.jogLast = null; }
    cancelLearn() { this.learnFn = null; this.learnCb = null; }

    handle(data, ts) {
      if (!data || data.length < 2) return;
      const s = data[0], type = s & 0xf0, ch = s & 0x0f;
      let ev = null;
      if (type === 0x90 || type === 0x80) ev = { type: 'note', ch, num: data[1], val: (type === 0x90 && data[2] > 0) ? 1 : 0, raw: data[2] || 0 };
      else if (type === 0xB0) ev = { type: 'cc', ch, num: data[1], val: data[2] };
      else if (type === 0xE0) ev = { type: 'pb', ch, num: 0, val: ((data[2] || 0) << 7) | data[1] };
      if (!ev) return;
      ev.ts = ts;
      if (this.monitor) this.monitor(ev);
      if (this.learnFn) { this.doLearn(ev); return; }
      const e = this.index.get(ev.type + ':' + ev.ch + ':' + ev.num);
      if (!e) return;
      this.dispatch(e, ev);
    }

    doLearn(ev) {
      if (ev.type === 'note' && ev.val === 0) return; // aspetta la pressione
      const fdef = FUNCS.find((f) => f[0] === this.learnFn);
      const kind = fdef ? fdef[2] : 'btn';
      let mode = 'btn';
      if (ev.type === 'pb') mode = 'abs14';
      else if (ev.type === 'cc') {
        if (kind === 'abs') mode = 'abs7';
        else if (kind === 'btn') mode = 'ccbtn';
        else mode = (ev.val >= 56 && ev.val <= 72) ? 'rel64' : 'rel2c';
      }
      const entry = { fn: this.learnFn, type: ev.type, ch: ev.ch, num: ev.num, mode };
      this.map = this.map.filter((m) => m.fn !== entry.fn && !(m.type === entry.type && m.ch === entry.ch && (m.type === 'pb' || m.num === entry.num)));
      this.map.push(entry);
      this.reindex();
      const cb = this.learnCb;
      this.learnFn = null; this.learnCb = null;
      if (cb) cb(entry);
    }

    dispatch(e, ev) {
      if (e.fn === 'jog') {
        let d = 0;
        if (e.mode === 'abs14') {
          const v = ev.val;
          if (this.jogLast !== null) {
            let dv = v - this.jogLast;
            if (dv > 8192) dv -= 16384; else if (dv < -8192) dv += 16384;
            d = dv / 16384;
          }
          this.jogLast = v;
        } else if (e.mode === 'abs7') {
          const v = ev.val;
          if (this.jogLast !== null) { let dv = v - this.jogLast; if (dv > 64) dv -= 128; else if (dv < -64) dv += 128; d = dv / 128; }
          this.jogLast = v;
        } else if (e.mode === 'rel64') d = (ev.val - 64) / this.ticksPerRev;
        else d = (ev.val > 64 ? ev.val - 128 : ev.val) / this.ticksPerRev;
        if (d) this.onAction('jog', d, ev);
        return;
      }
      if (e.mode === 'btn') { this.onAction(e.fn, ev.val, ev); return; }
      if (e.mode === 'ccbtn') { this.onAction(e.fn, ev.val > 63 ? 1 : 0, ev); return; }
      if (e.mode === 'abs14') { this.onAction(e.fn, ev.val / 16383, ev); return; }
      if (e.mode === 'abs7') { this.onAction(e.fn, ev.val / 127, ev); return; }
      if (e.mode === 'rel64') { this.onAction(e.fn, ev.val - 64, ev); return; }
      if (e.mode === 'rel2c') { this.onAction(e.fn, ev.val > 64 ? ev.val - 128 : ev.val, ev); return; }
    }

    describe(fn) {
      const e = this.map.find((m) => m.fn === fn);
      if (!e) return '—';
      const ch = 'can. ' + (e.ch + 1);
      if (e.type === 'note') return 'Nota ' + e.num + ' · ' + ch;
      if (e.type === 'cc') return 'CC ' + e.num + ' · ' + ch;
      return 'Pitch bend · ' + ch;
    }
  }

  root.SolcoMidi = { Midi, FUNCS, defaultMap };
})(typeof self !== 'undefined' ? self : this);
