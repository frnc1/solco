/*
 * SOLCO — logica dell'interfaccia del lettore.
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmod = (a, b) => ((a % b) + b) % b;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const VERSION = '1.1.0';
  const LETTERS = 'ABCDEFGH';
  const HOT_COLORS = ['#ff4d5e', '#ff9f1c', '#ffd23f', '#34d77b', '#2fd0c2', '#4c8dff', '#8b6bff', '#ff5fb4'];
  const RANGES = [6, 8, 10, 16, 50];
  const LOOP_SIZES = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
  const PALETTES = {
    solco: ['#6f5cff', '#24c6d6', '#f2f5ff'],
    ambra: ['#ff5a36', '#ffbf47', '#fff1d6'],
    mono: ['#3f4754', '#8a94a3', '#e8ecf2'],
  };
  const BAND_SCALE = [1.0, 0.84, 0.62];
  const CAM_COLORS = ['', '#56e0c0', '#74dc72', '#a8d84e', '#dccd46', '#f2a64c', '#f27a5e', '#f26582', '#e263b6', '#b46ae6', '#8a7ef2', '#5f9ef2', '#45c6ee'];

  const DEFAULTS = {
    deck: 1, jogMode: 'vinyl', secPerRev: 1.8, nudgeGain: 0.12, brakeSec: 0, startSec: 0,
    rangeIdx: 2, keyLock: false, quantize: true, jumpBeats: 16, loopBeats: 4, autoCue: true,
    invertFader: false, needle: 'paused', timeMode: 'remain', palette: 'solco', endWarn: 30,
    touchControls: 'auto', zoomSec: 6, ticksPerRev: 2048, sort: 'added', orient: 'portrait',
  };
  let S = Object.assign({}, DEFAULTS);

  const isAndroidApp = !!window.SolcoAndroid;
  const singleFile = !!document.getElementById('src-worklet');
  function srcUrl(id, file) {
    const el = document.getElementById(id);
    if (el) return URL.createObjectURL(new Blob([el.textContent], { type: 'text/javascript' }));
    return file;
  }

  const lib = window.SolcoLibrary;
  const engine = new SolcoEngine.Engine({ workletUrl: srcUrl('src-worklet', 'js/worklet.js') });
  const analyzer = new SolcoEngine.Analyzer(srcUrl('src-analysis', 'js/analysis.js'));
  const midi = new SolcoMidi.Midi(onControl);

  /* --------------------------- stato del deck --------------------------- */
  const D = {
    track: null, wave: null, sr: 48000, len: 0, bpm: 0, grid: 0,
    cue: 0, hot: new Array(8).fill(null), mem: [],
    pitch: 0, playing: false, posF: 0,
    loop: { on: false, in: -1, out: -1 },
    slip: false, reverse: false, scratching: false,
    cuePreview: false, playInPreview: false, hotPreview: -1,
    loading: false, shift: false, softTakeover: false,
    playSec: 0, countedPlay: false, cmdT: 0,
  };
  let tracks = [];
  const artUrls = new Map();

  engine.on('pos', (m) => {
    const was = D.playing;
    // subito dopo un comando play/pausa i rapporti già in viaggio sono vecchi: si ignorano
    if (performance.now() - D.cmdT > 90) D.playing = m.pl;
    D.loop.on = m.lo; D.loop.in = m.li; D.loop.out = m.lt;
    D.scratching = m.sc;
    if (was !== D.playing) updateTransport();
  });
  engine.on('end', () => { D.playing = false; updateTransport(); });

  /* ------------------------------ utilità UI ------------------------------ */
  let toastT = 0;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }
  function setBusy(txt) {
    const el = $('#busy');
    if (!txt) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden'); el.textContent = txt;
  }
  let modalDone = null;
  function modal(html, buttons) {
    if (modalDone) modalDone(null);
    return new Promise((resolve) => {
      const m = $('#modal');
      $('#mText').innerHTML = html;
      const box = $('#mBtns');
      box.innerHTML = '';
      modalDone = (v) => { modalDone = null; m.classList.add('hidden'); resolve(v); };
      buttons.forEach((b) => {
        const el = document.createElement('button');
        el.className = b.cls || 'pill';
        if (b.style) el.setAttribute('style', b.style);
        el.innerHTML = b.label;
        el.onclick = () => { if (modalDone) modalDone(b.value); };
        box.appendChild(el);
      });
      m.classList.remove('hidden');
    });
  }
  const confirmBox = (html, ok, cancel) => modal(html, [{ label: cancel || 'ANNULLA', value: false }, { label: ok || 'OK', value: true, cls: 'pill accent' }]);

  function fmtT(sec, tenths) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = sec - m * 60;
    if (tenths) {
      const t = Math.floor(s * 10) / 10;
      return String(m).padStart(2, '0') + ':' + (t < 10 ? '0' : '') + t.toFixed(1);
    }
    return String(m).padStart(2, '0') + ':' + String(Math.floor(s)).padStart(2, '0');
  }
  const fmtDur = (sec) => { const m = Math.floor(sec / 60); return m + ':' + String(Math.floor(sec - m * 60)).padStart(2, '0'); };
  function keyChipHTML(t) {
    if (!t || !t.camelot) return '<span class="keychip none">—</span>';
    const n = parseInt(t.camelot, 10);
    return '<span class="keychip" style="background:' + (CAM_COLORS[n] || '#8b929d') + '">' + esc(t.camelot) + '</span>';
  }
  function artUrl(t) {
    if (!t || !t.art) return null;
    let u = artUrls.get(t.id);
    if (!u) { u = URL.createObjectURL(t.art); artUrls.set(t.id, u); }
    return u;
  }
  const tempoFactor = () => 1 + D.pitch * RANGES[S.rangeIdx] / 100;
  const beatLen = () => (D.bpm > 0 ? 60 / D.bpm * D.sr : 0);
  function nearestBeat(p) {
    const bl = beatLen();
    if (!bl) return p;
    return D.grid * D.sr + Math.round((p - D.grid * D.sr) / bl) * bl;
  }

  /* ------------------------------ impostazioni ------------------------------ */
  let saveSetT = 0;
  function saveSettings() {
    clearTimeout(saveSetT);
    saveSetT = setTimeout(() => lib.setKV('settings', S).catch(() => {}), 300);
  }
  function applySetting(k) {
    if (k === 'deck') { $('#deckName').textContent = 'DECK ' + S.deck; buildJog(); }
    if (['secPerRev', 'nudgeGain', 'brakeSec', 'startSec'].includes(k)) sendParams();
    if (k === 'rangeIdx') { sendTempo(); updateTempoUI(); }
    if (k === 'keyLock') { engine.send({ t: 'keyLock', on: S.keyLock }); updateTempoUI(); }
    if (k === 'palette') buildOverview();
    if (k === 'touchControls') updateTouchVisibility();
    if (k === 'ticksPerRev') midi.ticksPerRev = S.ticksPerRev;
    if (k === 'quantize' || k === 'jogMode') updateChips();
    if (k === 'jumpBeats' || k === 'loopBeats') updateChips();
    if (k === 'orient') applyOrientation();
  }
  function setS(k, v) {
    // cambiando il range del fader il tempo resta quello di prima (il fader si sposta)
    if (k === 'rangeIdx' && v !== S.rangeIdx) {
      D.pitch = clamp(D.pitch * RANGES[S.rangeIdx] / RANGES[v], -1, 1);
      if (midi.devices.length) D.softTakeover = true;
    }
    S[k] = v; saveSettings(); applySetting(k);
  }
  function applyOrientation() {
    const o = S.orient || 'portrait';
    if (window.SolcoAndroid && window.SolcoAndroid.setOrientation) { try { window.SolcoAndroid.setOrientation(o); } catch (e) { /* versione vecchia dell'app */ } }
  }
  function sendParams() { engine.send({ t: 'params', secPerRev: S.secPerRev, nudgeGain: S.nudgeGain, brakeSec: S.brakeSec, startSec: S.startSec }); }
  function sendTempo() { engine.send({ t: 'tempo', v: tempoFactor() }); }

  /* ------------------------------ audio ------------------------------ */
  async function startAudio() {
    try {
      await engine.start();
    } catch (e) {
      $('#gateMsg').textContent = 'Audio non disponibile su questo dispositivo: ' + (e && e.message || e);
      throw e;
    }
    D.sr = engine.sr;
    sendParams(); sendTempo();
    engine.send({ t: 'keyLock', on: S.keyLock });
    engine.send({ t: 'slip', on: D.slip });
    $('#gate').classList.add('hidden');
    requestWakeLock();
    if (!midiStarted) {
      midiStarted = true;
      midi.init().then(() => updateMidiStatus());
    }
  }
  let midiStarted = false;

  let wakeLock = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* non supportato */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { requestWakeLock(); if (engine.ctx && engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {}); }
  });

  /* ------------------------------ caricamento ------------------------------ */
  function autoCueSec(t) {
    if (t.bpm > 0) {
      const per = 60 / t.bpm;
      let g = t.gridStart || 0;
      while (g < -0.002) g += per;
      return Math.max(0, g);
    }
    return Math.max(0, (t.firstSound || 0) - 0.01);
  }
  function applyAnalysis(t, res) {
    t.duration = res.duration;
    t.bpm = res.bpm || 0;
    t.gridStart = res.gridStart || 0;
    t.key = res.key ? res.key.name : '';
    t.camelot = res.key ? res.key.camelot : '';
    t.firstSound = res.firstSound || 0;
    t.rms = res.rms || 0;
    t.analyzed = true;
    delete t.anaFailed; delete t.error;
  }
  function stored(t) { const c = Object.assign({}, t); delete c.analyzing; return c; }
  const saveTrack = (t) => lib.putTrack(stored(t)).catch(() => {});

  async function loadTrack(t, force) {
    if (!t || D.loading) return;
    if (D.playing && !force) {
      const ok = await confirmBox('<h3>Stai suonando</h3>Il brano in onda verrà sostituito da <b>' + esc(t.title) + '</b>.', 'CARICA', 'ANNULLA');
      if (!ok) return;
    }
    if (!engine.running) { try { await startAudio(); } catch (e) { return; } }
    D.loading = true;
    setBusy('Carico…');
    try {
      const blob = await lib.getFile(t.id);
      if (!blob) throw new Error('file non trovato nella libreria');
      const ab = await blob.arrayBuffer();
      const channels = await engine.decode(ab);
      D.sr = engine.sr;
      let wave = await lib.getWave(t.id);
      if (!t.analyzed || !wave) {
        setBusy('Analizzo il brano…');
        const res = await analyzer.run(SolcoEngine.mixMono(channels), engine.sr);
        applyAnalysis(t, res);
        wave = res.wave;
        await lib.putWave(t.id, wave);
        await saveTrack(t);
      }
      D.track = t; D.wave = wave; D.len = channels[0].length;
      D.bpm = t.bpm || 0; D.grid = t.gridStart || 0;
      D.hot = (t.hot || []).slice(0, 8); while (D.hot.length < 8) D.hot.push(null);
      D.mem = (t.mem || []).slice();
      const cueSec = t.cue != null ? t.cue : (S.autoCue ? autoCueSec(t) : 0);
      D.cue = Math.round(cueSec * D.sr);
      D.loop = { on: false, in: -1, out: -1 };
      D.reverse = false; D.cuePreview = false; D.hotPreview = -1; D.playing = false;
      D.playSec = 0; D.countedPlay = false;
      engine.load(channels, D.cue);
      D.posF = D.cue;
      engine.send({ t: 'grid', first: D.grid * D.sr, len: beatLen() });
      sendTempo();
      engine.send({ t: 'keyLock', on: S.keyLock });
      engine.send({ t: 'slip', on: D.slip });
      renderTrackHead(); buildOverview(); renderHotcues(); updateTransport(); updateChips(); updateTempoUI();
      if (!$('#browser').classList.contains('hidden')) renderList();
      lib.setKV('lastTrack', t.id).catch(() => {});
      closeBrowser();
    } catch (e) {
      toast('Impossibile caricare il brano: ' + (e && e.message || e), 4000);
    } finally {
      D.loading = false;
      setBusy(analysisBusyText());
    }
  }

  /* ------------------------------ trasporto ------------------------------ */
  function play() {
    if (!D.track) return;
    if (D.cuePreview || D.hotPreview >= 0) { D.playInPreview = true; updateTransport(); return; }
    if (D.playing) { engine.send({ t: 'pause' }); D.playing = false; }
    else { engine.send({ t: 'play' }); D.playing = true; }
    D.cmdT = performance.now();
    updateTransport();
  }
  function pauseAt(to) {
    engine.send({ t: 'pause' });
    engine.send({ t: 'seek', to });
    D.playing = false; D.cmdT = performance.now();
    updateTransport();
  }
  function cueDown() {
    if (!D.track) return;
    if (D.playing && !D.cuePreview && D.hotPreview < 0) { pauseAt(D.cue); return; }
    if (D.hotPreview >= 0) return;
    let p = engine.estimate();
    if (Math.abs(p - D.cue) > D.sr * 0.01) {
      if (S.quantize && D.bpm > 0) p = nearestBeat(p);
      D.cue = Math.round(clamp(p, 0, D.len));
      engine.send({ t: 'seek', to: D.cue });
      saveCuesSoon();
    }
    D.cuePreview = true; D.playInPreview = false;
    engine.send({ t: 'play' }); D.playing = true; D.cmdT = performance.now();
    updateTransport();
  }
  function cueUp() {
    if (!D.cuePreview) return;
    D.cuePreview = false;
    if (D.playInPreview) { D.playInPreview = false; updateTransport(); return; }
    pauseAt(D.cue);
  }
  async function hotDown(i) {
    if (!D.track) return;
    if (D.shift) { deleteHot(i); return; }
    const h = D.hot[i];
    if (!h) {
      const p = await engine.mark(S.quantize && D.bpm > 0);
      D.hot[i] = { t: p / D.sr, c: i };
      renderHotcues(); flashHot(i); saveCuesSoon();
      return;
    }
    const to = Math.round(h.t * D.sr);
    flashHot(i);
    if (D.playing && !D.cuePreview && D.hotPreview < 0) { engine.send({ t: 'jump', to, q: S.quantize }); return; }
    if (D.cuePreview) return;
    D.cue = to;
    engine.send({ t: 'seek', to });
    D.hotPreview = i; D.playInPreview = false;
    engine.send({ t: 'play' }); D.playing = true; D.cmdT = performance.now();
    updateTransport();
  }
  function hotUp(i) {
    if (D.hotPreview !== i) return;
    D.hotPreview = -1;
    if (D.playInPreview) { D.playInPreview = false; updateTransport(); return; }
    pauseAt(Math.round(D.hot[i] ? D.hot[i].t * D.sr : D.cue));
  }
  function deleteHot(i) {
    if (!D.hot[i]) return;
    D.hot[i] = null; renderHotcues(); saveCuesSoon();
    toast('Hot cue ' + LETTERS[i] + ' eliminata');
  }
  function setPitch(n) {
    n = clamp(n, -1, 1);
    if (Math.abs(n) < 0.006) n = 0;
    D.pitch = n; sendTempo(); updateTempoUI();
  }
  function tempoReset() { setPitch(0); D.softTakeover = true; toast('Tempo a zero'); }
  function cycleRange() { setS('rangeIdx', (S.rangeIdx + 1) % RANGES.length); toast('Range tempo ±' + RANGES[S.rangeIdx] + '%: il tempo non cambia'); }
  function toggleKeyLock() { setS('keyLock', !S.keyLock); }
  function toggleReverse() { D.reverse = !D.reverse; engine.send({ t: 'reverse', on: D.reverse }); updateChips(); }
  function toggleSlip() { D.slip = !D.slip; engine.send({ t: 'slip', on: D.slip }); updateChips(); }
  function toggleQuantize() { setS('quantize', !S.quantize); }
  function toggleJogMode() { setS('jogMode', S.jogMode === 'vinyl' ? 'cdj' : 'vinyl'); toast(S.jogMode === 'vinyl' ? 'Jog: vinile, toccando il centro fai scratch' : 'Jog: solo spinta'); }

  function loopIn() { if (D.track) engine.send({ t: 'loopInNow', q: S.quantize }); }
  function loopOut() { if (D.track) engine.send({ t: 'loopOutNow', q: S.quantize }); }
  function reloop() { if (D.track) engine.send({ t: 'reloop' }); }
  function autoLoop() {
    if (!D.track) return;
    if (D.loop.on) engine.send({ t: 'loopOff' });
    else engine.send({ t: 'beatLoop', beats: S.loopBeats, q: S.quantize });
  }
  function loopScale(f) {
    if (D.track && D.loop.in >= 0 && D.loop.out > D.loop.in) { engine.send({ t: 'loopScale', f }); return; }
    const i = LOOP_SIZES.indexOf(S.loopBeats);
    const ni = clamp((i < 0 ? 4 : i) + (f > 1 ? 1 : -1), 0, LOOP_SIZES.length - 1);
    setS('loopBeats', LOOP_SIZES[ni]);
    toast('Auto loop: ' + beatsLabel(S.loopBeats));
  }
  function beatJump(dir) { if (D.track) engine.send({ t: 'beatJump', beats: dir * S.jumpBeats, moveLoop: D.loop.on }); }
  function memStore() {
    if (!D.track) return;
    const t = D.cue / D.sr;
    if (D.mem.some((m) => Math.abs(m.t - t) < 0.05)) { toast('Cue già in memoria'); return; }
    D.mem.push({ t }); D.mem.sort((a, b) => a.t - b.t); saveCuesSoon();
    toast('Cue memorizzato (' + D.mem.length + ')');
  }
  function memCall(dir) {
    if (!D.track || !D.mem.length) { toast('Nessun cue in memoria'); return; }
    const p = engine.estimate() / D.sr;
    let m = dir > 0 ? D.mem.find((x) => x.t > p + 0.05) : D.mem.slice().reverse().find((x) => x.t < p - 0.05);
    if (!m) m = dir > 0 ? D.mem[0] : D.mem[D.mem.length - 1];
    D.cue = Math.round(m.t * D.sr);
    pauseAt(D.cue);
  }
  function jog(d) { if (D.track) engine.send({ t: 'jog', d }); }
  function jogTouch(on) {
    if (!D.track || (on && S.jogMode !== 'vinyl')) return;
    engine.send({ t: 'touch', on: !!on });
  }

  let saveCueT = 0;
  function saveCuesSoon() {
    if (!D.track) return;
    const t = D.track;
    t.cue = D.cue / D.sr;
    t.hot = D.hot.slice();
    t.mem = D.mem.slice();
    clearTimeout(saveCueT);
    saveCueT = setTimeout(() => saveTrack(t), 500);
  }

  /* ------------------------------ comandi fisici ------------------------------ */
  function onControl(fn, v) {
    switch (fn) {
      case 'jog': jog(v); break;
      case 'jogTouch': jogTouch(v); break;
      case 'tempo': {
        let n = v * 2 - 1;
        if (S.invertFader) n = -n;
        if (D.softTakeover) { if (Math.abs(n - D.pitch) > 0.03) return; D.softTakeover = false; }
        setPitch(n);
        break;
      }
      case 'play': if (v) play(); break;
      case 'cue': v ? cueDown() : cueUp(); break;
      case 'shift': D.shift = !!v; break;
      case 'browse': browseMove(v); break;
      case 'load': if (v) browseLoad(); break;
      case 'back': if (v) closeAll(); break;
      case 'trackPrev': if (v) trackStep(-1); break;
      case 'trackNext': if (v) trackStep(1); break;
      default:
        if (fn.startsWith('hot')) { const i = parseInt(fn.slice(3), 10) - 1; v ? hotDown(i) : hotUp(i); return; }
        if (!v) return;
        ({
          keylock: toggleKeyLock, range: cycleRange, tempoReset, reverse: toggleReverse, slip: toggleSlip,
          quantize: toggleQuantize, jogmode: toggleJogMode, loopIn, loopOut, reloop, autoLoop,
          loopHalve: () => loopScale(0.5), loopDouble: () => loopScale(2),
          jumpBack: () => beatJump(-1), jumpFwd: () => beatJump(1),
          memStore, memPrev: () => memCall(-1), memNext: () => memCall(1),
        }[fn] || (() => {}))();
    }
  }
  function updateMidiStatus() {
    const devs = midi.devices;
    $('#midiDot').classList.toggle('on', devs.length > 0);
    $('#midiLabel').textContent = devs.length ? devs.join(', ') : 'Nessun controller';
    updateTouchVisibility();
    if (!$('#settings').classList.contains('hidden') && curTab === 'Comandi') renderSettings();
  }
  midi.onDevices = updateMidiStatus;
  function updateTouchVisibility() {
    const on = S.touchControls === 'on' || (S.touchControls === 'auto' && midi.devices.length === 0);
    $('#app').classList.toggle('touch-on', on);
    jogVisible = on;
    requestAnimationFrame(resize);
  }

  /* ------------------------------ disegno ------------------------------ */
  const zc = $('#zoom'), zx = zc.getContext('2d', { alpha: false });
  const oc = $('#over'), ox = oc.getContext('2d', { alpha: false });
  const jc = $('#jog'), jx = jc.getContext('2d');
  const portraitMQ = window.matchMedia('(orientation: portrait)');
  let dpr = 1, U = 1, overBase = null;
  let bandBuf = [new Float32Array(8), new Float32Array(8), new Float32Array(8)];

  function resize() {
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    U = (portraitMQ.matches ? Math.min(window.innerWidth, window.innerHeight * 0.625) : Math.min(window.innerHeight, window.innerWidth * 0.625)) / 800;
    for (const c of [zc, oc, jc]) {
      const r = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    const n = Math.ceil(zc.width / Math.max(1, Math.round(dpr))) + 3;
    if (bandBuf[0].length < n) bandBuf = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    buildOverview();
    if (jc.width !== jogBuiltW) buildJog();
    updateTempoUI();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe($('#zoomWrap')); ro.observe($('#jogWrap'));
  window.addEventListener('resize', resize);

  function sampleBand(arr, c, cpp, cols) {
    if (cpp <= 1) {
      const i = Math.floor(c);
      if (i < 0 || i >= cols) return 0;
      if (i === cols - 1) return arr[i] / 255;
      const f = c - i;
      return (arr[i] * (1 - f) + arr[i + 1] * f) / 255;
    }
    let a = Math.floor(c), b = Math.floor(c + cpp);
    if (b < 0 || a >= cols) return 0;
    if (a < 0) a = 0; if (b >= cols) b = cols - 1;
    let m = 0;
    for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i];
    return m / 255;
  }

  function drawZoom() {
    const W = zc.width, H = zc.height, g = zx;
    g.fillStyle = '#040507'; g.fillRect(0, 0, W, H);
    const cx = Math.round(W / 2);
    if (!D.track || !D.wave) {
      g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(0, Math.round(H / 2), W, Math.max(1, Math.round(dpr)));
      g.fillStyle = '#545b66'; g.font = '500 ' + Math.round(15 * U * dpr) + 'px SolcoInter, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(tracks.length ? 'Tocca BRANI e scegli un brano da caricare' : 'Tocca BRANI, poi + IMPORTA per aggiungere la tua musica', cx, H / 2 - 22 * U * dpr);
      g.textAlign = 'left';
      return;
    }
    const sr = D.sr, posSec = D.posF / sr, pxs = W / S.zoomSec;
    const top = Math.round(24 * U * dpr), bottom = H - Math.round(8 * U * dpr);
    const mid = (top + bottom) / 2, amp = (bottom - top) / 2;
    const t0 = posSec - cx / pxs, t1 = posSec + (W - cx) / pxs;
    const X = (sec) => cx + (sec - posSec) * pxs;

    // loop
    if (D.loop.in >= 0 && D.loop.out > D.loop.in) {
      const a = X(D.loop.in / sr), b = X(D.loop.out / sr);
      if (b > 0 && a < W) {
        g.fillStyle = D.loop.on ? 'rgba(47,208,194,.16)' : 'rgba(47,208,194,.05)';
        g.fillRect(a, top, b - a, bottom - top);
        g.fillStyle = D.loop.on ? '#2fd0c2' : 'rgba(47,208,194,.45)';
        g.fillRect(Math.round(a), top, Math.max(2, dpr * 1.5), bottom - top);
        g.fillRect(Math.round(b) - Math.max(2, dpr * 1.5), top, Math.max(2, dpr * 1.5), bottom - top);
      }
    } else if (D.loop.in >= 0) {
      const a = X(D.loop.in / sr);
      g.fillStyle = 'rgba(47,208,194,.6)'; g.fillRect(Math.round(a), top, Math.max(2, dpr * 1.5), bottom - top);
    }

    // griglia
    if (D.bpm > 0) {
      const per = 60 / D.bpm;
      const k0 = Math.ceil((t0 - D.grid) / per), k1 = Math.floor((t1 - D.grid) / per);
      const showNum = per * 4 * pxs > 70 * dpr;
      g.font = '600 ' + Math.round(11 * U * dpr) + 'px SolcoInter, sans-serif';
      g.textBaseline = 'top';
      for (let k = k0; k <= k1; k++) {
        const x = Math.round(X(D.grid + k * per));
        const bar = fmod(k, 4) === 0;
        if (bar) {
          const phrase = fmod(k, 64) === 0;
          g.fillStyle = phrase ? 'rgba(255,176,32,.5)' : 'rgba(255,255,255,.22)';
          g.fillRect(x, top - 4 * dpr, Math.max(1, Math.round(dpr * 1.2)), bottom - top + 4 * dpr);
          if (showNum && k >= 0) { g.fillStyle = phrase ? 'rgba(255,176,32,.85)' : 'rgba(255,255,255,.42)'; g.fillText(String(k / 4 + 1), x + 4 * dpr, 5 * dpr); }
        } else {
          g.fillStyle = 'rgba(255,255,255,.075)';
          g.fillRect(x, top, Math.max(1, Math.round(dpr * 0.8)), bottom - top);
        }
      }
    }

    // forma d'onda a 3 bande
    const step = Math.max(1, Math.round(dpr));
    const n = Math.ceil(W / step) + 1;
    const w = D.wave, cps = w.cps, cols = w.lo.length;
    const cpp = (step / pxs) * cps;
    const bands = [w.lo, w.mi, w.hi];
    for (let b = 0; b < 3; b++) {
      const arr = bands[b], out = bandBuf[b];
      for (let i = 0; i < n; i++) out[i] = sampleBand(arr, (t0 + (i * step) / pxs) * cps, cpp, cols);
    }
    const pal = PALETTES[S.palette] || PALETTES.solco;
    for (let b = 0; b < 3; b++) {
      const out = bandBuf[b], sc = amp * BAND_SCALE[b];
      g.fillStyle = pal[b];
      g.beginPath();
      g.moveTo(0, mid);
      for (let i = 0; i < n; i++) g.lineTo(i * step, mid - out[i] * sc);
      for (let i = n - 1; i >= 0; i--) g.lineTo(i * step, mid + out[i] * sc);
      g.closePath();
      g.fill();
    }
    // passato più scuro
    g.fillStyle = 'rgba(4,5,7,.55)';
    g.fillRect(0, 0, cx, H);

    // cue memorizzati
    g.fillStyle = '#ff4d5e';
    for (const m of D.mem) {
      const x = X(m.t);
      if (x < -10 || x > W + 10) continue;
      tri(g, x, bottom, 6 * dpr, -1);
    }
    // cue principale
    {
      const x = X(D.cue / sr);
      if (x > -20 && x < W + 20) {
        g.fillStyle = 'rgba(255,176,32,.85)';
        g.fillRect(Math.round(x) - dpr, top, Math.max(2, Math.round(dpr * 1.5)), bottom - top);
        tri(g, x, bottom + 1, 9 * dpr * U, -1);
      }
    }
    // hot cue
    g.font = '700 ' + Math.round(12 * U * dpr) + 'px SolcoInter, sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i < 8; i++) {
      const h = D.hot[i];
      if (!h) continue;
      const x = X(h.t);
      if (x < -40 || x > W + 10) continue;
      const col = HOT_COLORS[h.c != null ? h.c : i];
      g.fillStyle = col;
      g.fillRect(Math.round(x), top, Math.max(2, Math.round(dpr * 1.5)), bottom - top);
      const bw = 18 * U * dpr, bh = 18 * U * dpr;
      g.fillRect(Math.round(x), 2 * dpr, bw, bh);
      g.fillStyle = '#0a0b0d';
      g.textAlign = 'center';
      g.fillText(LETTERS[i], Math.round(x) + bw / 2, 2 * dpr + bh / 2 + 0.5);
      g.textAlign = 'left';
    }
    // testina
    g.fillStyle = '#ffffff';
    g.fillRect(cx - Math.round(dpr), 0, Math.max(2, Math.round(dpr * 2)), H);
    g.fillStyle = '#ffb020';
    tri(g, cx, 0, 8 * dpr * U, 1);
    tri(g, cx, H, 8 * dpr * U, -1);
    if (D.scratching) { g.fillStyle = 'rgba(255,176,32,.08)'; g.fillRect(0, 0, W, H); }
  }
  function tri(g, x, y, s, dir) {
    g.beginPath(); g.moveTo(x - s, y); g.lineTo(x + s, y); g.lineTo(x, y + dir * s * 1.1); g.closePath(); g.fill();
  }

  function buildOverview() {
    const W = oc.width, H = oc.height;
    if (W < 2) return;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#040507'; g.fillRect(0, 0, W, H);
    if (D.wave && D.len) {
      const w = D.wave, cols = w.lo.length;
      const mid = Math.round((H - 8 * dpr) / 2) + 1, amp = mid - 4 * dpr;
      const pal = PALETTES[S.palette] || PALETTES.solco;
      [w.lo, w.mi, w.hi].forEach((arr, b) => {
        g.fillStyle = pal[b];
        for (let x = 0; x < W; x++) {
          const a = Math.floor(x / W * cols), e = Math.max(a, Math.floor((x + 1) / W * cols) - 1);
          let m = 0;
          for (let i = a; i <= e && i < cols; i++) if (arr[i] > m) m = arr[i];
          const h = (m / 255) * amp * BAND_SCALE[b];
          if (h > 0.3) g.fillRect(x, mid - h, 1, h * 2);
        }
      });
      const dur = D.len / D.sr;
      g.fillStyle = 'rgba(255,255,255,.28)';
      for (let s = 60; s < dur; s += 60) g.fillRect(Math.round(s / dur * W), H - 6 * dpr, Math.max(1, dpr), 6 * dpr);
    }
    overBase = cv;
  }

  function drawOver() {
    const W = oc.width, H = oc.height, g = ox;
    if (overBase && overBase.width === W) g.drawImage(overBase, 0, 0);
    else { g.fillStyle = '#040507'; g.fillRect(0, 0, W, H); }
    if (!D.track || !D.len) return;
    const X = (fr) => fr / D.len * W;
    const px = X(D.posF);
    g.fillStyle = 'rgba(4,5,7,.62)';
    g.fillRect(0, 0, px, H);
    if (D.loop.in >= 0 && D.loop.out > D.loop.in) {
      g.fillStyle = D.loop.on ? 'rgba(47,208,194,.35)' : 'rgba(47,208,194,.15)';
      g.fillRect(X(D.loop.in), 0, Math.max(2, X(D.loop.out) - X(D.loop.in)), H);
    }
    g.fillStyle = '#ff4d5e';
    for (const m of D.mem) tri(g, X(m.t * D.sr), H, 5 * dpr, -1);
    g.fillStyle = '#ffb020';
    tri(g, X(D.cue), H, 7 * dpr * U, -1);
    g.font = '700 ' + Math.round(10 * U * dpr) + 'px SolcoInter, sans-serif';
    g.textBaseline = 'middle'; g.textAlign = 'center';
    for (let i = 0; i < 8; i++) {
      const h = D.hot[i];
      if (!h) continue;
      const x = X(h.t * D.sr), s = 13 * U * dpr;
      g.fillStyle = HOT_COLORS[h.c != null ? h.c : i];
      g.fillRect(Math.round(x), 0, s, s);
      g.fillStyle = '#0a0b0d';
      g.fillText(LETTERS[i], Math.round(x) + s / 2, s / 2 + 0.5);
    }
    g.textAlign = 'left';
    const rem = (D.len - D.posF) / D.sr;
    const warn = S.endWarn && D.playing && rem < S.endWarn && (Math.floor(performance.now() / 500) % 2 === 0);
    g.fillStyle = warn ? '#ff4d5e' : '#ffb020';
    g.fillRect(Math.round(px) - Math.round(dpr), 0, Math.max(2, Math.round(dpr * 2)), H);
    if (warn) { g.fillStyle = 'rgba(255,77,94,.12)'; g.fillRect(0, 0, W, H); }
  }

  /* ------------------------------ numeri e spie ------------------------------ */
  const txtCache = new Map();
  function setTxt(id, s) {
    if (txtCache.get(id) === s) return;
    txtCache.set(id, s);
    document.getElementById(id).textContent = s;
  }
  let lastBeatIdx = null;
  function updateNumbers(p) {
    if (!D.track) {
      setTxt('timeBig', '−00:00.0'); setTxt('timeSmall', '00:00.0 / 00:00'); setTxt('bpmBig', '—'); setTxt('barBig', '—');
      return;
    }
    const sec = p / D.sr, dur = D.len / D.sr, rem = Math.max(0, dur - sec);
    if (S.timeMode === 'remain') {
      setTxt('timeLbl', 'RIMANENTE'); setTxt('timeBig', '−' + fmtT(rem, true)); setTxt('timeSmall', fmtT(sec, true) + ' / ' + fmtT(dur, false));
    } else {
      setTxt('timeLbl', 'TRASCORSO'); setTxt('timeBig', fmtT(sec, true)); setTxt('timeSmall', '−' + fmtT(rem, true) + ' / ' + fmtT(dur, false));
    }
    $('.c-time').classList.toggle('warn', !!(S.endWarn && D.playing && rem < S.endWarn));
    setTxt('bpmBig', D.bpm ? (D.bpm * tempoFactor()).toFixed(2) : '—');
    if (D.bpm > 0) {
      const per = 60 / D.bpm;
      const bi = Math.floor((sec - D.grid) / per + 1e-4);
      if (bi < 0) { setTxt('barBig', '—'); if (lastBeatIdx !== -1) { lastBeatIdx = -1; setDots(-1); } }
      else {
        const bar = Math.floor(bi / 4) + 1, beat = (bi % 4) + 1;
        setTxt('barBig', bar + '.' + beat);
        if (bi !== lastBeatIdx) { lastBeatIdx = bi; setDots(bi % 4); }
      }
    } else setTxt('barBig', '—');
    let lt = '—';
    if (D.loop.in >= 0 && D.loop.out > D.loop.in) {
      const beats = beatLen() ? (D.loop.out - D.loop.in) / beatLen() : 0;
      lt = beats ? beatsLabel(Math.round(beats * 1000) / 1000) : fmtT((D.loop.out - D.loop.in) / D.sr, true);
      if (!D.loop.on) lt += ' · in pausa';
    } else if (D.loop.in >= 0) lt = 'IN impostato';
    setTxt('loopTxt', lt);
    const lc = $('#loopChip');
    if (lc.classList.contains('on') !== D.loop.on) lc.classList.toggle('on', D.loop.on);
    const ta = $('#tAuto'), tr = $('#tReloop'), canRe = !D.loop.on && D.loop.in >= 0 && D.loop.out > D.loop.in;
    if (ta.classList.contains('on') !== D.loop.on) ta.classList.toggle('on', D.loop.on);
    if (tr.classList.contains('on') !== canRe) tr.classList.toggle('on', canRe);
  }
  function beatsLabel(b) {
    if (b === 0.25) return '¼ BEAT';
    if (b === 0.5) return '½ BEAT';
    const r = Math.round(b * 100) / 100;
    return r + (r === 1 ? ' BEAT' : ' BEAT');
  }
  function setDots(k) {
    const dots = document.querySelectorAll('#beatDots i');
    dots.forEach((d, i) => { d.classList.toggle('on', i === k); d.classList.toggle('one', i === 0); });
  }
  function updateTempoUI() {
    const r = RANGES[S.rangeIdx], pct = D.pitch * r;
    setTxt('pitchPct', (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(2) + '%');
    setTxt('rangeChip', '±' + r + '%');
    setTxt('tRange', '±' + r + '%');
    $('#klChip').classList.toggle('on', S.keyLock);
    $('#tKL').classList.toggle('on', S.keyLock);
    // fader a schermo (verticale: − in alto, + in basso)
    const f = (D.pitch + 1) / 2;
    $('#tThumb').style.top = 'calc(var(--u) * 34 + (100% - var(--u) * 68) * ' + f + ')';
    const fill = $('#tFaderFill');
    fill.style.top = Math.min(50, f * 100) + '%';
    fill.style.height = Math.abs(f * 100 - 50) + '%';
    setTxt('tPct', (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(2) + '%');
    $('#tPct').classList.toggle('zero', D.pitch === 0);
    $('#tFader').classList.toggle('zero', D.pitch === 0);
  }
  function updateChips() {
    $('#chQuant').classList.toggle('on', S.quantize);
    $('#chSlip').classList.toggle('on', D.slip);
    $('#chRev').classList.toggle('on', D.reverse);
    const v = $('#chVinyl');
    v.textContent = S.jogMode === 'vinyl' ? 'VINILE' : 'SPINTA';
    v.classList.toggle('on', true);
    $('#tRev').classList.toggle('on', D.reverse);
    $('#tSlip').classList.toggle('on', D.slip);
    $('#tVinyl').classList.toggle('on', S.jogMode === 'vinyl');
    $('#tQuant').classList.toggle('on', S.quantize);
    const lb = S.loopBeats === 0.5 ? '½' : S.loopBeats === 0.25 ? '¼' : String(S.loopBeats);
    setTxt('jumpTxt', String(S.jumpBeats));
    setTxt('autoTxt', lb);
    setTxt('tAutoN', lb);
    setTxt('tJumpBN', String(S.jumpBeats));
    setTxt('tJumpFN', String(S.jumpBeats));
  }
  function updateTransport() {
    $('#tPlay').classList.toggle('lit', D.playing);
    $('#tPlay').classList.toggle('wait', !D.playing && !!D.track);
    $('#tCue').classList.toggle('lit', !D.playing && !!D.track);
  }
  function renderTrackHead() {
    const t = D.track;
    $('#tTitle').textContent = t ? t.title : 'Nessun brano caricato';
    $('#tArtist').textContent = t ? [t.artist, t.label || t.album].filter(Boolean).join(' — ') || ' ' : 'Tocca BRANI per scegliere o importare la musica';
    const art = $('#art');
    const u = artUrl(t);
    art.innerHTML = u ? '<img alt="" src="' + u + '">' : '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="16" cy="16" r="3" fill="currentColor"/></svg>';
    $('#tKey').outerHTML = keyChipHTML(t).replace('<span class="keychip', '<span id="tKey" class="keychip');
    if (t && t.key) $('#tKey').innerHTML = esc(t.camelot) + '<small>' + esc(t.key) + '</small>';
    setTxt('tBpm', t && t.bpm ? Number(t.bpm).toFixed(2) : '—');
  }

  /* ------------------------------ hot cue ------------------------------ */
  function renderHotcues() {
    const el = $('#hotcues');
    if (!el.children.length) {
      for (let i = 0; i < 8; i++) {
        const b = document.createElement('button');
        b.className = 'hc empty';
        b.innerHTML = '<span class="l">' + LETTERS[i] + '</span><span class="t"></span>';
        let lp = 0, longDone = false;
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          longDone = false;
          const existed = !!D.hot[i];
          hotDown(i);
          lp = setTimeout(() => { longDone = true; if (D.hotPreview === i) hotUp(i); if (existed && D.hot[i]) hotMenu(i); }, 700);
        });
        const up = () => { clearTimeout(lp); if (!longDone) hotUp(i); };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        el.appendChild(b);
      }
    }
    for (let i = 0; i < 8; i++) {
      const b = el.children[i], h = D.hot[i];
      b.classList.toggle('set', !!h);
      b.classList.toggle('empty', !h);
      b.style.setProperty('--hc', h ? HOT_COLORS[h.c != null ? h.c : i] : 'transparent');
      b.querySelector('.t').textContent = h ? (h.n || fmtT(h.t, true)) : (D.track ? '+ salva' : '');
    }
  }
  function flashHot(i) {
    const b = $('#hotcues').children[i];
    if (!b) return;
    b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 220);
  }
  async function hotMenu(i) {
    const btns = HOT_COLORS.map((c, k) => ({ label: '', value: 'c' + k, cls: 'swatch', style: 'background:' + c + (D.hot[i] && D.hot[i].c === k ? ';box-shadow:0 0 0 3px #fff' : '') }));
    btns.push({ label: 'ELIMINA', value: 'del', cls: 'pill' }, { label: 'CHIUDI', value: null, cls: 'pill accent' });
    const r = await modal('<h3>Hot cue ' + LETTERS[i] + '</h3>Scegli il colore o elimina la hot cue.', btns);
    if (!r || !D.hot[i]) return;
    if (r === 'del') deleteHot(i);
    else { D.hot[i].c = parseInt(r.slice(1), 10); renderHotcues(); saveCuesSoon(); }
  }

  /* ------------------------------ comandi a schermo ------------------------------ */
  function hold(el, down, up) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('down'); down(); });
    const u = () => { if (el.classList.contains('down')) { el.classList.remove('down'); if (up) up(); } };
    el.addEventListener('pointerup', u);
    el.addEventListener('pointercancel', u);
    el.addEventListener('pointerleave', u);
  }
  const tap = (id, fn) => hold($(id), fn);
  hold($('#tCue'), cueDown, cueUp);
  tap('#tPlay', play);
  let nudgeT = 0;
  const nudgeStart = (dir) => { clearInterval(nudgeT); nudgeT = setInterval(() => jog(dir * 0.0075), 20); };
  const nudgeStop = () => clearInterval(nudgeT);
  hold($('#tNudgeL'), () => nudgeStart(-1), nudgeStop);
  hold($('#tNudgeR'), () => nudgeStart(1), nudgeStop);
  tap('#tRev', toggleReverse); tap('#tSlip', toggleSlip); tap('#tVinyl', toggleJogMode); tap('#tQuant', toggleQuantize);
  tap('#tIn', loopIn); tap('#tOut', loopOut); tap('#tReloop', reloop); tap('#tAuto', autoLoop);
  tap('#tHalf', () => loopScale(0.5)); tap('#tDouble', () => loopScale(2));
  tap('#tJumpB', () => beatJump(-1)); tap('#tJumpF', () => beatJump(1));
  tap('#tRange', cycleRange); tap('#tKL', toggleKeyLock);
  // TEMPO 0 solo tenendo premuto: un tocco per sbaglio non cambia il tempo del brano in onda
  {
    const b = $('#tReset');
    let t = 0, fired = false;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.classList.add('down'); fired = false;
      clearTimeout(t); t = setTimeout(() => { fired = true; tempoReset(); }, 450);
    });
    const end = (e) => {
      if (!b.classList.contains('down')) return;
      b.classList.remove('down'); clearTimeout(t);
      if (!fired && e.type === 'pointerup') toast('Tieni premuto TEMPO 0 per azzerare il tempo');
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
  }
  // fader del tempo: si sposta solo trascinandolo, mai di colpo nel punto toccato
  {
    const fader = $('#tFader');
    let drag = null;
    fader.addEventListener('pointerdown', (e) => {
      if (drag) return;
      e.preventDefault();
      fader.setPointerCapture(e.pointerId);
      const r = fader.getBoundingClientRect();
      drag = { id: e.pointerId, y: e.clientY, p: D.pitch, h: Math.max(20, r.height - 68 * U) };
      fader.classList.add('drag');
    });
    fader.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      setPitch(drag.p + (e.clientY - drag.y) / drag.h * 2);
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) { drag = null; fader.classList.remove('drag'); } };
    fader.addEventListener('pointerup', end);
    fader.addEventListener('pointercancel', end);
  }

  /* ------------------------------ jog a schermo ------------------------------ */
  // Piatto (centro): in modo vinile il tocco ferma il brano sotto il dito e girando fai scratch.
  // Anello (bordo): accelera o frena il brano in onda; in pausa sposta il punto e lo fa sentire.
  // Un giro della jog vale S.secPerRev secondi di brano: con 1,8 s il piatto gira come un 33 giri.
  const JOG_TOP = 0.765, JOG_RING_IN = 0.785;
  const J = { id: null, zone: null, a: 0, top: false };
  let jogRing = null, jogPlatter = null, jogSheen = null, jogBuiltW = 0, jogVisible = false;

  function buildJog() {
    const W = jc.width;
    jogBuiltW = W;
    if (W < 40) { jogRing = jogPlatter = jogSheen = null; return; }
    const c = W / 2, R = c * 0.985, TAU = Math.PI * 2;
    const mk = () => { const cv = document.createElement('canvas'); cv.width = W; cv.height = W; return cv; };

    // anello fisso con la cornice
    const rc = mk();
    let g = rc.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.arc(c, c + R * 0.012, R, 0, TAU); g.fill();
    let gr = g.createRadialGradient(c, c, R * 0.9, c, c, R);
    gr.addColorStop(0, '#1b1e23'); gr.addColorStop(0.72, '#2d3139'); gr.addColorStop(1, '#0e1013');
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
    const cg = g.createConicGradient(-Math.PI / 4, c, c);
    [['#2a2e35', 0], ['#4b515c', 0.125], ['#25292f', 0.25], ['#3d424c', 0.375], ['#2a2e35', 0.5], ['#4b515c', 0.625], ['#25292f', 0.75], ['#3d424c', 0.875], ['#2a2e35', 1]]
      .forEach(([col, t]) => cg.addColorStop(t, col));
    g.fillStyle = cg; g.beginPath(); g.arc(c, c, R * 0.955, 0, TAU); g.arc(c, c, R * JOG_RING_IN, 0, TAU, true); g.fill();
    g.strokeStyle = 'rgba(8,9,11,.6)';
    for (let i = 0; i < 120; i++) {
      const a = i / 120 * TAU, long = i % 10 === 0;
      g.lineWidth = Math.max(1, R * (long ? 0.008 : 0.0045));
      const r0 = R * (long ? 0.875 : 0.9), r1 = R * 0.935;
      g.beginPath(); g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0); g.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1); g.stroke();
    }
    g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = Math.max(2, R * 0.016);
    g.beginPath(); g.arc(c, c, R * JOG_RING_IN, 0, TAU); g.stroke();
    jogRing = rc;

    // piatto che gira con il brano: solchi, etichetta e segno di posizione
    const pc = mk();
    g = pc.getContext('2d');
    const rp = R * JOG_TOP;
    g.fillStyle = '#0a0b0d'; g.beginPath(); g.arc(c, c, rp, 0, TAU); g.fill();
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const step = Math.max(1.5, W / 480);
    g.lineWidth = Math.max(1, step * 0.55);
    for (let r = R * 0.35; r < rp - step * 2; r += step) {
      const k = r / R, gap = (k > 0.5 && k < 0.515) || (k > 0.635 && k < 0.648);
      g.strokeStyle = gap ? 'rgba(255,255,255,.012)' : 'rgba(255,255,255,' + (0.028 + rnd() * 0.035).toFixed(3) + ')';
      g.beginPath(); g.arc(c, c, r, 0, TAU); g.stroke();
    }
    g.strokeStyle = '#23262c'; g.lineWidth = Math.max(2, R * 0.012);
    g.beginPath(); g.arc(c, c, rp - g.lineWidth / 2, 0, TAU); g.stroke();
    const rl = R * 0.33;
    gr = g.createRadialGradient(c, c - rl * 0.45, rl * 0.1, c, c, rl);
    gr.addColorStop(0, '#262a31'); gr.addColorStop(1, '#131519');
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, rl, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = Math.max(1, R * 0.004);
    [0.97, 0.66].forEach((k) => { g.beginPath(); g.arc(c, c, rl * k, 0, TAU); g.stroke(); });
    g.strokeStyle = '#ffb020'; g.lineCap = 'round'; g.lineWidth = Math.max(2, R * 0.02);
    g.beginPath(); g.arc(c, c, rl * 0.82, -Math.PI / 2, 0); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#eef1f5'; g.font = '700 ' + Math.round(R * 0.072) + 'px SolcoInter, sans-serif';
    if ('letterSpacing' in g) g.letterSpacing = Math.round(R * 0.016) + 'px';
    g.fillText('SOLCO', c + (('letterSpacing' in g) ? R * 0.008 : 0), c + rl * 0.4);
    g.fillStyle = '#8c939e'; g.font = '600 ' + Math.round(R * 0.042) + 'px SolcoInter, sans-serif';
    g.fillText('DECK ' + S.deck, c + (('letterSpacing' in g) ? R * 0.008 : 0), c - rl * 0.4);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    g.fillStyle = '#c9ced6'; g.beginPath(); g.arc(c, c, R * 0.03, 0, TAU); g.fill();
    g.fillStyle = '#5d636e'; g.beginPath(); g.arc(c, c, R * 0.013, 0, TAU); g.fill();
    g.lineCap = 'round'; g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = Math.max(2, R * 0.017);
    g.beginPath(); g.moveTo(c, c - rl * 1.1); g.lineTo(c, c - rp + R * 0.035); g.stroke();
    jogPlatter = pc;

    // riflesso fisso: resta fermo mentre il piatto gira sotto
    const sc = mk();
    g = sc.getContext('2d');
    g.beginPath(); g.arc(c, c, rp, 0, TAU); g.clip();
    const sg = g.createConicGradient(-Math.PI / 2, c, c);
    [[0, 0], [0.07, 0.05], [0.15, 0], [0.5, 0], [0.57, 0.035], [0.65, 0], [1, 0]].forEach(([t, a]) => sg.addColorStop(t, 'rgba(255,255,255,' + a + ')'));
    g.fillStyle = sg; g.fillRect(0, 0, W, W);
    jogSheen = sc;
  }

  function drawJog(now) {
    const W = jc.width, g = jx;
    if (!jogRing || W !== jogBuiltW) return;
    const c = W / 2, R = c * 0.985, TAU = Math.PI * 2;
    g.clearRect(0, 0, W, W);
    g.drawImage(jogRing, 0, 0);
    const rev = D.track && D.sr ? D.posF / D.sr / S.secPerRev : 0;
    g.save(); g.translate(c, c); g.rotate((rev % 1) * TAU); g.drawImage(jogPlatter, -c, -c); g.restore();
    g.drawImage(jogSheen, 0, 0);
    // avanzamento del brano lungo la cornice
    const rr = R * 0.977;
    g.lineCap = 'butt'; g.lineWidth = Math.max(2, R * 0.02);
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.arc(c, c, rr, 0, TAU); g.stroke();
    if (D.track && D.len) {
      const f = clamp(D.posF / D.len, 0, 1), rem = (D.len - D.posF) / D.sr;
      const warn = S.endWarn && D.playing && rem < S.endWarn;
      g.strokeStyle = warn && Math.floor(now / 500) % 2 === 0 ? '#ff4d5e' : '#ffb020';
      if (f > 0.0005) { g.beginPath(); g.arc(c, c, rr, -Math.PI / 2, -Math.PI / 2 + f * TAU); g.stroke(); }
    }
    // dito sull'anello o sul piatto
    if (J.zone === 'ring' || (J.zone === 'top' && !J.top)) {
      g.strokeStyle = 'rgba(255,176,32,.17)'; g.lineWidth = R * (0.955 - JOG_RING_IN);
      g.beginPath(); g.arc(c, c, R * (0.955 + JOG_RING_IN) / 2, 0, TAU); g.stroke();
    }
    if (J.top) {
      g.strokeStyle = 'rgba(255,176,32,.2)'; g.lineWidth = R * 0.06;
      g.beginPath(); g.arc(c, c, R * (JOG_TOP - 0.035), 0, TAU); g.stroke();
      g.strokeStyle = '#ffb020'; g.lineWidth = Math.max(2, R * 0.012);
      g.beginPath(); g.arc(c, c, R * JOG_TOP - g.lineWidth / 2, 0, TAU); g.stroke();
    }
  }

  function jogPoint(e) {
    const r = jc.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    return { a: Math.atan2(dy, dx), d: Math.hypot(dx, dy) / (r.width / 2 * 0.985) };
  }
  jc.addEventListener('pointerdown', (e) => {
    if (J.id !== null) return;
    const p = jogPoint(e);
    if (p.d > 1) return;
    e.preventDefault();
    jc.setPointerCapture(e.pointerId);
    J.id = e.pointerId; J.a = p.a;
    J.zone = p.d < JOG_RING_IN ? 'top' : 'ring';
    if (J.zone === 'top' && S.jogMode === 'vinyl' && D.track) { J.top = true; jogTouch(true); }
  });
  jc.addEventListener('pointermove', (e) => {
    if (e.pointerId !== J.id) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    let sum = 0;
    for (const ev of (evs.length ? evs : [e])) {
      const p = jogPoint(ev);
      let da = p.a - J.a;
      if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      J.a = p.a;
      if (p.d > 0.12) sum += da;          // vicino al perno l'angolo non è affidabile
    }
    if (sum) jog(sum / (2 * Math.PI));
  });
  const jogEnd = (e) => {
    if (e.pointerId !== J.id) return;
    if (J.top) jogTouch(false);
    J.id = null; J.zone = null; J.top = false;
  };
  jc.addEventListener('pointerup', jogEnd);
  jc.addEventListener('pointercancel', jogEnd);
  jc.addEventListener('contextmenu', (e) => e.preventDefault());

  /* --------------------- tocco sulle forme d'onda --------------------- */
  {
    const ptrs = new Map();
    let pinch = null, dragX = null, lastTapT = 0;
    zc.addEventListener('pointerdown', (e) => {
      zc.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: S.zoomSec };
        dragX = null;
      } else {
        const now = performance.now();
        if (now - lastTapT < 300) { S.zoomSec = DEFAULTS.zoomSec; saveSettings(); }
        lastTapT = now;
        dragX = (!D.playing && D.track) ? e.clientX : null;
      }
    });
    zc.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        S.zoomSec = clamp(pinch.z * pinch.d / d, 1.5, 30);
      } else if (dragX !== null && !D.playing) {
        const dx = e.clientX - dragX;
        dragX = e.clientX;
        const pxs = zc.width / S.zoomSec;
        const sec = -dx * dpr / pxs;
        jog(sec / S.secPerRev);
      }
    });
    const end = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2 && pinch) { pinch = null; saveSettings(); }
      if (!ptrs.size) dragX = null;
    };
    zc.addEventListener('pointerup', end);
    zc.addEventListener('pointercancel', end);

    const needle = (e) => {
      if (!D.track || !D.len) return;
      if (D.playing && S.needle !== 'always') { if (e.type === 'pointerdown') toast('Metti in pausa per spostarti (o cambia l’impostazione)'); return; }
      const r = oc.getBoundingClientRect();
      const f = clamp((e.clientX - r.left) / r.width, 0, 1);
      engine.send({ t: 'seek', to: f * D.len });
    };
    oc.addEventListener('pointerdown', (e) => { oc.setPointerCapture(e.pointerId); needle(e); });
    oc.addEventListener('pointermove', (e) => { if (oc.hasPointerCapture(e.pointerId)) needle(e); });
  }

  /* ------------------------------ libreria ------------------------------ */
  let brSel = null, brCompat = false, brQuery = '';
  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  async function thumb(artwork) {
    try {
      const blob = new Blob([artwork.data], { type: artwork.mime || 'image/jpeg' });
      const bmp = await createImageBitmap(blob);
      const s = 160, c = document.createElement('canvas');
      c.width = s; c.height = s;
      const g = c.getContext('2d');
      const r = Math.max(s / bmp.width, s / bmp.height);
      g.drawImage(bmp, (s - bmp.width * r) / 2, (s - bmp.height * r) / 2, bmp.width * r, bmp.height * r);
      return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    } catch (e) { return null; }
  }
  async function importFiles(files) {
    const list = [...files].filter((f) => /\.(mp3|wav|aiff?|flac|m4a|aac|ogg|opus|mp4)$/i.test(f.name) || /^audio\//.test(f.type));
    if (!list.length) { toast('Nessun file audio tra quelli scelti'); return; }
    lib.persist();
    let added = 0, skipped = 0;
    for (let k = 0; k < list.length; k++) {
      const f = list[k];
      const id = 't' + hashStr(f.name + '|' + f.size + '|' + f.lastModified);
      if (tracks.some((t) => t.id === id)) { skipped++; continue; }
      setBusy('Importo ' + (k + 1) + '/' + list.length + '…');
      let tags = {};
      try { tags = SolcoMedia.readTags(await f.arrayBuffer(), f.name); } catch (e) { tags = SolcoMedia.readTags(new ArrayBuffer(0), f.name); }
      const art = tags.artwork ? await thumb(tags.artwork) : null;
      const t = {
        id, title: tags.title || f.name, artist: tags.artist || '', album: tags.album || '', genre: tags.genre || '',
        label: tags.label || '', year: tags.year || '', fileName: f.name, size: f.size, type: f.type,
        added: Date.now() + k, tagBpm: tags.bpm || 0, tagKey: tags.key || '', art,
        analyzed: false, plays: 0, cue: null, hot: [], mem: [],
      };
      try {
        await lib.putFile(id, f);
        await saveTrack(t);
        tracks.push(t); added++;
      } catch (e) {
        toast('Spazio esaurito o errore di archivio: ' + (e && e.message || e), 4000);
        break;
      }
      if (k % 5 === 0) renderList();
    }
    renderList();
    toast(added + (added === 1 ? ' brano importato' : ' brani importati') + (skipped ? ' (' + skipped + ' già presenti)' : ''));
    setBusy(analysisBusyText());
    runAnalysisQueue();
  }

  let anaRunning = false;
  function analysisBusyText() {
    const todo = tracks.filter((t) => !t.analyzed && !t.anaFailed).length;
    return todo ? 'Analisi: ' + todo + ' da fare' : null;
  }
  async function runAnalysisQueue() {
    if (anaRunning) return;
    anaRunning = true;
    try {
      for (;;) {
        const t = tracks.find((x) => !x.analyzed && !x.anaFailed);
        if (!t) break;
        if (D.loading) { await sleep(400); continue; }
        t.analyzing = true; updateRow(t); setBusy(analysisBusyText());
        try {
          const blob = await lib.getFile(t.id);
          const ch = await engine.decode(await blob.arrayBuffer());
          const res = await analyzer.run(SolcoEngine.mixMono(ch), engine.sr);
          applyAnalysis(t, res);
          await lib.putWave(t.id, res.wave);
        } catch (e) {
          t.anaFailed = true; t.error = String(e && e.message || e);
        }
        t.analyzing = false;
        await saveTrack(t);
        updateRow(t);
        setBusy(analysisBusyText());
        updateBrStatus();
        await sleep(30);
      }
    } finally {
      anaRunning = false;
      setBusy(analysisBusyText());
    }
  }

  function compatible(a, b) {
    if (!b.bpm || !a.bpm) return false;
    const ratio = b.bpm / a.bpm;
    const bpmOk = [1, 2, 0.5].some((m) => Math.abs(ratio * m - 1) <= 0.06);
    if (!a.camelot || !b.camelot) return bpmOk;
    const na = parseInt(a.camelot, 10), nb = parseInt(b.camelot, 10);
    const la = a.camelot.slice(-1), lb = b.camelot.slice(-1);
    const d = Math.abs(na - nb);
    return bpmOk && (na === nb || (la === lb && (d === 1 || d === 11)));
  }
  function camOrder(t) { if (!t.camelot) return 99; return parseInt(t.camelot, 10) * 2 + (t.camelot.endsWith('B') ? 1 : 0); }
  function filtered() {
    let arr = tracks.slice();
    if (brQuery) {
      const q = normTxt(brQuery);
      arr = arr.filter((t) => normTxt(t.title + ' ' + t.artist + ' ' + t.album + ' ' + t.label + ' ' + t.genre).includes(q));
    }
    if (brCompat && D.track) arr = arr.filter((t) => t.id !== D.track.id && compatible(D.track, t));
    const s = S.sort;
    const cmp = {
      added: (a, b) => b.added - a.added,
      title: (a, b) => normTxt(a.title).localeCompare(normTxt(b.title)),
      artist: (a, b) => normTxt(a.artist).localeCompare(normTxt(b.artist)) || normTxt(a.title).localeCompare(normTxt(b.title)),
      bpm: (a, b) => (a.bpm || 999) - (b.bpm || 999),
      key: (a, b) => camOrder(a) - camOrder(b) || (a.bpm || 0) - (b.bpm || 0),
    }[s] || ((a, b) => b.added - a.added);
    arr.sort(cmp);
    return arr;
  }
  function rowHTML(t) {
    const u = artUrl(t);
    const played = t.lastPlayed && Date.now() - t.lastPlayed < 12 * 3600 * 1000;
    let status = '';
    if (t.analyzing) status = '<span class="spin"></span>';
    else if (t.anaFailed) status = '<span title="' + esc(t.error) + '">!</span>';
    else if (!t.analyzed) status = '·';
    else if (played) status = '✓';
    const cls = 'row' + (brSel === t.id ? ' sel' : '') + (D.track && D.track.id === t.id ? ' loaded' : '') + (played ? ' played' : '');
    return '<div class="' + cls + '" data-id="' + t.id + '">' +
      '<div class="ra">' + (u ? '<img alt="" loading="lazy" src="' + u + '">' : '') + '</div>' +
      '<div class="rt"><b>' + esc(t.title) + '</b><span>' + esc(t.artist || '—') + '</span></div>' +
      '<div class="rb">' + (t.bpm ? Number(t.bpm).toFixed(2) : (t.analyzed ? '—' : '')) + '</div>' +
      '<div class="rk">' + keyChipHTML(t) + '</div>' +
      '<div class="rd">' + (t.duration ? fmtDur(t.duration) : '') + '</div>' +
      '<div class="rs">' + status + '</div></div>';
  }
  function renderList() {
    const list = $('#brList');
    const arr = filtered();
    if (!tracks.length) {
      list.innerHTML = '<div class="br-empty"><b>La libreria è vuota.</b><br>Tocca <b>+ IMPORTA</b> e scegli i file audio salvati sul tablet<br>(MP3, AIFF, WAV, FLAC, M4A). Vengono copiati nell’app e analizzati una volta sola.</div>';
    } else if (!arr.length) {
      list.innerHTML = '<div class="br-empty">Nessun brano corrisponde' + (brCompat ? ' (filtro COMPATIBILI attivo)' : '') + '.</div>';
    } else list.innerHTML = arr.map(rowHTML).join('');
    updateBrStatus();
  }
  function updateRow(t) {
    const el = $('#brList').querySelector('[data-id="' + t.id + '"]');
    if (el) el.outerHTML = rowHTML(t);
  }
  function updateBrStatus() {
    const todo = tracks.filter((t) => !t.analyzed && !t.anaFailed).length;
    const sel = tracks.find((t) => t.id === brSel);
    $('#brStatus').textContent = sel ? sel.title + (sel.artist ? ' — ' + sel.artist : '') :
      (tracks.length + (tracks.length === 1 ? ' brano' : ' brani') + (todo ? ' · ' + todo + ' da analizzare' : ''));
    $('#brLoad').disabled = !sel;
  }
  function openBrowser() {
    $('#browser').classList.remove('hidden');
    $('#btnBrowse').classList.add('active');
    if (!brSel && D.track) brSel = D.track.id;
    renderList();
    const el = $('#brList').querySelector('.row.sel');
    if (el) el.scrollIntoView({ block: 'center' });
  }
  function closeBrowser() { $('#browser').classList.add('hidden'); $('#btnBrowse').classList.remove('active'); }
  function closeAll() { closeBrowser(); $('#settings').classList.add('hidden'); midi.cancelLearn(); }
  function selectRow(id, scroll) {
    brSel = id;
    $('#brList').querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel'));
    const el = $('#brList').querySelector('[data-id="' + id + '"]');
    if (el) { el.classList.add('sel'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
    updateBrStatus();
  }
  function browseMove(steps) {
    if ($('#browser').classList.contains('hidden')) { openBrowser(); return; }
    const arr = filtered();
    if (!arr.length) return;
    let i = arr.findIndex((t) => t.id === brSel);
    i = clamp((i < 0 ? 0 : i + (steps > 0 ? 1 : -1)), 0, arr.length - 1);
    selectRow(arr[i].id, true);
  }
  function browseLoad() {
    if ($('#browser').classList.contains('hidden')) { openBrowser(); return; }
    const t = tracks.find((x) => x.id === brSel);
    if (t) loadTrack(t);
  }
  function trackStep(dir) {
    if (!$('#browser').classList.contains('hidden')) { browseMove(dir); return; }
    if (D.playing) { toast('Metti in pausa per cambiare brano'); return; }
    const arr = filtered();
    if (!arr.length) return;
    let i = D.track ? arr.findIndex((t) => t.id === D.track.id) : -1;
    i = clamp(i + dir, 0, arr.length - 1);
    loadTrack(arr[i]);
  }
  async function rowMenu(t) {
    const r = await modal('<h3>' + esc(t.title) + '</h3>' + esc(t.artist || '') + (t.error ? '<br><small>Errore: ' + esc(t.error) + '</small>' : ''), [
      { label: 'ELIMINA', value: 'del' }, { label: 'RIANALIZZA', value: 'ana' }, { label: 'CHIUDI', value: null }, { label: 'CARICA', value: 'load', cls: 'pill accent' },
    ]);
    if (r === 'load') loadTrack(t);
    if (r === 'ana') { t.analyzed = false; delete t.anaFailed; await saveTrack(t); updateRow(t); runAnalysisQueue(); }
    if (r === 'del') {
      if (D.track && D.track.id === t.id) { toast('Il brano è caricato nel lettore'); return; }
      if (await confirmBox('Eliminare <b>' + esc(t.title) + '</b> dalla libreria dell’app? Il file originale sul tablet non viene toccato.', 'ELIMINA')) {
        await lib.deleteTrack(t.id);
        tracks = tracks.filter((x) => x.id !== t.id);
        renderList();
      }
    }
  }
  {
    const list = $('#brList');
    let lpT = 0, lastTap = { id: null, t: 0 }, startY = 0, moved = false;
    list.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      startY = e.clientY; moved = false;
      const id = row.dataset.id;
      lpT = setTimeout(() => { if (!moved) { const t = tracks.find((x) => x.id === id); if (t) { lastTap = { id: null, t: 0 }; rowMenu(t); } } lpT = 0; }, 650);
    });
    list.addEventListener('pointermove', (e) => { if (Math.abs(e.clientY - startY) > 8) { moved = true; clearTimeout(lpT); } });
    list.addEventListener('pointerup', (e) => {
      const row = e.target.closest('.row');
      const wasLong = !lpT; clearTimeout(lpT); lpT = 0;
      if (!row || moved || wasLong) return;
      const id = row.dataset.id, now = performance.now();
      if (lastTap.id === id && now - lastTap.t < 380) { const t = tracks.find((x) => x.id === id); if (t) loadTrack(t); lastTap = { id: null, t: 0 }; return; }
      lastTap = { id, t: now };
      selectRow(id);
    });
    list.addEventListener('pointercancel', () => { clearTimeout(lpT); lpT = 0; });
  }
  $('#btnBrowse').addEventListener('click', () => ($('#browser').classList.contains('hidden') ? openBrowser() : closeBrowser()));
  $('#brClose').addEventListener('click', closeBrowser);
  $('#brImport').addEventListener('click', () => { if (window.SolcoAndroid && window.SolcoAndroid.pickFiles) window.SolcoAndroid.pickFiles(); else $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  $('#brLoad').addEventListener('click', browseLoad);
  $('#brSearch').addEventListener('input', (e) => { brQuery = e.target.value; renderList(); });
  $('#brCompat').addEventListener('click', () => {
    if (!D.track) { toast('Carica prima un brano: mostro quelli compatibili per BPM e tonalità'); return; }
    brCompat = !brCompat; $('#brCompat').classList.toggle('on', brCompat); renderList();
  });
  $('#brSort').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setS('sort', b.dataset.s);
    $('#brSort').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  });
  // file passati dall'app Android (selettore nativo)
  window.solcoImportFiles = (files) => importFiles(files);

  /* ------------------------------ impostazioni ------------------------------ */
  const SPEC = {
    Lettore: [
      { sec: 'Deck' },
      { k: 'deck', label: 'Numero del lettore', desc: 'Compare in alto: utile per distinguere i due tablet.', type: 'seg', opts: [[1, '1'], [2, '2']] },
      { sec: 'Jog' },
      { k: 'jogMode', label: 'Modalità jog', desc: 'Vinile: toccando il centro della jog fermi il brano e girando fai scratch; il bordo accelera o frena. Solo spinta: tutta la jog accelera o frena soltanto.', type: 'seg', opts: [['vinyl', 'VINILE'], ['cdj', 'SOLO SPINTA']] },
      { k: 'secPerRev', label: 'Scratch: musica per giro di jog', desc: '1,8 s equivale a un vinile a 33 giri: la jog a schermo gira proprio così.', type: 'range', min: 0.6, max: 3.6, step: 0.1, fmt: (v) => v.toFixed(1).replace('.', ',') + ' s' },
      { k: 'nudgeGain', label: 'Sensibilità della spinta', desc: 'Quanto accelera o rallenta il brano quando giri il bordo della jog.', type: 'range', min: 0.03, max: 0.35, step: 0.01, fmt: (v) => Math.round(v * 100) },
      { k: 'brakeSec', label: 'Frenata in pausa', desc: '0 = stop immediato. Valori più alti imitano un giradischi che si ferma.', type: 'range', min: 0, max: 2, step: 0.05, fmt: (v) => (v ? v.toFixed(2).replace('.', ',') + ' s' : 'istantanea') },
      { k: 'startSec', label: 'Avvio in play', type: 'range', min: 0, max: 2, step: 0.05, fmt: (v) => (v ? v.toFixed(2).replace('.', ',') + ' s' : 'istantaneo') },
      { sec: 'Tempo' },
      { k: 'rangeIdx', label: 'Range del fader tempo', type: 'seg', opts: RANGES.map((r, i) => [i, '±' + r + '%']) },
      { k: 'keyLock', label: 'Key lock', desc: 'Cambiando il tempo l’intonazione resta uguale.', type: 'toggle' },
      { k: 'invertFader', label: 'Inverti il fader tempo fisico', type: 'toggle' },
      { sec: 'Cue, loop e salti' },
      { k: 'quantize', label: 'Quantize', desc: 'Cue, hot cue e loop si agganciano alla griglia delle battute.', type: 'toggle' },
      { k: 'autoCue', label: 'Cue automatico sul primo battito', type: 'toggle' },
      { k: 'jumpBeats', label: 'Beat jump', type: 'seg', opts: [[1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16'], [32, '32']] },
      { k: 'loopBeats', label: 'Auto loop', type: 'seg', opts: LOOP_SIZES.map((b) => [b, b === 0.25 ? '¼' : b === 0.5 ? '½' : String(b)]) },
      { k: 'needle', label: 'Ricerca toccando la panoramica', desc: 'Per sicurezza, di default funziona solo in pausa.', type: 'seg', opts: [['paused', 'SOLO IN PAUSA'], ['always', 'SEMPRE']] },
    ],
    Schermo: [
      { k: 'orient', label: 'Orientamento', desc: 'Resta bloccato, così il tablet non gira da solo durante la serata. In verticale la jog è più grande.', type: 'seg', opts: [['portrait', 'VERTICALE'], ['landscape', 'ORIZZONTALE'], ['auto', 'AUTOMATICO']] },
      { k: 'timeMode', label: 'Tempo in grande', type: 'seg', opts: [['remain', 'RIMANENTE'], ['elapsed', 'TRASCORSO']] },
      { k: 'endWarn', label: 'Avviso di fine brano', type: 'seg', opts: [[0, 'NO'], [30, '30 s'], [60, '60 s']] },
      { k: 'palette', label: 'Colori della forma d’onda', type: 'seg', opts: [['solco', 'SOLCO'], ['ambra', 'AMBRA'], ['mono', 'MONO']] },
      { k: 'zoomSec', label: 'Zoom della forma d’onda', desc: 'Anche con due dita sulla forma d’onda; doppio tocco per tornare al valore iniziale.', type: 'range', min: 1.5, max: 30, step: 0.5, fmt: (v) => String(v).replace('.', ',') + ' s' },
      { k: 'touchControls', label: 'Comandi a schermo', desc: 'Automatico: jog e tasti a schermo restano visibili finché non colleghi la jog fisica.', type: 'seg', opts: [['auto', 'AUTOMATICO'], ['on', 'SEMPRE'], ['off', 'MAI']] },
    ],
  };
  const TABS = ['Lettore', 'Schermo', 'Comandi', 'Libreria', 'Info'];
  let curTab = 'Lettore';
  function openSettings() {
    $('#settings').classList.remove('hidden');
    renderSettings();
  }
  function renderSettings() {
    const tabs = $('#setTabs');
    tabs.innerHTML = TABS.map((t) => '<button data-t="' + t + '" class="' + (t === curTab ? 'on' : '') + '">' + t.toUpperCase() + '</button>').join('');
    const body = $('#setBody');
    body.innerHTML = '';
    if (SPEC[curTab]) SPEC[curTab].forEach((it) => body.appendChild(settingRow(it)));
    else if (curTab === 'Comandi') renderMidiTab(body);
    else if (curTab === 'Libreria') renderLibTab(body);
    else renderInfoTab(body);
  }
  function settingRow(it) {
    if (it.sec) { const d = document.createElement('div'); d.className = 'set-sec'; d.textContent = it.sec.toUpperCase(); return d; }
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = '<div><div class="sl">' + esc(it.label) + '</div>' + (it.desc ? '<div class="sd">' + esc(it.desc) + '</div>' : '') + '</div><div class="set-ctl"></div>';
    const ctl = row.querySelector('.set-ctl');
    if (it.type === 'seg') {
      const seg = document.createElement('div');
      seg.className = 'seg';
      it.opts.forEach(([v, l]) => {
        const b = document.createElement('button');
        b.textContent = l;
        if (S[it.k] === v) b.className = 'on';
        b.onclick = () => { setS(it.k, v); seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
        seg.appendChild(b);
      });
      ctl.appendChild(seg);
    } else if (it.type === 'toggle') {
      const t = document.createElement('button');
      t.className = 'toggle' + (S[it.k] ? ' on' : '');
      t.onclick = () => { setS(it.k, !S[it.k]); t.classList.toggle('on', !!S[it.k]); };
      ctl.appendChild(t);
    } else if (it.type === 'range') {
      const r = document.createElement('input');
      r.type = 'range'; r.min = it.min; r.max = it.max; r.step = it.step; r.value = S[it.k];
      const v = document.createElement('span');
      v.className = 'rv'; v.textContent = it.fmt(S[it.k]);
      r.oninput = () => { const x = parseFloat(r.value); v.textContent = it.fmt(x); setS(it.k, x); };
      r.style.touchAction = 'pan-x';
      ctl.appendChild(r); ctl.appendChild(v);
    }
    return row;
  }
  let monLines = [];
  function renderMidiTab(body) {
    const devs = midi.devices;
    body.innerHTML =
      '<div class="set-sec">CONTROLLER</div>' +
      '<div class="set-row"><div><div class="sl">' + (devs.length ? esc(devs.join(', ')) : 'Nessun controller collegato') + '</div>' +
      '<div class="sd">' + (navigator.requestMIDIAccess || isAndroidApp ? 'Collega la jog con il cavo USB: viene riconosciuta da sola.' : 'Questo browser non supporta i controller MIDI: usa Chrome o l’app SOLCO.') + '</div></div>' +
      '<div class="set-ctl"><button class="pill" id="mReset">MAPPATURA SOLCO</button></div></div>' +
      '<div class="set-row"><div><div class="sl">Jog di altri controller: scatti per giro</div><div class="sd">Serve solo per controller diversi dalla jog SOLCO, se lo scratch risulta troppo veloce o lento.</div></div><div class="set-ctl"><input type="range" min="128" max="4096" step="64" id="mTicks" value="' + S.ticksPerRev + '"><span class="rv" id="mTicksV">' + S.ticksPerRev + '</span></div></div>' +
      '<div class="set-sec">ASSEGNA I COMANDI</div><div class="sd" style="margin:6px 0 4px">Tocca ASSEGNA, poi muovi o premi il comando sul controller.</div>' +
      '<div class="map-grid" id="mGrid"></div>' +
      '<div class="set-sec">MONITOR MIDI</div><div class="mon" id="mMon">' + esc(monLines.join('\n') || 'Premi un tasto sul controller per vedere cosa arriva.') + '</div>';
    const grid = body.querySelector('#mGrid');
    SolcoMidi.FUNCS.forEach(([fn, label]) => {
      const r = document.createElement('div');
      r.className = 'map-row';
      r.innerHTML = '<span>' + esc(label) + '</span><span class="mv">' + esc(midi.describe(fn)) + '</span><button>ASSEGNA</button>';
      r.querySelector('button').onclick = () => {
        grid.querySelectorAll('.map-row').forEach((x) => x.classList.remove('learning'));
        r.classList.add('learning');
        r.querySelector('button').textContent = 'IN ATTESA…';
        midi.learn(fn, () => { lib.setKV('midiMap', midi.map).catch(() => {}); renderSettings(); toast(label + ' assegnato'); });
      };
      grid.appendChild(r);
    });
    body.querySelector('#mReset').onclick = () => { midi.resetMap(); lib.setKV('midiMap', midi.map).catch(() => {}); renderSettings(); toast('Mappatura SOLCO ripristinata'); };
    const ticks = body.querySelector('#mTicks');
    ticks.style.touchAction = 'pan-x';
    ticks.oninput = () => { body.querySelector('#mTicksV').textContent = ticks.value; setS('ticksPerRev', parseInt(ticks.value, 10)); };
  }
  midi.monitor = (ev) => {
    const s = ev.type === 'note' ? 'Nota ' + ev.num + (ev.val ? ' giù' : ' su') : ev.type === 'cc' ? 'CC ' + ev.num + ' = ' + ev.val : 'Pitch bend = ' + ev.val;
    monLines.unshift('can. ' + (ev.ch + 1) + '  ' + s);
    monLines = monLines.slice(0, 8);
    const m = document.getElementById('mMon');
    if (m) m.textContent = monLines.join('\n');
  };
  async function renderLibTab(body) {
    const est = await lib.estimate();
    const used = est && est.usage ? (est.usage / 1e9).toFixed(2).replace('.', ',') + ' GB' : '—';
    const free = est && est.quota ? ((est.quota - est.usage) / 1e9).toFixed(1).replace('.', ',') + ' GB' : '—';
    body.innerHTML =
      '<div class="set-row"><div><div class="sl">' + tracks.length + ' brani nella libreria</div><div class="sd">Spazio usato ' + used + ' · disponibile ' + free + '</div></div><div class="set-ctl"><button class="pill accent" id="lImp">+ IMPORTA</button></div></div>' +
      '<div class="set-row"><div><div class="sl">Rianalizza tutti i brani</div><div class="sd">Ricalcola BPM, griglia e tonalità. Cue e hot cue restano.</div></div><div class="set-ctl"><button class="pill" id="lAna">RIANALIZZA</button></div></div>' +
      '<div class="set-row"><div><div class="sl">Svuota la libreria</div><div class="sd">Toglie tutti i brani dall’app. I file originali sul tablet restano dove sono.</div></div><div class="set-ctl"><button class="pill" id="lClr">SVUOTA</button></div></div>';
    body.querySelector('#lImp').onclick = () => $('#brImport').click();
    body.querySelector('#lAna').onclick = async () => {
      for (const t of tracks) { t.analyzed = false; delete t.anaFailed; await saveTrack(t); }
      runAnalysisQueue(); toast('Analisi avviata');
    };
    body.querySelector('#lClr').onclick = async () => {
      if (D.track) { toast('Prima scarica il brano dal lettore (ricarica l’app)'); return; }
      if (!(await confirmBox('<h3>Svuotare la libreria?</h3>Tutti i brani, cue e hot cue verranno tolti dall’app.', 'SVUOTA'))) return;
      await lib.clearAll(); tracks = []; renderList(); renderSettings();
    };
  }
  function renderInfoTab(body) {
    body.innerHTML = '<div class="info-txt" style="margin-top:14px">' +
      '<b>SOLCO ' + VERSION + '</b> — lettore per DJ. Motore audio: ' + (engine.mode === 'worklet' ? 'AudioWorklet' : engine.mode === 'script' ? 'compatibilità' : 'non avviato') + (engine.ctx ? ' · ' + engine.ctx.sampleRate + ' Hz' : '') + '.<br><br>' +
      '<b>Cue</b>: in pausa imposta il punto di cue e, tenendolo premuto, lo ascolti; mentre suoni torna al cue e si ferma. Premendo Play mentre tieni Cue, il brano continua.<br>' +
      '<b>Hot cue</b>: tocca una casella vuota per salvarla, tocca una piena per saltarci. Tieni premuto per colore ed eliminazione.<br>' +
      '<b>Loop</b>: IN e OUT, oppure AUTO per un loop della lunghezza scelta. ½ e ×2 lo accorciano o allungano. RELOOP lo riattiva.<br>' +
      '<b>Slip</b>: durante scratch, reverse e loop il brano continua ad andare avanti “sotto”; quando smetti riparte da lì.<br>' +
      '<b>Jog a schermo</b>: il bordo accelera o frena il brano in onda (in pausa sposta il punto). In modo VINILE, toccando il centro fermi il brano e girando fai scratch. I tasti ◀ ▶ accanto alla jog spingono a velocità costante.<br>' +
      '<b>Fader tempo</b>: si muove solo trascinandolo (− in alto, + in basso). TEMPO 0 va tenuto premuto. Cambiando il range il tempo resta lo stesso.<br>' +
      '<b>Forma d’onda</b>: in pausa trascinala con il dito per cercare il punto, con due dita cambi lo zoom.<br><br>' +
      'Tastiera (se colleghi una tastiera): Spazio play, C cue, 1–8 hot cue, I/O loop, L reloop, A auto loop, frecce spinta, [ ] beat jump, K key lock, B brani.<br><br>' +
      'Carattere Inter (licenza SIL OFL).</div>';
  }
  $('#btnSettings').addEventListener('click', openSettings);
  $('#setClose').addEventListener('click', () => { $('#settings').classList.add('hidden'); midi.cancelLearn(); });
  $('#setTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; curTab = b.dataset.t; midi.cancelLearn(); renderSettings(); });

  /* ------------------------------ varie ------------------------------ */
  $('#btnFull').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); if (S.orient !== 'auto') { try { await screen.orientation.lock(S.orient); } catch (e) { /* niente */ } } }
      else await document.exitFullscreen();
    } catch (e) { toast('Schermo intero non disponibile qui'); }
  });
  function tickClock() {
    const d = new Date();
    setTxt('clock', String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
  }
  setInterval(tickClock, 10000);

  // tastiera
  const keyDown = new Set();
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (keyDown.has(e.code)) return;
    keyDown.add(e.code);
    const c = e.code;
    if (c === 'Space') { e.preventDefault(); play(); }
    else if (c === 'KeyC') cueDown();
    else if (/^Digit[1-8]$/.test(c)) hotDown(parseInt(c.slice(5), 10) - 1);
    else if (c === 'KeyI') loopIn();
    else if (c === 'KeyO') loopOut();
    else if (c === 'KeyL') reloop();
    else if (c === 'KeyA') autoLoop();
    else if (c === 'ArrowLeft') nudgeStart(-1);
    else if (c === 'ArrowRight') nudgeStart(1);
    else if (c === 'BracketLeft') beatJump(-1);
    else if (c === 'BracketRight') beatJump(1);
    else if (c === 'KeyK') toggleKeyLock();
    else if (c === 'KeyR') toggleReverse();
    else if (c === 'KeyS') toggleSlip();
    else if (c === 'KeyQ') toggleQuantize();
    else if (c === 'KeyB') ($('#browser').classList.contains('hidden') ? openBrowser() : closeBrowser());
    else if (c === 'ArrowUp') setPitch(D.pitch + 0.01);
    else if (c === 'ArrowDown') setPitch(D.pitch - 0.01);
    else if (c === 'Escape') closeAll();
  });
  document.addEventListener('keyup', (e) => {
    keyDown.delete(e.code);
    const c = e.code;
    if (c === 'KeyC') cueUp();
    else if (/^Digit[1-8]$/.test(c)) hotUp(parseInt(c.slice(5), 10) - 1);
    else if (c === 'ArrowLeft' || c === 'ArrowRight') nudgeStop();
  });

  /* ------------------------------ ciclo di disegno ------------------------------ */
  let lastUi = 0, lastT = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (D.track) D.posF = engine.estimate();
    drawZoom();
    drawOver();
    if (jogVisible) drawJog(now);
    if (now - lastUi > 45) { lastUi = now; updateNumbers(D.posF); }
    const dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    if (D.track && D.playing && !D.countedPlay) {
      D.playSec += dt;
      if (D.playSec > 30) { D.countedPlay = true; D.track.plays = (D.track.plays || 0) + 1; D.track.lastPlayed = Date.now(); saveTrack(D.track); }
    }
  }

  /* ------------------------------ avvio ------------------------------ */
  async function init() {
    try {
      const saved = await lib.getKV('settings');
      if (saved) S = Object.assign({}, DEFAULTS, saved);
      const map = await lib.getKV('midiMap');
      if (map) midi.setMap(map);
      tracks = await lib.allTracks();
      tracks.forEach((t) => { delete t.analyzing; });
      if (lib.memoryOnly) toast('Qui la libreria non può essere salvata: i brani restano finché non chiudi la pagina', 5000);
    } catch (e) {
      toast('Archivio non disponibile: la libreria non verrà salvata', 4000);
    }
    midi.ticksPerRev = S.ticksPerRev;
    if (isAndroidApp) document.documentElement.classList.add('android');
    applyOrientation();
    $('#deckName').textContent = 'DECK ' + S.deck;
    $('#brSort').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.s === S.sort));
    renderHotcues(); updateChips(); updateTempoUI(); updateTransport(); tickClock(); updateTouchVisibility();
    resize();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => buildJog());
    requestAnimationFrame(frame);
    setBusy(analysisBusyText());
    if (isAndroidApp) { startAudio().catch(() => {}); }
    runAnalysisQueue();
    if ('serviceWorker' in navigator && location.protocol === 'https:' && !singleFile && !isAndroidApp) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  $('#gateBtn').addEventListener('click', () => startAudio().catch(() => {}));
  window.addEventListener('error', (e) => { if (e && e.message) console.warn(e.message); });
  // tasto Indietro di Android: chiude i pannelli, non esce mai dall'app per sbaglio
  window.solcoBack = () => {
    if (modalDone) { modalDone(null); return true; }
    const open = !$('#browser').classList.contains('hidden') || !$('#settings').classList.contains('hidden');
    closeAll();
    if (!open) toast('Per uscire usa il tasto Home');
    return true;
  };
  window.solco = { D, S, engine, midi, loadTrack, importFiles, tracks: () => tracks, onControl };
  init();
})();
