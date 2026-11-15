// SOLCO per Windows (Galaxy Book e altri PC touch): la stessa app del tablet,
// in una finestra a schermo intero. I file dell'app vengono serviti dal protocollo
// interno solco:// (contesto sicuro: motore audio, archivio dei brani e MIDI funzionano
// come sul tablet).
//
// Prova automatica (usata dalla compilazione su GitHub):
//   SOLCO.exe --smoke=C:\percorso\esito.json
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const WEB = path.join(__dirname, 'web');
const smokeArg = process.argv.find((a) => a.startsWith('--smoke='));
const SMOKE = smokeArg ? smokeArg.slice('--smoke='.length) : '';

protocol.registerSchemesAsPrivileged([
  { scheme: 'solco', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
// l'audio parte senza dover toccare lo schermo, come nell'app del tablet
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    protocol.handle('solco', (req) => {
      const u = new URL(req.url);
      let rel = decodeURIComponent(u.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(WEB, rel));
      if (!file.startsWith(WEB + path.sep)) return new Response('Non trovato', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    if (!SMOKE) powerSaveBlocker.start('prevent-display-sleep');   // lo schermo non si spegne durante la serata
    ipcMain.on('solco:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    fullscreen: !SMOKE,
    backgroundColor: '#07080a',
    autoHideMenuBar: true,
    title: 'SOLCO',
    icon: path.join(WEB, 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  // niente zoom con due dita o con la rotella: la pagina resta ferma sotto le mani
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.control && ['+', '-', '=', '0'].includes(input.key)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('solco://')) e.preventDefault(); });
  win.once('ready-to-show', () => win.show());
  if (SMOKE) runSmoke(SMOKE);
  win.loadURL('solco://app/index.html');
}

/* ---------------- prova automatica ---------------- */
function runSmoke(out) {
  const result = { ok: false, page: null, errors: [] };
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { fs.writeFileSync(out, JSON.stringify(result, null, 2)); } catch (e) { /* niente */ }
    app.exit(result.ok ? 0 : 1);
  };
  win.webContents.on('console-message', (...args) => {
    const ev = args[0] || {};
    const level = typeof args[1] === 'number' ? args[1] : ev.level;
    const msg = typeof args[2] === 'string' ? args[2] : ev.message;
    if (level === 3 || level === 'error') result.errors.push(String(msg));
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => result.errors.push('caricamento fallito ' + code + ' ' + desc + ' ' + url));
  win.webContents.on('render-process-gone', (e, d) => { result.errors.push('pagina chiusa: ' + (d && d.reason)); finish(); });
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 4000));
      result.page = await win.webContents.executeJavaScript(`(async () => {
        const o = {};
        o.desktop = !!window.SolcoDesktop;
        o.app = !!window.solco;
        o.jog = !!document.getElementById('jog');
        o.comandiAschermo = document.getElementById('app').classList.contains('touch-on');
        o.audioPartito = !!(window.solco && solco.engine && solco.engine.running);
        o.messaggioAvvio = (document.getElementById('gateMsg') || {}).textContent || '';
        try { const oc = new OfflineAudioContext(2, 256, 48000); await oc.audioWorklet.addModule('js/worklet.js'); o.motoreAudio = true; }
        catch (e) { o.motoreAudio = 'errore: ' + e.message; }
        o.analisi = await new Promise((res) => {
          try { const w = new Worker('js/analysis.js'); w.onerror = (e) => res('errore: ' + (e.message || 'worker')); setTimeout(() => { w.terminate(); res(true); }, 1500); }
          catch (e) { res('errore: ' + e.message); }
        });
        o.archivio = await new Promise((res) => {
          const q = indexedDB.open('solco-prova', 1);
          q.onsuccess = () => { q.result.close(); res(true); };
          q.onerror = () => res('errore');
        });
        return o;
      })()`, true);
      const p = result.page;
      result.ok = !!(p && p.desktop && p.app && p.jog && p.motoreAudio === true && p.analisi === true && p.archivio === true);
    } catch (e) {
      result.errors.push(String(e && e.stack || e));
    }
    finish();
  });
  setTimeout(() => { result.errors.push('tempo scaduto'); finish(); }, 90000);
}
