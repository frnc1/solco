package it.solco.player;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * SOLCO: contenitore Android dell'app del lettore.
 * La pagina (cartella assets/web) gira in una WebView a schermo intero;
 * qui si aggiungono le cose che il browser non dà: i comandi MIDI via USB,
 * lo schermo sempre acceso, il selettore dei file audio e il puck del giradischi via Bluetooth MIDI.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/index.html";
    private static final int PICK_FILES = 7;
    private static final String PREFS = "solco";
    private static final int BT_PERM = 8, BT_ENABLE = 9;
    private static final UUID MIDI_SVC = UUID.fromString("03B80E5A-EDE8-4B33-A751-6CE34EC4C700");

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private MidiManager midiManager;
    private final Map<Integer, MidiDevice> openDevices = new HashMap<>();
    private final Map<Integer, String> deviceNames = new LinkedHashMap<>();
    private final List<MidiOutputPort> openPorts = new ArrayList<>();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final StringBuilder midiBuf = new StringBuilder();
    private boolean flushPosted = false;
    // dispositivi MIDI in apertura (evita di aprire due volte lo stesso)
    private final Set<Integer> opening = new HashSet<>();
    // puck Bluetooth: il riferimento va tenuto, altrimenti Android chiude il collegamento
    private final Map<String, MidiDevice> bleDevices = new HashMap<>();
    private final Set<String> bleConnecting = new HashSet<>();
    private final Map<String, String> bleFound = new LinkedHashMap<>();
    private BluetoothLeScanner scanner;
    private boolean scanning = false, scanForUser = false, pendingUserScan = false, resumed = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // orientamento scelto nelle impostazioni dell'app (di serie: verticale, con la jog grande)
        applyOrientation(getSharedPreferences(PREFS, MODE_PRIVATE).getString("orient", "portrait"));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0A0B0D);
        setContentView(web);
        hideSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null;
                return serveAsset(url.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    // nessuna app per aprire il link
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                sendDevices();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "application/octet-stream"});
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(pick, PICK_FILES);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "SolcoAndroid");
        web.loadUrl(START);
        startMidi();
    }

    /* ---------------- file della pagina serviti dagli asset ---------------- */

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..")) return notFound();
        try {
            InputStream in = getAssets().open("web" + path);
            String mime = mimeOf(path);
            boolean text = mime.startsWith("text/") || mime.equals("application/json");
            WebResourceResponse r = new WebResourceResponse(mime, text ? "utf-8" : null, in);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "*");
            r.setResponseHeaders(headers);
            return r;
        } catch (IOException e) {
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /* ---------------- selettore dei file audio ---------------- */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == BT_ENABLE) {
            if (resultCode == RESULT_OK && pendingUserScan) userScan();
            else { pendingUserScan = false; jsBle("btoff", ""); }
            return;
        }
        if (requestCode == PICK_FILES) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ---------------- orientamento bloccato ---------------- */

    private void applyOrientation(String o) {
        int v;
        if ("landscape".equals(o)) v = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        else if ("auto".equals(o)) v = ActivityInfo.SCREEN_ORIENTATION_FULL_USER;
        else v = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
        if (getRequestedOrientation() != v) setRequestedOrientation(v);
    }

    /* ---------------- schermo intero e tasto Indietro ---------------- */

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            View decor = getWindow().getDecorView();
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // l'app non si chiude mai per sbaglio: Indietro chiude solo i pannelli aperti
        web.evaluateJavascript("window.solcoBack && solcoBack()", null);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code != BT_PERM) return;
        if (hasBtPerms()) { if (pendingUserScan) userScan(); }
        else { pendingUserScan = false; jsBle("noperm", ""); }
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        ui.removeCallbacks(autoBle);
        ui.postDelayed(autoBle, 1500);
    }

    @Override
    protected void onPause() {
        resumed = false;
        ui.removeCallbacks(autoBle);
        if (scanning && !scanForUser) stopScan();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopScan();
        for (MidiDevice d : bleDevices.values()) {
            try { d.close(); } catch (IOException ignored) { }
        }
        for (MidiOutputPort p : openPorts) {
            try { p.close(); } catch (IOException ignored) { }
        }
        for (MidiDevice d : openDevices.values()) {
            try { d.close(); } catch (IOException ignored) { }
        }
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /* ---------------- comandi MIDI via USB (jog, tasti, fader) ---------------- */

    @SuppressWarnings("deprecation")
    private void startMidi() {
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI)) return;
        midiManager = (MidiManager) getSystemService(MIDI_SERVICE);
        if (midiManager == null) return;
        for (MidiDeviceInfo info : midiManager.getDevices()) openDevice(info);
        midiManager.registerDeviceCallback(new MidiManager.DeviceCallback() {
            @Override
            public void onDeviceAdded(MidiDeviceInfo info) { openDevice(info); }

            @Override
            public void onDeviceRemoved(MidiDeviceInfo info) { closeDevice(info.getId()); }
        }, ui);
    }

    private void openDevice(final MidiDeviceInfo info) {
        final int id = info.getId();
        if (info.getOutputPortCount() == 0 || openDevices.containsKey(id) || opening.contains(id)) return;
        opening.add(id);
        midiManager.openDevice(info, new MidiManager.OnDeviceOpenedListener() {
            @Override
            public void onDeviceOpened(MidiDevice device) {
                opening.remove(id);
                if (device == null) return;
                if (openDevices.containsKey(id)) {          // già aperto da un'altra strada
                    try { device.close(); } catch (IOException ignored) { }
                    return;
                }
                attach(info, device);
            }
        }, ui);
    }

    /* collega le uscite del dispositivo al ricevitore che passa i messaggi alla pagina */
    private void attach(MidiDeviceInfo info, MidiDevice device) {
        openDevices.put(info.getId(), device);
        Bundle p = info.getProperties();
        String name = p.getString(MidiDeviceInfo.PROPERTY_NAME);
        if (name == null) name = p.getString(MidiDeviceInfo.PROPERTY_PRODUCT);
        synchronized (deviceNames) {
            deviceNames.put(info.getId(), name == null ? "Controller MIDI" : name);
        }
        for (int i = 0; i < info.getOutputPortCount(); i++) {
            MidiOutputPort port = device.openOutputPort(i);
            if (port != null) {
                port.connect(new Receiver());
                openPorts.add(port);
            }
        }
        sendDevices();
    }

    private void closeDevice(int id) {
        MidiDevice d = openDevices.remove(id);
        if (d != null) {
            try { d.close(); } catch (IOException ignored) { }
        }
        for (String addr : new ArrayList<>(bleDevices.keySet())) {
            MidiDevice b = bleDevices.get(addr);
            if (b != null && b.getInfo().getId() == id) {
                bleDevices.remove(addr);
                if (b != d) { try { b.close(); } catch (IOException ignored) { } }
            }
        }
        synchronized (deviceNames) {
            deviceNames.remove(id);
        }
        sendDevices();
    }

    private void sendDevices() {
        final String js = "window.solcoMidiDevices && solcoMidiDevices(" + new Bridge().midiDevices() + ")";
        ui.post(new Runnable() {
            @Override
            public void run() { if (web != null) web.evaluateJavascript(js, null); }
        });
    }

    /* ---------------- puck del giradischi via Bluetooth MIDI ---------------- */

    private String[] btPerms() {
        if (Build.VERSION.SDK_INT >= 31) return new String[] { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT };
        return new String[] { Manifest.permission.ACCESS_FINE_LOCATION };
    }

    private boolean hasBtPerms() {
        for (String p : btPerms()) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    private String savedPuck() { return getSharedPreferences(PREFS, MODE_PRIVATE).getString("puckAddr", null); }

    /* ricerca chiesta dall'utente (Impostazioni → Comandi → CERCA PUCK) */
    private void userScan() {
        if (midiManager == null) { jsBle("nomidi", ""); return; }
        if (!hasBtPerms()) { pendingUserScan = true; requestPermissions(btPerms(), BT_PERM); return; }
        BluetoothAdapter ad = adapter();
        if (ad == null) { jsBle("nobt", ""); return; }
        if (!ad.isEnabled()) {
            pendingUserScan = true;
            try { startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), BT_ENABLE); }
            catch (Exception e) { pendingUserScan = false; jsBle("btoff", ""); }
            return;
        }
        pendingUserScan = false;
        stopScan();
        bleFound.clear();
        startScan(true);
    }

    private void startScan(boolean forUser) {
        BluetoothAdapter ad = adapter();
        if (ad == null || !ad.isEnabled() || !hasBtPerms()) return;
        scanner = ad.getBluetoothLeScanner();
        if (scanner == null) return;
        ScanFilter f = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(MIDI_SVC)).build();
        ScanSettings st = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try {
            scanner.startScan(Collections.singletonList(f), st, scanCb);
            scanning = true; scanForUser = forUser;
            ui.removeCallbacks(scanTimeout);
            ui.postDelayed(scanTimeout, forUser ? 20000 : 10000);
        } catch (SecurityException e) { scanning = false; if (forUser) jsBle("noperm", ""); }
    }

    private void stopScan() {
        ui.removeCallbacks(scanTimeout);
        if (scanning && scanner != null) {
            try { scanner.stopScan(scanCb); } catch (Exception ignored) { }
        }
        scanning = false; scanForUser = false;
    }

    private final Runnable scanTimeout = new Runnable() {
        @Override
        public void run() { stopScan(); }
    };

    private final ScanCallback scanCb = new ScanCallback() {
        @Override
        public void onScanResult(int type, final ScanResult r) { ui.post(() -> onFound(r)); }

        @Override
        public void onBatchScanResults(List<ScanResult> list) { for (final ScanResult r : list) ui.post(() -> onFound(r)); }

        @Override
        public void onScanFailed(int code) { ui.post(() -> { boolean u = scanForUser; scanning = false; scanForUser = false; if (u) jsBle("fail", ""); }); }
    };

    private void onFound(ScanResult r) {
        if (!scanning) return;
        String addr = r.getDevice().getAddress();
        String name = r.getScanRecord() != null ? r.getScanRecord().getDeviceName() : null;
        if (name == null || name.isEmpty()) name = "MIDI Bluetooth " + addr.substring(Math.max(0, addr.length() - 5));
        if (scanForUser) {
            if (!name.equals(bleFound.put(addr, name))) sendFound();
        } else if (addr.equalsIgnoreCase(savedPuck())) {
            stopScan();
            bleConnect(addr, name);
        }
    }

    /* ogni 15 s: se il puck scelto non è collegato (spento, fuori portata) lo si cerca e ricollega */
    private final Runnable autoBle = new Runnable() {
        @Override
        public void run() {
            if (!resumed) return;
            String addr = savedPuck();
            if (addr != null && midiManager != null && !bleDevices.containsKey(addr) && !bleConnecting.contains(addr)
                    && !scanning && hasBtPerms()) {
                BluetoothAdapter ad = adapter();
                if (ad != null && ad.isEnabled()) startScan(false);
            }
            ui.postDelayed(this, 15000);
        }
    };

    private void bleConnect(final String addr, final String name) {
        if (midiManager == null || bleDevices.containsKey(addr) || bleConnecting.contains(addr)) return;
        BluetoothAdapter ad = adapter();
        if (ad == null) return;
        final BluetoothDevice dev;
        try { dev = ad.getRemoteDevice(addr); } catch (IllegalArgumentException e) { return; }
        bleConnecting.add(addr);
        jsBle("connecting", name);
        try {
            midiManager.openBluetoothDevice(dev, new MidiManager.OnDeviceOpenedListener() {
                @Override
                public void onDeviceOpened(MidiDevice device) {
                    bleConnecting.remove(addr);
                    if (device == null) { jsBle("fail", name); return; }
                    bleDevices.put(addr, device);
                    MidiDeviceInfo info = device.getInfo();
                    if (!openDevices.containsKey(info.getId()) && !opening.contains(info.getId())) attach(info, device);
                    jsBle("connected", name);
                }
            }, ui);
        } catch (SecurityException e) {
            bleConnecting.remove(addr);
            jsBle("noperm", name);
        }
    }

    /* scelto un puck nuovo: gli altri si scollegano (un deck, un puck) */
    private void bleChoose(String addr, String name) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("puckAddr", addr).apply();
        stopScan();
        for (String a : new ArrayList<>(bleDevices.keySet())) {
            if (a.equalsIgnoreCase(addr)) continue;
            MidiDevice d = bleDevices.remove(a);
            if (d == null) continue;
            int id = d.getInfo().getId();
            MidiDevice o = openDevices.get(id);
            closeDevice(id);
            if (o != d) { try { d.close(); } catch (IOException ignored) { } }
        }
        bleConnect(addr, name);
    }

    private void sendFound() {
        StringBuilder sb = new StringBuilder("[");
        for (Map.Entry<String, String> e : bleFound.entrySet()) {
            if (sb.length() > 1) sb.append(',');
            sb.append("{\"addr\":").append(JSONObject.quote(e.getKey())).append(",\"name\":").append(JSONObject.quote(e.getValue())).append('}');
        }
        final String js = "window.solcoBleFound && solcoBleFound(" + sb.append(']') + ")";
        if (web != null) web.evaluateJavascript(js, null);
    }

    private void jsBle(String state, String name) {
        final String js = "window.solcoBleState && solcoBleState(" + JSONObject.quote(state) + "," + JSONObject.quote(name == null ? "" : name) + ")";
        ui.post(new Runnable() {
            @Override
            public void run() { if (web != null) web.evaluateJavascript(js, null); }
        });
    }

    /* i messaggi arrivano su un thread MIDI: si raccolgono e si passano alla pagina a gruppi */
    private final Runnable flushMidi = new Runnable() {
        @Override
        public void run() {
            String js;
            synchronized (midiBuf) {
                flushPosted = false;
                if (midiBuf.length() == 0) return;
                js = "window.solcoMidiBatch && solcoMidiBatch([" + midiBuf + "])";
                midiBuf.setLength(0);
            }
            if (web != null) web.evaluateJavascript(js, null);
        }
    };

    private class Receiver extends MidiReceiver {
        private final int[] msg = new int[3];
        private int running = 0, have = 0, need = 0;
        private boolean sysex = false;

        @Override
        public void onSend(byte[] data, int offset, int count, long timestamp) {
            for (int i = offset; i < offset + count; i++) {
                int b = data[i] & 0xFF;
                if (b >= 0xF8) continue;                 // clock e messaggi in tempo reale
                if (b == 0xF0) { sysex = true; continue; }
                if (b == 0xF7) { sysex = false; continue; }
                if (sysex) continue;
                if (b >= 0x80) {
                    running = b < 0xF0 ? b : 0;
                    have = 0;
                    msg[have++] = b;
                    need = lengthOf(b);
                    if (need <= 1) { emit(1); have = 0; }
                    continue;
                }
                if (have == 0) {
                    if (running == 0) continue;
                    msg[have++] = running;
                    need = lengthOf(running);
                }
                msg[have++] = b;
                if (have >= need) { emit(need); have = 0; }
            }
        }

        private int lengthOf(int status) {
            int t = status & 0xF0;
            if (t == 0xC0 || t == 0xD0) return 2;
            if (status >= 0xF0) {
                if (status == 0xF2) return 3;
                if (status == 0xF1 || status == 0xF3) return 2;
                return 1;
            }
            return 3;
        }

        private void emit(int n) {
            synchronized (midiBuf) {
                midiBuf.append('[');
                for (int k = 0; k < n; k++) {
                    if (k > 0) midiBuf.append(',');
                    midiBuf.append(msg[k]);
                }
                midiBuf.append("],");
                if (!flushPosted) {
                    flushPosted = true;
                    ui.post(flushMidi);
                }
            }
        }
    }

    /* ---------------- ponte JavaScript ---------------- */

    private class Bridge {
        @JavascriptInterface
        public String version() {
            return "android";
        }

        @JavascriptInterface
        public void setOrientation(final String o) {
            ui.post(() -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("orient", o).apply();
                applyOrientation(o);
            });
        }

        @JavascriptInterface
        public void bleScan() { ui.post(() -> userScan()); }

        @JavascriptInterface
        public void bleStopScan() { ui.post(() -> { if (scanForUser) stopScan(); }); }

        @JavascriptInterface
        public void bleConnect(final String addr, final String name) {
            if (addr == null || !BluetoothAdapter.checkBluetoothAddress(addr)) return;
            ui.post(() -> bleChoose(addr, name));
        }

        @JavascriptInterface
        public String midiDevices() {
            StringBuilder sb = new StringBuilder("[");
            synchronized (deviceNames) {
                for (String n : deviceNames.values()) {
                    if (sb.length() > 1) sb.append(',');
                    sb.append(JSONObject.quote(n));
                }
            }
            return sb.append(']').toString();
        }
    }
}
