// SOLCO Puck — firmware per M5StickS3 (M5Stack K150)
//
// Il puck sta sopra il disco, incollato al disco (non al perno): il giroscopio misura
// quanto gira il disco e manda i giri al tablet via Bluetooth MIDI. SOLCO fa andare il
// brano alla stessa velocità del disco: pitch del giradischi = tempo, disco fermo = brano
// fermo, scratch = scratch.
//
// Protocollo (canale MIDI 13). Ogni 10 ms (50 ms a disco fermo) UN pacchetto con 4 messaggi:
//   80 tt tt   orario del puck in decimi di millisecondo (14 bit, riparte ogni 1,6384 s)
//   90 aa aa   angolo del disco, bit 0-13 (angolo in 1/524288 di giro, 21 bit, riparte ogni 4 giri)
//   A0 aa rr   angolo bit 14-20, giri al minuto bit 0-6
//   E0 rr rr   giri al minuto bit 7-20 (giri al minuto × 4000 con segno, spostati di 2^20)
// Con orario e angolo SOLCO fa seguire al brano la POSIZIONE del disco.
// Ogni secondo:
//   CC 105              batteria in %
//   CC 106              stato: bit0 calibrato, bit1 calibrazione in corso, bit2 in carica
//
// Tasti:  A tenuto 2 s  calibrazione: giradischi a 33 (o 45) giri, pitch a 0, piatto in moto
//         B             azzera il giroscopio (piatto fermo). Lo fa anche da solo quando il
//                       piatto è fermo.
//
// Librerie: M5Unified 0.3.0, M5GFX 0.3.0, NimBLE-Arduino 2.5.2 (core esp32 3.3.x).

#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <esp_timer.h>
#include <math.h>

#define FW_VERSION "1.1"

static const char* MIDI_SVC = "03B80E5A-EDE8-4B33-A751-6CE34EC4C700";
static const char* MIDI_CHR = "7772E5DB-3868-4112-A1A9-F2669D106BF3";
static const uint8_t ST_CC = 0xB0 | 12;   // control change sul canale 13
static const int32_t ZERO = 1L << 20;
static const float SCALE = 4000.0f;

// ---------------- Bluetooth MIDI ----------------
static NimBLECharacteristic* chr = nullptr;
static volatile bool connected = false;
static char devName[24];

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    connected = true;
    // intervallo di collegamento 7,5–15 ms: meno ritardo tra disco e brano
    s->updateConnParams(info.getConnHandle(), 6, 12, 0, 300);
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    connected = false;
    NimBLEDevice::startAdvertising();
  }
};

static void bleStart() {
  NimBLEDevice::init(devName);
  NimBLEDevice::setPower(9);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  NimBLEService* svc = server->createService(MIDI_SVC);
  chr = svc->createCharacteristic(MIDI_CHR, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY);
  svc->start();
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

// ---------------- misura ----------------
static Preferences prefs;
static float bias = 0;          // °/s letti a piatto fermo
static bool biasOk = false;
static float scale = -1.0f;     // giri misurati → giri veri (segno compreso)
static bool calibrated = false;
static float calTarget = 0;

static double accSum = 0; static uint32_t accN = 0; static float lastDps = 0;
// angolo del disco: somma dei giri letti dal giroscopio, campione per campione (800 al secondo)
static double revs = 0; static int64_t lastSampleUs = 0, angleUs = 0;   // microsecondi da accensione (non ripartono)
static double winSum = 0, winSq = 0; static uint32_t winN = 0, winStart = 0;
static bool forceZero = false;
static uint32_t lastBiasSave = 0;

enum Mode { RUN, CAL_WAIT, CAL_MEASURE };
static Mode mode = RUN;
static uint32_t calT0 = 0; static double calSum = 0, calSq = 0; static uint32_t calN = 0;

static volatile float rpmShow = 0;
static float rpmOut = 0;
static volatile int battery = -1;
static volatile bool charging = false;
static char msg[48] = ""; static volatile uint32_t msgUntil = 0;
static volatile uint32_t lastKey = 0;
static uint32_t lastMove = 0;

static void say(const char* s, uint32_t ms) { strncpy(msg, s, sizeof(msg) - 1); msg[sizeof(msg) - 1] = 0; msgUntil = millis() + ms; }

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
    if (dt > 0.02f) dt = 0.02f;                       // dopo una pausa non si inventa movimento
    float rps = (gz - bias) / 360.0f * scale;         // giri al secondo del disco (segno compreso)
    if (fabsf(rps) * 60.0f >= 0.05f) revs += (double)rps * dt;   // sotto 0,05 giri al minuto: fermo
  }
  lastSampleUs = us; angleUs = us;
  accSum += gz; accN++;
  winSum += gz; winSq += (double)gz * gz; winN++;
  if (mode == CAL_MEASURE) {
    double r = (gz - bias) / 6.0;   // °/s → giri al minuto
    calSum += r; calSq += r * r; calN++;
  }
}

// ogni secondo: se il piatto è fermo, quello che legge il giroscopio è il suo errore di zero
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
      calibrated = true; calTarget = target;
      prefs.putFloat("scale", scale); prefs.putFloat("target", target);
      say(target > 40 ? "Calibrato a 45 giri" : "Calibrato a 33 giri", 4000);
    } else {
      say("Non riuscita: 33 giri, pitch 0", 5000);
    }
  }
}

// ---------------- schermo (su un'altra unità del processore: non rallenta la misura) ----------------
static void drawTask(void*) {
  M5Canvas cv(&M5.Display);
  cv.setColorDepth(8);
  cv.createSprite(M5.Display.width(), M5.Display.height());
  int bright = -1;
  for (;;) {
    uint32_t now = millis();
    int want = (now - lastKey < 30000 || !connected) ? 90 : 15;
    if (want != bright) { M5.Display.setBrightness(want); bright = want; }
    const int W = cv.width();
    cv.fillSprite(TFT_BLACK);
    cv.setTextDatum(top_left);
    cv.setTextColor(0xFDA0);           // ambra SOLCO
    cv.setTextSize(1);
    cv.drawString(devName, 6, 4);
    char b[32];
    int bat = battery;
    if (bat >= 0) { snprintf(b, sizeof b, "%s%d%%", charging ? "+" : "", bat); cv.setTextDatum(top_right); cv.setTextColor(bat <= 15 ? TFT_RED : TFT_WHITE); cv.drawString(b, W - 6, 4); }
    cv.setTextDatum(middle_center);
    cv.setTextColor(TFT_WHITE);
    cv.setTextSize(4);
    snprintf(b, sizeof b, "%.2f", fabsf(rpmShow));
    cv.drawString(b, W / 2, 46);
    cv.setTextSize(1);
    cv.drawString(mode != RUN ? "calibrazione: non toccare" : "giri al minuto", W / 2, 72);
    cv.setTextColor(connected ? TFT_GREEN : 0xFDA0);
    cv.drawString(connected ? "Collegato al tablet" : "In attesa del tablet...", W / 2, 92);
    cv.setTextColor(calibrated ? 0x9CF3 : TFT_YELLOW);
    const char* low = (now < msgUntil) ? msg : (calibrated ? "A tenuto: ricalibra  B: azzera" : "DA CALIBRARE: 33 giri, pitch 0, A tenuto");
    cv.drawString(low, W / 2, 116);
    cv.pushSprite(0, 0);
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

// ---------------- avvio e ciclo ----------------
static uint32_t nextSend = 0, nextStatus = 0, nextKeys = 0;

void setup() {
  auto cfg = M5.config();
  cfg.internal_spk = false;
  cfg.internal_mic = false;
  M5.begin(cfg);
  M5.Display.setRotation(1);
  M5.BtnA.setHoldThresh(2000);
  gyroFast();

  prefs.begin("puck", false);
  float sc = prefs.getFloat("scale", 0);
  calibrated = sc != 0;
  scale = calibrated ? sc : -1.0f;     // non calibrato: schermo in su, disco in senso orario
  calTarget = prefs.getFloat("target", 0);
  biasOk = prefs.isKey("bias");
  bias = prefs.getFloat("bias", 0);

  uint64_t mac = ESP.getEfuseMac();
  snprintf(devName, sizeof devName, "SOLCO Puck %02X%02X", (unsigned)((mac >> 32) & 0xFF), (unsigned)((mac >> 40) & 0xFF));
  bleStart();

  lastKey = lastMove = millis();
  winStart = millis();
  xTaskCreatePinnedToCore(drawTask, "schermo", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  if (M5.Imu.update() & m5::IMU_Class::sensor_mask_gyro) {
    float gx, gy, gz;
    if (M5.Imu.getGyro(&gx, &gy, &gz)) addSample(gz);
  }
  uint32_t now = millis();

  if ((int32_t)(now - nextKeys) >= 0) {
    nextKeys = now + 10;
    M5.update();
    if (M5.BtnA.wasHold() && mode == RUN) { mode = CAL_WAIT; calT0 = now; say("Calibro: non toccare", 9000); lastKey = now; }
    else if (M5.BtnA.wasClicked()) lastKey = now;
    if (M5.BtnB.wasClicked()) { forceZero = true; winSum = winSq = 0; winN = 0; winStart = now; say("Azzero: piatto fermo", 1500); lastKey = now; }
    if (M5.BtnPWR.wasHold()) M5.Power.powerOff();
  }

  checkStill(now);
  calibration(now);

  // 100 invii al secondo (20 a disco fermo: bastano a dire "ci sono")
  if ((int32_t)(now - nextSend) >= 0) {
    float dps = accN ? (float)(accSum / accN) : lastDps;
    lastDps = dps; accSum = 0; accN = 0;
    float rpm = (dps - bias) / 6.0f * scale;
    // filtro: deciso durante scratch e spinte, morbido a velocità costante
    float d = rpm - rpmOut;
    if (fabsf(d) > 0.6f) rpmOut = rpm; else rpmOut += 0.25f * d;
    float out = fabsf(rpmOut) < 0.05f ? 0.0f : rpmOut;
    rpmShow = out;
    if (out != 0) lastMove = now;
    sendFrame(angleUs, revs, out);
    nextSend = now + ((out == 0 && now - lastMove > 2000) ? 50 : 10);
  }

  if ((int32_t)(now - nextStatus) >= 0) {
    nextStatus = now + 1000;
    int bl = M5.Power.getBatteryLevel();
    battery = bl < 0 ? -1 : (bl > 100 ? 100 : bl);
    charging = M5.Power.isCharging();
    uint8_t flags = (calibrated ? 1 : 0) | (mode != RUN ? 2 : 0) | (charging ? 4 : 0);
    const uint8_t m[2][3] = { { ST_CC, 105, (uint8_t)(battery < 0 ? 0 : battery) }, { ST_CC, 106, flags } };
    sendMsgs(m, 2);
    // spento da solo dopo 20 minuti senza tablet e con il disco fermo
    if (!connected && now - lastMove > 20UL * 60UL * 1000UL && now - lastKey > 20UL * 60UL * 1000UL) M5.Power.powerOff();
  }
}
