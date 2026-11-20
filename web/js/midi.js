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
      this.onPuckMsg = null;             // puck con schermo: messaggi SysEx decodificati
      this.onPuckOut = null;
      this.sysexOk = false;
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
      // SysEx serve al puck con schermo; se il browser lo nega si va avanti senza
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: true });
        this.sysexOk = true;
      } catch (e) {
        try { this.access = await navigator.requestMIDIAccess({ sysex: false }); } catch (e2) { return false; }
      }
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

    // messaggi per il puck con schermo: app Android (ponte nativo) o Web MIDI (Windows, browser)
    puckSend(bytes) {
      const A = root.SolcoAndroid;
      if (A && A.puckSend) {
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        try { A.puckSend(hex); return true; } catch (e) { return false; }
      }
      let sent = false;
      if (this.access && this.sysexOk) {
        this.access.outputs.forEach((o) => {
          if (o.state !== 'disconnected' && /^SOLCO Puck/i.test(o.name || '')) { try { o.send(bytes); sent = true; } catch (e) { /* niente */ } }
        });
      }
      if (this.onPuckOut) this.onPuckOut(bytes);       // usato dai test
      return sent;
    }

    handle(data, ts) {
      if (!data || data.length < 2) return;
      if (data[0] === 0xF0) {
        const m = pkDecode(data);
        if (m && this.onPuckMsg) this.onPuckMsg(m);
        return;
      }
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

  /* ---------------- Puck con schermo (M5Stack StopWatch): messaggi SysEx ----------------
     F0 7D 53 4C <comando> <dati a 7 bit> F7   (7D = uso non commerciale, 53 4C = "SL")
     Numeri: u7 = 1 byte, u14 = 2 byte, u21 = 3 byte (dal più alto), s21 = u21 di (v + 2^20).
     Testi: lunghezza u7 + caratteri ASCII stampabili (SOLCO toglie accenti e simboli).
     Dal tablet al puck: STATE, TRACK, WAVE, LHEAD, LITEMS, GENRES, RESULT, HELLOK.
     Dal puck al tablet: HELLO, LREQ, LOAD, BROWSE, GREQ, TREQ.  Dettagli in firmware/puck/README.md */
  const PK = {
    STATE: 0x01, TRACK: 0x02, WAVE: 0x03, LHEAD: 0x04, LITEMS: 0x05, GENRES: 0x06, RESULT: 0x07, HELLOK: 0x08,
    HELLO: 0x10, LREQ: 0x11, LOAD: 0x12, BROWSE: 0x13, GREQ: 0x14, TREQ: 0x15,
  };
  const PK_HEAD = [0xF0, 0x7D, 0x53, 0x4C];
  const PK_NONE = 0x3FFF;           // indice «nessuno» / «intorno al brano caricato»

  const FOLD = {
    'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D',
    'þ': 'th', 'Þ': 'TH', 'ð': 'd', 'ı': 'i', '‘': "'", '’': "'", '‚': "'", '´': "'", '`': "'", '“': '"', '”': '"', '„': '"',
    '«': '"', '»': '"', '–': '-', '—': '-', '‐': '-', '…': '...', '•': '*', '·': '-', '×': 'x', '€': 'EUR', '£': 'L', '°': 'o',
    ' ': ' ',
  };
  // testo per il puck: solo ASCII stampabile (i caratteri del puck non hanno accenti)
  function asciiFold(s, max) {
    s = String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
    let out = '', bad = false;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      let r = null;
      if (c >= 0x20 && c <= 0x7e) r = ch;
      else if (FOLD[ch] !== undefined) r = FOLD[ch];
      else if (c === 9 || c === 10 || c === 13) r = ' ';
      if (r === null) { if (!bad) out += '?'; bad = true; } else { out += r; bad = false; }
    }
    out = out.replace(/\s+/g, ' ').trim();
    if (max && out.length > max) out = out.slice(0, max).trimEnd();
    return out;
  }
  // Camelot «8A» ↔ codice 1..24 (1A=1, 1B=2 … 12B=24), 0 = sconosciuto
  function camCode(c) {
    const m = /^(\d{1,2})([AB])$/i.exec(String(c || '').trim());
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 12) return 0;
    return n * 2 - (m[2].toUpperCase() === 'A' ? 1 : 0);
  }
  const camName = (k) => (k >= 1 && k <= 24 ? Math.ceil(k / 2) + (k % 2 ? 'A' : 'B') : '');

  class PkW {
    constructor(cmd) { this.b = PK_HEAD.concat([cmd & 0x7f]); }
    u7(v) { this.b.push(Math.max(0, Math.min(127, v | 0))); return this; }
    u14(v) { v = Math.max(0, Math.min(0x3fff, Math.round(v) || 0)); this.b.push((v >> 7) & 0x7f, v & 0x7f); return this; }
    u21(v) { v = Math.max(0, Math.min(0x1fffff, Math.round(v) || 0)); this.b.push((v >> 14) & 0x7f, (v >> 7) & 0x7f, v & 0x7f); return this; }
    s21(v) { v = Math.max(-0xfffff, Math.min(0xfffff, Math.round(v) || 0)); return this.u21(v + 0x100000); }
    str(s, max) {
      const t = asciiFold(s, Math.min(127, max || 127));
      this.b.push(t.length);
      for (let i = 0; i < t.length; i++) this.b.push(t.charCodeAt(i) & 0x7f);
      return this;
    }
    end() { this.b.push(0xF7); return this.b; }
  }
  class PkR {
    constructor(b) { this.b = b; this.i = 5; this.end = b.length - 1; this.ok = true; }
    byte() { if (this.i >= this.end) { this.ok = false; return 0; } return this.b[this.i++] & 0x7f; }
    u7() { return this.byte(); }
    u14() { const h = this.byte(); return (h << 7) | this.byte(); }
    u21() { const a = this.byte(), b = this.byte(); return (a << 14) | (b << 7) | this.byte(); }
    s21() { return this.u21() - 0x100000; }
    str() { const n = this.byte(); let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(this.byte()); return s; }
  }
  // codifica (oggetto → byte) per ogni messaggio
  const pkEnc = {
    state: (o) => new PkW(PK.STATE).u7(o.flags).u21(o.pos).u21(o.dur).u21(o.bpm).s21(o.pitch).u7(o.tseq).u7(o.deck).end(),
    track: (o) => new PkW(PK.TRACK).u7(o.tseq).u21(o.bpm).u7(o.cam).u21(o.dur).str(o.title, 48).str(o.artist, 40).str(o.genre, 24).end(),
    wave: (o) => { const w = new PkW(PK.WAVE).u7(o.tseq).u7(o.bins.length); o.bins.forEach((v) => w.u7(v)); return w.end(); },
    lhead: (o) => new PkW(PK.LHEAD).u7(o.req).u14(o.total).u14(o.sel).u7(o.sort).u7(o.compat).str(o.genre, 24).end(),
    litems: (o) => {
      const w = new PkW(PK.LITEMS).u7(o.req).u14(o.start).u7(o.items.length);
      o.items.forEach((t) => w.u14(t.bpm).u7(t.cam).u14(t.dur).u7(t.fl).str(t.id, 15).str(t.title, 48).str(t.artist, 32));
      return w.end();
    },
    genres: (o) => { const w = new PkW(PK.GENRES).u7(o.list.length); o.list.forEach((g) => w.u14(g.n).str(g.name, 24)); return w.end(); },
    result: (o) => new PkW(PK.RESULT).u7(o.code).str(o.text, 64).end(),
    hellok: (o) => new PkW(PK.HELLOK).u7(o.deck).str(o.version, 16).end(),
    hello: (o) => new PkW(PK.HELLO).u7(o.proto).u7(o.model).str(o.fw, 16).end(),
    lreq: (o) => new PkW(PK.LREQ).u7(o.req).u7(o.sort).u7(o.compat).u14(o.start).u7(o.count).str(o.genre, 24).end(),
    load: (o) => new PkW(PK.LOAD).u7(o.force ? 1 : 0).str(o.id, 15).end(),
    browse: (o) => new PkW(PK.BROWSE).u7(o.on ? 1 : 0).end(),
    greq: () => new PkW(PK.GREQ).end(),
    treq: () => new PkW(PK.TREQ).end(),
  };
  // decodifica (byte → oggetto con .cmd), null se non è un messaggio del puck o è troncato
  function pkDecode(b) {
    if (!b || b.length < 6 || b[0] !== 0xF0 || b[b.length - 1] !== 0xF7) return null;
    for (let i = 1; i < 4; i++) if (b[i] !== PK_HEAD[i]) return null;
    const r = new PkR(b), cmd = b[4];
    let m = null;
    switch (cmd) {
      case PK.STATE: m = { flags: r.u7(), pos: r.u21(), dur: r.u21(), bpm: r.u21(), pitch: r.s21(), tseq: r.u7(), deck: r.u7() }; break;
      case PK.TRACK: m = { tseq: r.u7(), bpm: r.u21(), cam: r.u7(), dur: r.u21(), title: r.str(), artist: r.str(), genre: r.str() }; break;
      case PK.WAVE: { const tseq = r.u7(), n = r.u7(), bins = []; for (let k = 0; k < n; k++) bins.push(r.u7()); m = { tseq, bins }; break; }
      case PK.LHEAD: m = { req: r.u7(), total: r.u14(), sel: r.u14(), sort: r.u7(), compat: r.u7(), genre: r.str() }; break;
      case PK.LITEMS: {
        const req = r.u7(), start = r.u14(), n = r.u7(), items = [];
        for (let k = 0; k < n; k++) items.push({ bpm: r.u14(), cam: r.u7(), dur: r.u14(), fl: r.u7(), id: r.str(), title: r.str(), artist: r.str() });
        m = { req, start, items }; break;
      }
      case PK.GENRES: { const n = r.u7(), list = []; for (let k = 0; k < n; k++) list.push({ n: r.u14(), name: r.str() }); m = { list }; break; }
      case PK.RESULT: m = { code: r.u7(), text: r.str() }; break;
      case PK.HELLOK: m = { deck: r.u7(), version: r.str() }; break;
      case PK.HELLO: m = { proto: r.u7(), model: r.u7(), fw: r.str() }; break;
      case PK.LREQ: m = { req: r.u7(), sort: r.u7(), compat: r.u7(), start: r.u14(), count: r.u7(), genre: r.str() }; break;
      case PK.LOAD: m = { force: r.u7(), id: r.str() }; break;
      case PK.BROWSE: m = { on: r.u7() }; break;
      case PK.GREQ: case PK.TREQ: m = {}; break;
      default: return null;
    }
    if (!r.ok) return null;
    m.cmd = cmd;
    return m;
  }
  const PuckProto = { PK, PK_NONE, asciiFold, camCode, camName, enc: pkEnc, decode: pkDecode };

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

  root.SolcoMidi = { Midi, FUNCS, defaultMap, puckBytes, PuckProto };
})(typeof self !== 'undefined' ? self : this);
