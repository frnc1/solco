/*
 * SOLCO — comandi fisici via MIDI (Web MIDI nel browser, ponte nativo nell'APK),
 * con mappatura configurabile e modalità "apprendi".
 */
'use strict';
(function (root) {

  const PUCK_CH = 12, PUCK_ZERO = 1 << 20, PUCK_SCALE = 4000;

  // funzioni assegnabili: id, etichetta, tipo
  const FUNCS = [
    ['play', 'Play / Pausa', 'btn'], ['cue', 'Cue', 'btn'],
    ['jog', 'Jog (rotazione)', 'jog'], ['jog2', 'Jog (bordo)', 'jog'], ['jogTouch', 'Jog (tocco)', 'btn'], ['tempo', 'Fader tempo', 'abs'],
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
      this.jogLast = null; this.jog2Last = null;
      this.learnPend = null; this.learnTimer = null;   // fader su CC: attesa per capire se è a 14 bit
      this.hi = new Map();                             // fader a 14 bit su CC: ultimo byte alto e basso
      this.ticksPerRev = 2048;
      this.onDevices = null;
      this.onPuck = null;                // puck del giradischi (firmware in /firmware/puck)
      this.puck = { hi: -1, mid: -1, seq: 0, traw: 0, alo: 0, ahi: 0, rlo: 0, lt: -1, la: 0, tu: 0, au: 0, lastTs: -1e9 };
      // ponte per l'app Android: il codice nativo chiama queste funzioni
      root.solcoMidiIn = (bytes, ts) => this.handle(bytes, ts || performance.now());
      root.solcoMidiBatch = (list) => { const now = performance.now(); for (let i = 0; i < list.length; i++) this.handle(list[i], now); };
      root.solcoMidiDevices = (names) => { this.nativeDevices = names || []; this.updateDevices(); };
    }

    setMap(m) { if (Array.isArray(m) && m.length) { this.map = m; this.reindex(); } }
    resetMap() { this.map = defaultMap(); this.reindex(); }
    reindex() {
      this.index.clear();
      for (const e of this.map) {
        this.index.set(e.type + ':' + e.ch + ':' + (e.type === 'pb' ? 0 : e.num), e);
        if (e.mode === 'abs14cc' && e.lsb != null) this.index.set('cc:' + e.ch + ':' + e.lsb, e);
      }
      if (this.hi) this.hi.clear();
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

    learn(fn, cb) { this.clearPend(); this.learnFn = fn; this.learnCb = cb; this.jogLast = null; this.jog2Last = null; }
    cancelLearn() { this.clearPend(); this.learnFn = null; this.learnCb = null; }
    clearPend() { if (this.learnTimer) clearTimeout(this.learnTimer); this.learnTimer = null; this.learnPend = null; }

    handle(data, ts) {
      if (!data || data.length < 2) return;
      const s = data[0], type = s & 0xf0, ch = s & 0x0f;
      // puck del giradischi: canale 13, CC 102-106 (non passano dal monitor né dalla mappatura)
      if (ch === PUCK_CH) {
        if (type === 0xB0 && data[1] >= 102 && data[1] <= 106) { this.puckIn(data[1], data[2] | 0, ts); return; }
        if (type === 0x80 || type === 0x90 || type === 0xA0 || type === 0xE0) { this.puckFrame(type, data[1] | 0, data[2] | 0, ts); return; }
      }
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

    /* Puck del giradischi, firmware 1.0: CC 102/103/104 = giri al minuto × 4000 con segno, 21 bit
       (si applica sul 104). Sempre: CC 105 batteria in %, CC 106 stato. */
    puckIn(num, v, ts) {
      const p = this.puck;
      if (num === 102) p.hi = v;
      else if (num === 103) p.mid = v;
      else if (num === 104) {
        if (p.hi < 0 || p.mid < 0) return;
        const u = (p.hi << 14) | (p.mid << 7) | v;
        if (this.onPuck) this.onPuck({ rpm: (u - PUCK_ZERO) / PUCK_SCALE, ts });
      } else if (num === 105) { if (this.onPuck) this.onPuck({ bat: v, ts }); }
      else if (num === 106) { if (this.onPuck) this.onPuck({ flags: v, ts }); }
    }

    /* Puck, firmware 1.1: ogni 10 ms un pacchetto di 4 messaggi sul canale 13 (56 bit utili)
         80 = orario del puck in decimi di ms (14 bit, riparte ogni 1,6384 s)
         90 = angolo del disco, bit 0-13      (angolo in 1/524288 di giro, 21 bit: riparte ogni 4 giri)
         A0 = angolo bit 14-20 | giri al minuto bit 0-6
         E0 = giri al minuto bit 7-20         (giri al minuto × 4000 con segno, spostati di 2^20)
       Con orario e angolo il brano segue la posizione del disco. */
    puckFrame(type, d1, d2, ts) {
      const p = this.puck;
      if (type === 0x80) { p.traw = (d1 << 7) | d2; p.seq = 1; return; }
      if (type === 0x90) { if (p.seq === 1) { p.alo = (d1 << 7) | d2; p.seq = 2; } else p.seq = 0; return; }
      if (type === 0xA0) { if (p.seq === 2) { p.ahi = d1; p.rlo = d2; p.seq = 3; } else p.seq = 0; return; }
      if (p.seq !== 3) return;
      p.seq = 0;
      const u = (d2 << 14) | (d1 << 7) | p.rlo;
      const araw = (p.ahi << 14) | p.alo;
      const m = { rpm: (u - PUCK_ZERO) / PUCK_SCALE, ts };
      // orario e angolo senza salti: si sommano le differenze (dopo una pausa lunga si riparte da zero)
      const reset = p.lt < 0 || ts - p.lastTs > 1000;
      if (reset) { p.tu = 0; p.au = 0; }
      else {
        const dt = (p.traw - p.lt) & 0x3fff;
        if (dt === 0) return;                                  // pacchetto ripetuto
        let da = (araw - p.la) & 0x1fffff;
        if (da >= 0x100000) da -= 0x200000;
        p.tu += dt * 1e-4; p.au += da / 524288;
      }
      p.lt = p.traw; p.la = araw; p.lastTs = ts;
      m.tp = p.tu; m.a = p.au; m.reset = reset;
      if (this.onPuck) this.onPuck(m);
    }

    doLearn(ev) {
      if (ev.type === 'note' && ev.val === 0) return; // aspetta la pressione
      if (this.learnPend && ev.type !== 'cc') return;
      const fdef = FUNCS.find((f) => f[0] === this.learnFn);
      const kind = fdef ? fdef[2] : 'btn';
      if (ev.type === 'cc' && kind === 'abs') {
        // molti fader mandano due CC (n e n+32, 14 bit): ascolta un attimo prima di decidere
        if (!this.learnPend) {
          this.learnPend = { ch: ev.ch, nums: [ev.num] };
          this.learnTimer = setTimeout(() => this.finishAbsLearn(), 300);
        } else if (ev.ch === this.learnPend.ch && !this.learnPend.nums.includes(ev.num)) this.learnPend.nums.push(ev.num);
        return;
      }
      let mode = 'btn';
      if (ev.type === 'pb') mode = 'abs14';
      else if (ev.type === 'cc') {
        if (kind === 'btn') mode = 'ccbtn';
        else mode = (ev.val >= 56 && ev.val <= 72) ? 'rel64' : 'rel2c';
      }
      this.commitLearn({ fn: this.learnFn, type: ev.type, ch: ev.ch, num: ev.num, mode });
    }

    finishAbsLearn() {
      const p = this.learnPend;
      this.learnPend = null; this.learnTimer = null;
      if (!p || !this.learnFn) return;
      const msb = p.nums.find((n) => n < 32 && p.nums.includes(n + 32));
      this.commitLearn(msb !== undefined
        ? { fn: this.learnFn, type: 'cc', ch: p.ch, num: msb, lsb: msb + 32, mode: 'abs14cc' }
        : { fn: this.learnFn, type: 'cc', ch: p.ch, num: p.nums[0], mode: 'abs7' });
    }

    commitLearn(entry) {
      const uses = (m, n) => m.num === n || (m.lsb != null && m.lsb === n);
      this.map = this.map.filter((m) => m.fn !== entry.fn && !(m.type === entry.type && m.ch === entry.ch &&
        (m.type === 'pb' || uses(m, entry.num) || (entry.lsb != null && uses(m, entry.lsb)))));
      this.map.push(entry);
      this.reindex();
      const cb = this.learnCb;
      this.learnFn = null; this.learnCb = null;
      if (cb) cb(entry);
    }

    dispatch(e, ev) {
      if (e.fn === 'jog' || e.fn === 'jog2') {
        // «Jog (bordo)»: alcuni controller mandano la rotazione del bordo su un CC a parte
        const lk = e.fn === 'jog2' ? 'jog2Last' : 'jogLast';
        let d = 0;
        if (e.mode === 'abs14') {
          const v = ev.val;
          if (this[lk] !== null) {
            let dv = v - this[lk];
            if (dv > 8192) dv -= 16384; else if (dv < -8192) dv += 16384;
            d = dv / 16384;
          }
          this[lk] = v;
        } else if (e.mode === 'abs7') {
          const v = ev.val;
          if (this[lk] !== null) { let dv = v - this[lk]; if (dv > 64) dv -= 128; else if (dv < -64) dv += 128; d = dv / 128; }
          this[lk] = v;
        } else if (e.mode === 'rel64') d = (ev.val - 64) / this.ticksPerRev;
        else d = (ev.val > 64 ? ev.val - 128 : ev.val) / this.ticksPerRev;
        if (d) this.onAction('jog', d, ev);
        return;
      }
      if (e.mode === 'btn') { this.onAction(e.fn, ev.val, ev); return; }
      if (e.mode === 'ccbtn') { this.onAction(e.fn, ev.val > 63 ? 1 : 0, ev); return; }
      if (e.mode === 'abs14') { this.onAction(e.fn, ev.val / 16383, ev); return; }
      if (e.mode === 'abs14cc') {
        // byte alto (CC n) e basso (CC n+32) in qualsiasi ordine: si usa sempre l'ultimo di ciascuno
        const st = this.hi.get(e.fn) || { msb: -1, lsb: 0 };
        if (ev.num === e.lsb) st.lsb = ev.val; else st.msb = ev.val;
        this.hi.set(e.fn, st);
        if (st.msb >= 0) this.onAction(e.fn, ((st.msb << 7) | st.lsb) / 16383, ev);
        return;
      }
      if (e.mode === 'abs7') { this.onAction(e.fn, ev.val / 127, ev); return; }
      if (e.mode === 'rel64') { this.onAction(e.fn, ev.val - 64, ev); return; }
      if (e.mode === 'rel2c') { this.onAction(e.fn, ev.val > 64 ? ev.val - 128 : ev.val, ev); return; }
    }

    describe(fn) {
      const e = this.map.find((m) => m.fn === fn);
      if (!e) return '—';
      const ch = 'can. ' + (e.ch + 1);
      if (e.type === 'note') return 'Nota ' + e.num + ' · ' + ch;
      if (e.type === 'cc') return 'CC ' + e.num + (e.lsb != null ? '+' + e.lsb + ' (14 bit)' : '') + ' · ' + ch;
      return 'Pitch bend · ' + ch;
    }
  }

  // codifica usata dal puck (serve anche ai test)
  // firmware 1.0 (solo giri al minuto) o, con tUnits (decimi di ms) e revs (giri), firmware 1.1
  function puckBytes(rpm, tUnits, revs) {
    let v = Math.round(rpm * PUCK_SCALE);
    v = Math.max(-(PUCK_ZERO - 1), Math.min(PUCK_ZERO - 1, v));
    const u = v + PUCK_ZERO, c = PUCK_CH;
    if (tUnits === undefined) {
      const st = 0xB0 | c;
      return [[st, 102, (u >> 14) & 0x7f], [st, 103, (u >> 7) & 0x7f], [st, 104, u & 0x7f]];
    }
    const t = Math.round(tUnits) & 0x3fff, a = Math.floor(revs * 524288) & 0x1fffff;
    return [[0x80 | c, t >> 7, t & 0x7f], [0x90 | c, (a >> 7) & 0x7f, a & 0x7f],
      [0xA0 | c, (a >> 14) & 0x7f, u & 0x7f], [0xE0 | c, (u >> 7) & 0x7f, (u >> 14) & 0x7f]];
  }

  root.SolcoMidi = { Midi, FUNCS, defaultMap, puckBytes };
})(typeof self !== 'undefined' ? self : this);
