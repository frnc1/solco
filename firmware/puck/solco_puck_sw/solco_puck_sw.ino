// SOLCO Puck con schermo — firmware per M5Stack StopWatch (C152)
//
// Come il puck M5StickS3: sta sopra il disco, il giroscopio misura quanto gira e lo manda a
// SOLCO via Bluetooth MIDI (stesso protocollo 1.1 sul canale 13: orario, angolo, giri al minuto),
// quindi il brano segue il disco. In più lo schermo tondo mostra BPM, pitch, tempo rimanente,
// tonalità Camelot e la forma d'onda attorno al bordo, e a disco fermo si sfogliano e caricano
// i brani di SOLCO: si scorre girando il disco o col dito, si carica toccando il brano.
// Le scritte restano dritte mentre il disco gira: la schermata viene girata al contrario
// (contro-rotazione) con l'angolo misurato dal giroscopio.
//
// Tasti:  A (giallo)   clic: apre/chiude la lista dei brani
//                      tenuto 2 s: calibrazione (giradischi a 33 o 45 giri, pitch a 0, piatto in moto)
//         B (blu)      clic: chiude la lista; nel deck azzera il giroscopio (piatto fermo)
//                      tenuto: raddrizza le scritte (girando il disco le scritte girano con lui;
//                      si lascia il tasto quando sono dritte)
//         A + B insieme: mostra/nasconde i fotogrammi al secondo (per le prove)
//         accensione: premuto due volte di fila spegne; tenuto 2 s col cavo USB collegato = modalità
//                     per caricare il programma (luce verde)
//
// Messaggi SysEx con SOLCO: vedi proto.h e firmware/puck/README.md.
// Librerie: M5Unified 0.3.0, M5GFX 0.3.0, NimBLE-Arduino 2.5.2 (core esp32 3.3.12).
// Scheda: ESP32S3 Dev Module, USB CDC all'avvio, flash 16 MB, partizioni «16M Flash (3MB APP/9.9MB FATFS)», PSRAM OPI.

#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <esp_timer.h>
#include <math.h>
#include "proto.h"
#include "ui.h"

#define FW_VERSION "2.0"

static const char* MIDI_SVC = "03B80E5A-EDE8-4B33-A751-6CE34EC4C700";
static const char* MIDI_CHR = "7772E5DB-3868-4112-A1A9-F2669D106BF3";
static const uint8_t ST_CC = 0xB0 | 12;   // control change sul canale 13
static const int32_t ZERO = 1L << 20;
static const float SCALE = 4000.0f;

// ---------------- code tra le due unità del processore ----------------
// unità 1 (loop): giroscopio, Bluetooth, tasti, tocco, batteria, vibrazione
// unità 0 (uiTask): schermo e logica delle schermate
struct RxMsg { uint16_t n; uint8_t d[1536]; };   // il più lungo: 40 generi, circa 1100 byte
struct TxMsg { uint8_t n; uint8_t d[96]; };
enum EvType : uint8_t { EV_TAP, EV_DRAG, EV_DRAG_END, EV_BTN_A, EV_BTN_B, EV_DEBUG };
struct Ev { uint8_t type; int16_t x, y, dx, dy; };
static QueueHandle_t rxQ, txQ, evQ;

// ---------------- Bluetooth MIDI ----------------
static NimBLECharacteristic* chr = nullptr;
static volatile bool connected = false;
static volatile uint16_t mtu = 23;
static char devName[24];

static void onSysexIn(const uint8_t* d, size_t n, void*) {
  static RxMsg m;                          // solo dal compito Bluetooth
  if (n > sizeof m.d) return;
  m.n = (uint16_t)n; memcpy(m.d, d, n);
  xQueueSend(rxQ, &m, 0);
}
static pk::BleMidiIn<1536> bleIn(onSysexIn, nullptr);

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    connected = true; mtu = 23; bleIn.reset();
    // intervallo di collegamento 7,5–15 ms: meno ritardo tra disco e brano
    s->updateConnParams(info.getConnHandle(), 6, 12, 0, 300);
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    connected = false;
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t m, NimBLEConnInfo& info) override { mtu = m; }
};
class ChrCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    NimBLEAttValue v = c->getValue();
    bleIn.feed(v.data(), v.size());
  }
};

static void bleStart() {
  NimBLEDevice::init(devName);
  NimBLEDevice::setPower(9);
  NimBLEDevice::setMTU(247);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  NimBLEService* svc = server->createService(MIDI_SVC);
  chr = svc->createCharacteristic(MIDI_CHR, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY);
  chr->setCallbacks(new ChrCB());   // il servizio parte con la pubblicità
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  NimBLEAdvertisementData ad, sr;
  ad.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  ad.addServiceUUID(NimBLEUUID(MIDI_SVC));   // il tablet cerca i dispositivi MIDI con questo
  sr.setName(devName);
  adv->setAdvertisementData(ad);
  adv->setScanResponseData(sr);
  adv->start();
}

// pacchetto BLE MIDI: intestazione + (orario + messaggio) per ogni messaggio
static void sendMsgs(const uint8_t m[][3], int n) {
  if (!connected || !chr) return;
  uint8_t buf[20];
  uint16_t ms = millis() & 0x1FFF;
  uint8_t ts = 0x80 | (ms & 0x7F);
  int k = 0;
  buf[k++] = 0x80 | ((ms >> 7) & 0x3F);
  for (int i = 0; i < n && k + 4 <= (int)sizeof(buf); i++) {
    buf[k++] = ts; buf[k++] = m[i][0]; buf[k++] = m[i][1]; buf[k++] = m[i][2];
  }
  chr->notify(buf, k);
}
// SysEx verso SOLCO, diviso in pacchetti adatti al collegamento
static void sendSysex(const uint8_t* d, size_t n) {
  if (!connected || !chr) return;
  size_t room = mtu > 3 ? mtu - 3 : 20;
  if (room < 20) room = 20;
  pk::bleSysexPackets(d, n, room, millis() & 0x1FFF, [](const uint8_t* p, size_t k) { chr->notify(p, k); });
}

// orario e angolo dell'ultima lettura del giroscopio + giri al minuto, in un solo pacchetto (17 byte)
static void sendFrame(int64_t us, double turns, float rpm) {
  uint16_t t = (uint16_t)((us / 100) & 0x3FFF);
  uint32_t a = (uint32_t)((int64_t)floor(turns * 524288.0) & 0x1FFFFF);
  int32_t v = lroundf(rpm * SCALE);
  if (v > ZERO - 1) v = ZERO - 1;
  if (v < -(ZERO - 1)) v = -(ZERO - 1);
  uint32_t u = (uint32_t)(v + ZERO);
  const uint8_t c = 12;   // canale 13
  const uint8_t m[4][3] = {
    { (uint8_t)(0x80 | c), (uint8_t)(t >> 7), (uint8_t)(t & 0x7F) },
    { (uint8_t)(0x90 | c), (uint8_t)((a >> 7) & 0x7F), (uint8_t)(a & 0x7F) },
    { (uint8_t)(0xA0 | c), (uint8_t)((a >> 14) & 0x7F), (uint8_t)(u & 0x7F) },
    { (uint8_t)(0xE0 | c), (uint8_t)((u >> 7) & 0x7F), (uint8_t)((u >> 14) & 0x7F) },
  };
  sendMsgs(m, 4);
}

// ---------------- misura (come il puck M5StickS3) ----------------
static Preferences prefs;
static float bias = 0;          // °/s letti a piatto fermo
static bool biasOk = false;
static float scale = -1.0f;     // giri misurati → giri veri (segno compreso)
static volatile bool calibrated = false;

static double accSum = 0; static uint32_t accN = 0; static float lastDps = 0;
static double revs = 0; static int64_t lastSampleUs = 0, angleUs = 0;
static double winSum = 0, winSq = 0; static uint32_t winN = 0, winStart = 0;
static bool forceZero = false;
static uint32_t lastBiasSave = 0;

enum Mode { RUN, CAL_WAIT, CAL_MEASURE };
static volatile Mode mode = RUN;
static uint32_t calT0 = 0; static double calSum = 0, calSq = 0; static uint32_t calN = 0;

static float rpmOut = 0;
static volatile int battery = -1;
static volatile bool charging = false;
static uint32_t lastMove = 0, lastKey = 0;

// messaggi per lo schermo (dall'unità 1)
static char sayBuf[48]; static volatile uint32_t saySeq = 0, sayMs = 0;
static portMUX_TYPE sayMux = portMUX_INITIALIZER_UNLOCKED;
static void say(const char* s, uint32_t ms) {
  portENTER_CRITICAL(&sayMux);
  strncpy(sayBuf, s, sizeof sayBuf - 1); sayBuf[sizeof sayBuf - 1] = 0; sayMs = ms; saySeq = saySeq + 1;
  portEXIT_CRITICAL(&sayMux);
}

// giri del disco e velocità per lo schermo (letti dall'unità 0: lettura con numero di sequenza)
static volatile uint32_t motSeq = 0;
static volatile double motTurns = 0;
static volatile float motRps = 0;
static volatile int64_t motUs = 0;
static void publishMotion(double turns, float rps, int64_t us) {
  motSeq = motSeq + 1; motTurns = turns; motRps = rps; motUs = us; motSeq = motSeq + 1;
}
static void readMotion(double& turns, float& rps, int64_t& us) {
  for (;;) {
    uint32_t s = motSeq;
    if (s & 1) continue;
    turns = motTurns; rps = motRps; us = motUs;
    if (s == motSeq) return;
  }
}

// richieste dello schermo all'unità 1
static volatile int vibLevel = 0, vibMs = 0; static volatile uint32_t vibSeq = 0;
static volatile bool reqZero = false;
static volatile bool alignOn = false;

// BMI270: giroscopio a 800 letture al secondo (di serie 200), fondo scala ±2000 °/s
static void gyroFast() {
  const uint8_t addrs[] = { 0x68, 0x69 };
  for (uint8_t a : addrs) {
    if (M5.In_I2C.readRegister8(a, 0x00, 400000) == 0x24) {
      M5.In_I2C.writeRegister8(a, 0x42, 0xAB, 400000);   // GYR_CONF: 800 Hz, filtro normale, prestazioni
      M5.In_I2C.writeRegister8(a, 0x43, 0x00, 400000);   // GYR_RANGE: ±2000 °/s
    }
  }
}

static void addSample(float gz) {
  int64_t us = esp_timer_get_time();
  if (lastSampleUs != 0) {
    float dt = (us - lastSampleUs) * 1e-6f;
    if (dt > 0.02f) dt = 0.02f;
    float rps = (gz - bias) / 360.0f * scale;
    if (fabsf(rps) * 60.0f >= 0.05f) revs += (double)rps * dt;
  }
  lastSampleUs = us; angleUs = us;
  publishMotion(revs, rpmOut / 60.0f, us);
  accSum += gz; accN++;
  winSum += gz; winSq += (double)gz * gz; winN++;
  if (mode == CAL_MEASURE) {
    double r = (gz - bias) / 6.0;
    calSum += r; calSq += r * r; calN++;
  }
}

static void checkStill(uint32_t now) {
  if (now - winStart < 1000) return;
  if (winN > 100) {
    double mean = winSum / winN;
    double sd = sqrt(fmax(0.0, winSq / winN - mean * mean));
    bool still = sd < (forceZero ? 0.6 : 0.35);
    double lim = forceZero ? 20.0 : (biasOk ? 1.5 : 8.0);
    if (still && fabs(mean - (biasOk ? bias : 0)) < lim) {
      bias = (biasOk && !forceZero) ? bias + 0.3f * (float)(mean - bias) : (float)mean;
      if (forceZero) say("Azzerato", 2000);
      if (!biasOk || forceZero || now - lastBiasSave > 60000) { prefs.putFloat("bias", bias); lastBiasSave = now; }
      biasOk = true; forceZero = false;
    } else if (forceZero) {
      say("Ferma il piatto e riprova", 3000);
      forceZero = false;
    }
  }
  winSum = winSq = 0; winN = 0; winStart = now;
}

static void calibration(uint32_t now) {
  if (mode == CAL_WAIT && now - calT0 > 1500) {
    mode = CAL_MEASURE; calSum = calSq = 0; calN = 0; calT0 = now;
  } else if (mode == CAL_MEASURE && now - calT0 > 6000) {
    mode = RUN;
    double m = calN ? calSum / calN : 0;
    double sd = calN ? sqrt(fmax(0.0, calSq / calN - m * m)) : 1e9;
    double am = fabs(m);
    float target = (am > 28 && am < 39) ? 100.0f / 3.0f : (am > 39 && am < 52) ? 45.0f : 0;
    if (target > 0 && sd < am * 0.02) {
      scale = (float)(target / m);
      calibrated = true;
      prefs.putFloat("scale", scale); prefs.putFloat("target", target);
      say(target > 40 ? "Calibrato a 45 giri" : "Calibrato a 33 giri", 4000);
    } else {
      say("Non riuscita: 33 giri, pitch 0", 5000);
    }
  }
}

// ---------------- schermo (unità 0) ----------------
static pui::Puck puck;
static void uiSend(const uint8_t* d, size_t n, void*) {
  if (n > sizeof(TxMsg::d)) return;
  TxMsg m; m.n = (uint8_t)n; memcpy(m.d, d, n);
  xQueueSend(txQ, &m, 0);
}
static void uiVibrate(int ms, int level, void*) { vibMs = ms; vibLevel = level; vibSeq = vibSeq + 1; }

static void uiTask(void*) {
  Preferences up;
  up.begin("puckui", false);
  double off = up.getFloat("dev", 0);             // orientamento delle scritte rispetto al puck (giri)
  float savedDev = (float)off;

  const int W = M5.Display.width(), H = M5.Display.height();
  const float cx = W / 2.0f, cy = H / 2.0f;
  M5Canvas world(&M5.Display);
  world.setPsram(true);
  world.setColorDepth(16);
  if (!world.createSprite(W, H)) { M5.Display.fillScreen(TFT_RED); for (;;) vTaskDelay(1000); }
  M5.Display.setAutoDisplay(false);

  puck.out.send = uiSend; puck.out.vibrate = uiVibrate;
  strncpy(puck.name, devName, sizeof puck.name - 1);
  puck.setFw(FW_VERSION);

  RxMsg rx; Ev ev;
  uint32_t lastSay = 0, lastRender = 0, still0 = 0, fpsT = 0, fpsN = 0, fps = 0;
  float lastAngle = 1e9f, angle = 0;
  bool wasAlign = false, alignAsked = false, debug = false, fresh = true;
  double alignPred0 = 0, alignOff0 = 0;
  int bright = -1;
  int dragLastX = 0, dragLastY = 0; bool dragging = false;

  for (;;) {
    const uint32_t now = millis();
    double turns; float rps; int64_t mus;
    readMotion(turns, rps, mus);
    const bool cal = calibrated;

    // angolo della schermata (gradi, senso orario sullo schermo): il contrario dei giri del disco.
    // Si prevede dove sarà il disco quando l'immagine arriva sullo schermo (circa 18 ms dopo).
    // Senza calibrazione non si sa il verso del disco: la schermata resta ferma.
    double pred = 0;
    if (cal) pred = turns + (double)rps * ((esp_timer_get_time() - mus) * 1e-6 + 0.018);
    // B tenuto: le scritte girano col disco (restano ferme sullo schermo) finché non si lascia il tasto
    const bool align = alignOn && cal;
    if (alignOn && !cal && !alignAsked) puck.message("Prima calibra: tieni A", 2500, now);
    alignAsked = alignOn;
    if (align && !wasAlign) { alignPred0 = pred; alignOff0 = off; }
    if (align) off = alignOff0 + (pred - alignPred0);
    if (!align && wasAlign) puck.message("Scritte raddrizzate", 1200, now);
    wasAlign = align;
    angle = (float)fmod((off - pred) * 360.0, 360.0);
    if (angle < 0) angle += 360.0f;

    // messaggi da SOLCO
    while (xQueueReceive(rxQ, &rx, 0) == pdTRUE) puck.onSysex(rx.d, rx.n, now);
    // tocchi e tasti: coordinate dello schermo → verso del DJ
    const float ar = -angle * (float)M_PI / 180.0f, ca = cosf(ar), sa = sinf(ar);
    auto toWorld = [&](int x, int y, int& wx, int& wy) {
      float dx = x - cx, dy = y - cy;
      wx = (int)lroundf(dx * ca - dy * sa); wy = (int)lroundf(dx * sa + dy * ca);
    };
    while (xQueueReceive(evQ, &ev, 0) == pdTRUE) {
      int wx, wy;
      switch (ev.type) {
        case EV_TAP: toWorld(ev.x, ev.y, wx, wy); puck.tap(wx, wy, now); break;
        case EV_DRAG: {
          toWorld(ev.x, ev.y, wx, wy);
          if (dragging) puck.drag(wy - dragLastY, now);
          dragLastX = wx; dragLastY = wy; dragging = true;
          break;
        }
        case EV_DRAG_END: dragging = false; puck.dragEnd(); break;
        case EV_BTN_A: puck.buttonA(now); break;
        case EV_BTN_B: if (!puck.buttonB(now)) reqZero = true; break;
        case EV_DEBUG: debug = !debug; break;
      }
    }
    (void)dragLastX;
    if (saySeq != lastSay) {
      char b[48]; uint32_t ms;
      portENTER_CRITICAL(&sayMux);
      memcpy(b, sayBuf, sizeof b); ms = sayMs; lastSay = saySeq;
      portEXIT_CRITICAL(&sayMux);
      puck.message(b, ms, now);
    }
    puck.onConnect(connected, now);
    puck.setStatus(battery, charging, cal, mode != RUN);
    puck.setMotion(turns, rps * 60.0f, now);
    puck.tick(now);

    // orientamento rispetto al puck salvato a disco fermo: alla prossima accensione le scritte
    // stanno come adesso rispetto al puck
    if (fabsf(rps) < 0.002f && !align) {
      if (!still0) still0 = now;
      float dev = angle / 360.0f;
      if (now - still0 > 3000 && fabsf(dev - savedDev) > 0.003f) { up.putFloat("dev", dev); savedDev = dev; }
    } else still0 = 0;

    // luminosità: piena col tablet collegato o appena toccato, bassa se nessuno lo usa
    int want = (puck.linked() || now - lastKey < 60000) ? 200 : 60;
    if (want != bright) { M5.Display.setBrightness(want); bright = want; }

    // ridisegno della schermata (al più 25 volte al secondo) e rotazione sullo schermo
    bool newContent = false;
    if (fresh || (puck.needsRedraw(now) && now - lastRender >= 40)) {
      puck.draw(world, now);
      lastRender = now; newContent = true; fresh = false;
    }
    float dA = fabsf(angle - lastAngle); if (dA > 180) dA = 360 - dA;
    if (newContent || dA > 0.25f || debug) {
      world.pushRotateZoom(&M5.Display, cx, cy, angle, 1.0f, 1.0f);
      if (debug) {
        M5.Display.setFont(&fonts::FreeSansBold12pt7b); M5.Display.setTextDatum(middle_center);
        M5.Display.setTextColor(TFT_GREEN, TFT_BLACK);
        char b[32]; snprintf(b, sizeof b, " %u fps  %.0f giri ", (unsigned)fps, fabsf(rps) * 60.0f);
        M5.Display.drawString(b, (int)cx, (int)cy + 200);
      }
      M5.Display.display();
      lastAngle = angle;
      fpsN++;
    }
    if (now - fpsT >= 1000) { fps = fpsN; fpsN = 0; fpsT = now; }
    vTaskDelay(1);
  }
}

// ---------------- avvio e ciclo (unità 1) ----------------
static uint32_t nextSend = 0, nextStatus = 0, nextKeys = 0, vibOff = 0, lastVibSeq = 0;
static bool combo = false;

void setup() {
  auto cfg = M5.config();
  cfg.internal_spk = false;
  cfg.internal_mic = false;
  M5.begin(cfg);
  M5.BtnA.setHoldThresh(2000);
  M5.BtnB.setHoldThresh(600);
  gyroFast();

  rxQ = xQueueCreate(6, sizeof(RxMsg));
  txQ = xQueueCreate(10, sizeof(TxMsg));
  evQ = xQueueCreate(16, sizeof(Ev));

  prefs.begin("puck", false);
  float sc = prefs.getFloat("scale", 0);
  calibrated = sc != 0;
  scale = calibrated ? sc : -1.0f;
  biasOk = prefs.isKey("bias");
  bias = prefs.getFloat("bias", 0);

  uint64_t mac = ESP.getEfuseMac();
  snprintf(devName, sizeof devName, "SOLCO Puck %02X%02X", (unsigned)((mac >> 32) & 0xFF), (unsigned)((mac >> 40) & 0xFF));
  bleStart();

  lastKey = lastMove = millis();
  winStart = millis();
  xTaskCreatePinnedToCore(uiTask, "schermo", 16384, nullptr, 1, nullptr, 0);
}

static void pushEv(uint8_t type, int x = 0, int y = 0) { Ev e{ type, (int16_t)x, (int16_t)y, 0, 0 }; xQueueSend(evQ, &e, 0); }

void loop() {
  if (M5.Imu.update() & m5::IMU_Class::sensor_mask_gyro) {
    float gx, gy, gz;
    if (M5.Imu.getGyro(&gx, &gy, &gz)) addSample(gz);
  }
  uint32_t now = millis();

  if ((int32_t)(now - nextKeys) >= 0) {
    nextKeys = now + 10;
    M5.update();
    const bool aP = M5.BtnA.isPressed(), bP = M5.BtnB.isPressed();
    // A + B insieme: fotogrammi al secondo (per le prove); il resto di quella pressione non conta
    if (aP && bP && !combo) { combo = true; pushEv(EV_DEBUG); }
    if (!combo) {
      if (M5.BtnA.wasHold() && mode == RUN) { mode = CAL_WAIT; calT0 = now; say("Calibro: non toccare", 9000); }
      else if (M5.BtnA.wasClicked()) pushEv(EV_BTN_A);
      if (M5.BtnB.wasHold()) alignOn = true;
      else if (M5.BtnB.wasClicked()) pushEv(EV_BTN_B);
    }
    if (!aP && !bP) combo = false;
    if (alignOn && !bP) alignOn = false;
    if (aP || bP) lastKey = now;
    // tasto di accensione premuto due volte di fila: spento (come col programma di fabbrica)
    if (M5.BtnPWR.wasClicked() && M5.Power.M5pm1.wasPekDoubleClicked()) M5.Power.powerOff();
    // tocco: colpetto = scelta; dito che scorre (veloce o lento) = movimento
    const auto& t = M5.Touch.getDetail();
    const uint8_t MOVING = m5::touch_state_t::mask_touch | m5::touch_state_t::mask_moving;
    if (t.wasClicked()) { pushEv(EV_TAP, t.x, t.y); lastKey = now; }
    else if ((t.state & MOVING) == MOVING) { pushEv(EV_DRAG, t.x, t.y); lastKey = now; }
    else if (t.wasFlicked() || t.wasDragged()) pushEv(EV_DRAG_END);
  }
  if (reqZero) { reqZero = false; forceZero = true; winSum = winSq = 0; winN = 0; winStart = now; say("Azzero: piatto fermo", 1500); }

  checkStill(now);
  calibration(now);

  // vibrazione chiesta dallo schermo
  if (vibSeq != lastVibSeq) { lastVibSeq = vibSeq; M5.Power.setVibration((uint8_t)vibLevel); vibOff = now + vibMs; }
  if (vibOff && (int32_t)(now - vibOff) >= 0) { M5.Power.setVibration(0); vibOff = 0; }

  // 100 invii al secondo (20 a disco fermo: bastano a dire "ci sono")
  if ((int32_t)(now - nextSend) >= 0) {
    float dps = accN ? (float)(accSum / accN) : lastDps;
    lastDps = dps; accSum = 0; accN = 0;
    float rpm = (dps - bias) / 6.0f * scale;
    float d = rpm - rpmOut;
    if (fabsf(d) > 0.6f) rpmOut = rpm; else rpmOut += 0.25f * d;
    float out = fabsf(rpmOut) < 0.05f ? 0.0f : rpmOut;
    if (out != 0) lastMove = now;
    sendFrame(angleUs, revs, out);
    nextSend = now + ((out == 0 && now - lastMove > 2000) ? 50 : 10);
    // messaggi dello schermo per SOLCO, tra un pacchetto e l'altro
    TxMsg m;
    for (int k = 0; k < 3 && xQueueReceive(txQ, &m, 0) == pdTRUE; k++) sendSysex(m.d, m.n);
  }

  if ((int32_t)(now - nextStatus) >= 0) {
    nextStatus = now + 1000;
    int bl = M5.Power.getBatteryLevel();
    battery = bl < 0 ? -1 : (bl > 100 ? 100 : bl);
    // il chip di alimentazione non dice se sta caricando: «in carica» = cavo USB collegato
    charging = M5.Power.isCharging() || M5.Power.getVBUSVoltage() > 4000;
    uint8_t flags = (calibrated ? 1 : 0) | (mode != RUN ? 2 : 0) | (charging ? 4 : 0);
    const uint8_t m[2][3] = { { ST_CC, 105, (uint8_t)(battery < 0 ? 0 : battery) }, { ST_CC, 106, flags } };
    sendMsgs(m, 2);
    // spento da solo dopo 20 minuti senza tablet e con il disco fermo
    if (!connected && now - lastMove > 20UL * 60UL * 1000UL && now - lastKey > 20UL * 60UL * 1000UL) M5.Power.powerOff();
  }
}
