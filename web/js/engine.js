/*
 * SOLCO — collegamento tra interfaccia e motore audio (thread principale):
 * contesto audio, caricamento dei brani, stima della posizione, analisi in background.
 */
'use strict';
(function (root) {

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  class Engine {
    constructor(opts) {
      opts = opts || {};
      this.workletUrl = opts.workletUrl || 'js/worklet.js';
      this.ctx = null; this.node = null; this.port = null;
      this.sr = 48000; this.len = 0;
      this.rep = { p: 0, r: 0, pl: false, ct: 0, lo: false, li: -1, lt: -1, sl: false, sp: 0, sc: false, kl: false, b: 0 };
      this.handlers = {};
      this.pending = new Map(); this.seq = 1;
      this.mode = 'none';
      this.loadId = 0;
      this.hist = [];
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, d) { (this.handlers[ev] || []).forEach((f) => f(d)); }

    context() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.sr = this.ctx.sampleRate;
      }
      return this.ctx;
    }

    async start() {
      const ctx = this.context();
      if (!this.port) {
        try {
          await ctx.audioWorklet.addModule(this.workletUrl);
          this.node = new AudioWorkletNode(ctx, 'solco-deck', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          this.port = this.node.port;
          this.port.onmessage = (e) => this.onMsg(e.data);
          this.node.connect(ctx.destination);
          this.mode = 'worklet';
        } catch (err) {
          // ripiego: stesso motore su ScriptProcessor nel thread principale
          const DSP = root.SolcoDSP && root.SolcoDSP.DeckDSP;
          if (!DSP) throw err;
          const dsp = new DSP(ctx.sampleRate, (m) => this.onMsg(m));
          const sp = ctx.createScriptProcessor(1024, 1, 2);
          sp.onaudioprocess = (e) => {
            const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
            for (let o = 0; o < L.length; o += 128) dsp.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128, e.playbackTime + o / ctx.sampleRate);
          };
          sp.connect(ctx.destination);
          this.node = sp;
          this.port = { postMessage: (m) => dsp.onMessage(m) };
          this.mode = 'script';
        }
      }
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* richiede un tocco */ } }
      return this.mode;
    }

    get running() { return !!this.ctx && this.ctx.state === 'running' && !!this.port; }

    send(m, transfer) { if (this.port) this.port.postMessage(m, transfer || []); }

    onMsg(m) {
      if (m.t === 'pos') {
        this.rep = m;
        if (m.ct > 0) {
          const h = this.hist;
          const prev = h.length ? h[h.length - 1] : null;
          let jump = false;
          if (prev) {
            const dt = m.ct - prev.ct;
            if (dt <= 0) {
              h.length = 0;
            } else {
              const maxRate = Math.max(Math.abs(m.r), Math.abs(prev.r), 1);
              const maxMove = maxRate * dt * this.sr * 2.5 + 4096;
              if (Math.abs(m.p - prev.p) > maxMove) {
                if (!m.pl && !prev.pl) h.length = 0;
                else jump = true;
              }
            }
          }
          h.push({ ct: m.ct, p: m.p, r: m.r, jump });
          if (h.length > 48) h.shift();
        }
        this.emit('pos', m);
      }
      else if (m.t === 'marked') { const r = this.pending.get(m.id); if (r) { this.pending.delete(m.id); r(m.pos); } }
      else this.emit(m.t, m);
    }

    /* posizione nel momento in cui il suono esce dagli altoparlanti */
    estimate() {
      const rep = this.rep;
      if (!this.ctx || !rep.ct) return rep.p;
      let now;
      const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) now = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      else now = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);

      const h = this.hist;
      let p;
      if (h.length && now <= rep.ct) {
        if (now <= h[0].ct) {
          p = h[0].p;
        } else {
          p = rep.p;
          for (let i = h.length - 1; i > 0; i--) {
            const a = h[i - 1], b = h[i];
            if (now >= a.ct && now <= b.ct) {
              if (b.jump || b.ct <= a.ct) p = (now >= b.ct) ? b.p : a.p;
              else p = a.p + (b.p - a.p) * ((now - a.ct) / (b.ct - a.ct));
              break;
            }
          }
        }
      } else {
        const dt = clamp(now - rep.ct, 0, 0.12);
        p = rep.p + rep.r * dt * this.sr;
      }
      if (rep.lo && rep.lt > rep.li && p >= rep.lt) p = rep.li + ((p - rep.lt) % (rep.lt - rep.li));
      return clamp(p, 0, this.len);
    }

    mark(q) {
      return new Promise((resolve) => {
        const id = this.seq++;
        this.pending.set(id, resolve);
        this.send({ t: 'mark', id, q: !!q });
        setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve(this.estimate()); } }, 400);
      });
    }

    /* decodifica qualunque formato in canali Float32 alla frequenza del contesto */
    async decode(arrayBuffer) {
      const ctx = this.context();
      const M = root.SolcoMedia;
      if (M && M.isAiff(arrayBuffer)) {
        const d = M.decodeAiff(arrayBuffer);
        if (Math.abs(d.sampleRate - ctx.sampleRate) < 1) return d.channels;
        return this.resample(d.channels, d.sampleRate, ctx.sampleRate);
      }
      const ab = await ctx.decodeAudioData(arrayBuffer);
      const ch = [];
      for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) ch.push(ab.getChannelData(c));
      return ch;
    }

    async resample(channels, from, to) {
      const n = channels[0].length;
      const off = new OfflineAudioContext(channels.length, Math.ceil(n * to / from), to);
      const buf = off.createBuffer(channels.length, n, from);
      channels.forEach((c, i) => buf.copyToChannel(c, i));
      const src = off.createBufferSource();
      src.buffer = buf; src.connect(off.destination); src.start();
      const out = await off.startRendering();
      return channels.map((_, i) => out.getChannelData(i));
    }

    /* manda il brano al motore (Int16 + mono decimato per il time-stretch) */
    load(channels, pos) {
      const L32 = channels[0], R32 = channels[1] || channels[0];
      const n = L32.length;
      const L = new Int16Array(n), R = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let a = L32[i] * 32767, b = R32[i] * 32767;
        L[i] = a > 32767 ? 32767 : (a < -32768 ? -32768 : a);
        R[i] = b > 32767 ? 32767 : (b < -32768 ? -32768 : b);
      }
      const M4 = new Float32Array(n >> 2);
      for (let i = 0, j = 0; i < M4.length; i++, j += 4) {
        M4[i] = (L32[j] + L32[j + 1] + L32[j + 2] + L32[j + 3] + R32[j] + R32[j + 1] + R32[j + 2] + R32[j + 3]) * 0.125;
      }
      this.len = n;
      const id = ++this.loadId;
      this.hist = [];
      this.rep = Object.assign({}, this.rep, { p: pos || 0, r: 0, pl: false, ct: 0, lo: false, li: -1, lt: -1 });
      this.send({ t: 'load', L, R, M4, len: n, pos: pos || 0, id }, [L.buffer, R.buffer, M4.buffer]);
      return id;
    }
  }

  /* analisi in un Web Worker (con ripiego nel thread principale) */
  class Analyzer {
    constructor(url) {
      this.queue = Promise.resolve();
      this.seq = 1; this.cbs = new Map();
      try {
        this.w = new Worker(url);
        this.w.onmessage = (e) => {
          const m = e.data, cb = this.cbs.get(m.id);
          if (!cb) return;
          if (m.t === 'progress') { if (cb.progress) cb.progress(m.p); }
          else { this.cbs.delete(m.id); m.t === 'done' ? cb.resolve(m.res) : cb.reject(new Error(m.message)); }
        };
        this.w.onerror = () => { this.w = null; };
      } catch (e) { this.w = null; }
    }
    run(mono, sr, progress) {
      if (this.w) {
        return new Promise((resolve, reject) => {
          const id = this.seq++;
          this.cbs.set(id, { resolve, reject, progress });
          this.w.postMessage({ t: 'analyze', id, mono, sr }, [mono.buffer]);
        });
      }
      return new Promise((resolve, reject) => setTimeout(() => {
        try { resolve(root.SolcoAnalysis.analyze(mono, sr, progress)); } catch (err) { reject(err); }
      }, 30));
    }
  }

  function mixMono(channels) {
    const L = channels[0], R = channels[1] || channels[0];
    const m = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) * 0.5;
    return m;
  }

  root.SolcoEngine = { Engine, Analyzer, mixMono };
})(typeof self !== 'undefined' ? self : this);
