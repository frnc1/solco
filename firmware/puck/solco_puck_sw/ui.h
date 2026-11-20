// SOLCO Puck con schermo — schermate e logica (deck, lista dei brani, conferma).
// Disegna su una tela «del mondo», cioè con l'alto verso il DJ: il programma la gira sullo
// schermo in senso opposto al disco (contro-rotazione), così le scritte restano dritte.
// Solo LovyanGFX/M5GFX e C++ standard: compila sul puck e sul computer (tests/puck_ui_sim.cpp).
// Chi lo include deve prima includere M5GFX (sul puck) o LovyanGFX (sul computer).
#pragma once
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "proto.h"

namespace pui {

typedef lgfx::LovyanGFX G;

// ---------------- colori (RGB565) ----------------
static inline uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) { return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)); }
static inline uint16_t dim(uint16_t c, int pct) {
  int r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  r = r * pct / 100; g = g * pct / 100; b = b * pct / 100;
  return (uint16_t)((r << 11) | (g << 5) | b);
}
static const uint16_t C_BLACK = 0x0000, C_WHITE = 0xFFFF;
static const uint16_t C_AMBER = rgb(255, 176, 32);     // come la puntina in SOLCO
static const uint16_t C_GRAY = rgb(150, 156, 166);
static const uint16_t C_DARK = rgb(40, 44, 52);
static const uint16_t C_PANEL = rgb(24, 27, 33);
static const uint16_t C_RED = rgb(255, 77, 94);
static const uint16_t C_GREEN = rgb(52, 215, 123);
static const uint16_t C_CYAN = rgb(36, 198, 214);
static const uint16_t C_YELLOW = rgb(255, 210, 63);
static const uint16_t BAND_COL[3] = { rgb(111, 92, 255), rgb(36, 198, 214), rgb(242, 245, 255) };   // tavolozza SOLCO
static inline uint16_t camColor(uint8_t k) {
  static const uint8_t C[13][3] = { { 139, 146, 157 }, { 86, 224, 192 }, { 116, 220, 114 }, { 168, 216, 78 }, { 220, 205, 70 }, { 242, 166, 76 },
                                    { 242, 122, 94 }, { 242, 101, 130 }, { 226, 99, 182 }, { 180, 106, 230 }, { 138, 126, 242 }, { 95, 158, 242 }, { 69, 198, 238 } };
  int n = (k >= 1 && k <= 24) ? (k + 1) / 2 : 0;
  return rgb(C[n][0], C[n][1], C[n][2]);
}

// ---------------- dati ----------------
struct Deck { bool valid = false; uint8_t flags = 0; uint32_t pos = 0, dur = 0, bpm = 0; int32_t pitch = 0; uint8_t tseq = 0, deck = 1; uint32_t rx = 0; };
struct Track { bool valid = false; uint8_t tseq = 255; uint32_t bpm = 0, dur = 0; uint8_t cam = 0; char title[52] = "", artist[44] = "", genre[28] = ""; };
struct Wave { bool valid = false; uint8_t tseq = 255, n = 0; uint8_t v[128]; };
struct Item { int32_t idx = -1; uint16_t bpm = 0, dur = 0; uint8_t cam = 0, fl = 0; char id[16] = "", title[52] = "", artist[36] = ""; };

enum View { V_DECK = 0, V_BROWSE = 1, V_CONFIRM = 2 };
static const char* const SORT_NAME[pk::S_COUNT] = { "ULTIMI AGGIUNTI", "TITOLO", "ARTISTA", "BPM", "CAMELOT", "COMPATIBILI" };

struct Out {
  void (*send)(const uint8_t* d, size_t n, void* ctx) = nullptr;
  void (*vibrate)(int ms, int level, void* ctx) = nullptr;
  void* ctx = nullptr;
};

class Puck {
 public:
  static const int CACHE = 64;
  static const int STEP_DEG = 15;            // gradi di disco per un brano quando si sfoglia
  static const int ROW_PX = 70;              // trascinamento col dito per un brano

  Out out;
  char name[24] = "SOLCO Puck";

  // ---------- ingressi dal programma ----------
  void onConnect(bool c, uint32_t now) {
    if (c == conn_) return;
    conn_ = c; helloOk_ = false; helloT_ = now - 1500; dirty_ = true;
    if (!c) { if (view_ != V_DECK) setView(V_DECK, now, false); deck_.valid = false; }
  }
  void setStatus(int bat, bool charging, bool calibrated, bool calibrating) {
    if (bat != bat_ || charging != chg_ || calibrated != cal_ || calibrating != calRun_) dirty_ = true;
    bat_ = bat; chg_ = charging; cal_ = calibrated; calRun_ = calibrating;
  }
  // giri del disco (in avanti = positivi) e giri al minuto, a ogni fotogramma
  void setMotion(double turns, float rpm, uint32_t now) {
    turns_ = turns; rpm_ = rpm;
    float a = fabsf(rpm);
    if (view_ == V_BROWSE) {
      // il giradischi è partito (velocità costante da piatto): si torna al deck
      if (a > 25 && a < 52) { if (!steadyT_) steadyT_ = now; else if (now - steadyT_ > 700) { setView(V_DECK, now, true); say("Disco partito", 1500, now); } }
      else steadyT_ = 0;
      double deg = (turns - anchor_) * 360.0;
      int steps = (int)(deg / STEP_DEG);
      if (steps) {
        anchor_ += steps * (double)STEP_DEG / 360.0;
        moveCursor(steps, now);
      }
    } else steadyT_ = 0;
  }
  void message(const char* s, uint32_t ms, uint32_t now) { say(s, ms, now); }

  // tocco breve; x, y in punti dello schermo rispetto al centro, già girati nel verso del DJ
  void tap(int x, int y, uint32_t now) {
    touchT_ = now;
    if (view_ == V_DECK) {
      // con un brano nel deck la lista si apre solo col tasto A: un dito sul puck mentre si cerca
      // il punto d'attacco non deve togliere il disco al brano
      if (deck_.valid && (deck_.flags & pk::F_LOADED)) say("Premi A per i brani", 1500, now);
      else enterBrowse(now);
      return;
    }
    if (view_ == V_CONFIRM) {
      if (y > 10) {
        if (x > 0) { sendLoad(true, now); setView(V_BROWSE, now, false); }
        else setView(V_BROWSE, now, false);
      }
      return;
    }
    // lista
    if (y < -140) { cycleSort(now); return; }
    if (y > 140) { cycleGenre(now); return; }
    if (y > -60 && y < 60) { const Item* it = item(cur_); if (it) sendLoad(false, now); return; }
    if (y <= -60) moveCursor(-1, now); else moveCursor(1, now);
  }
  // trascinamento verticale (differenza dall'ultima chiamata, nel verso del DJ)
  void drag(int dy, uint32_t now) {
    touchT_ = now;
    if (view_ != V_BROWSE) return;
    dragAcc_ += dy;
    while (dragAcc_ <= -ROW_PX) { dragAcc_ += ROW_PX; moveCursor(1, now); }
    while (dragAcc_ >= ROW_PX) { dragAcc_ -= ROW_PX; moveCursor(-1, now); }
  }
  void dragEnd() { dragAcc_ = 0; }
  // tasto A: apre o chiude la lista (dalla conferma: annulla)
  void buttonA(uint32_t now) {
    if (view_ == V_DECK) enterBrowse(now);
    else setView(view_ == V_CONFIRM ? V_BROWSE : V_DECK, now, true);
  }
  // tasto B: esce dalla lista; nel deck lo usa il programma (azzera il giroscopio). Vero se usato qui.
  bool buttonB(uint32_t now) {
    if (view_ == V_DECK) return false;
    setView(V_DECK, now, true);
    return true;
  }

  // SysEx completo (F0 … F7) arrivato da SOLCO
  void onSysex(const uint8_t* d, size_t n, uint32_t now) {
    pk::Reader r(d, n);
    if (!r.ok) return;
    switch (r.cmd) {
      case pk::HELLOK: { uint8_t dk = r.u7(); char v[16]; r.str(v, sizeof v); if (r.ok) { helloOk_ = true; deck_.deck = dk; strncpy(appVer_, v, sizeof appVer_ - 1); dirty_ = true; } break; }
      case pk::STATE: {
        Deck s; s.flags = r.u7(); s.pos = r.u21(); s.dur = r.u21(); s.bpm = r.u21(); s.pitch = r.s21(); s.tseq = r.u7(); s.deck = r.u7();
        if (!r.ok) break;
        s.valid = true; s.rx = now;
        helloOk_ = true;
        deck_ = s; dirty_ = true;
        if ((s.flags & pk::F_LOADED) && track_.tseq != s.tseq && now - treqT_ > 1000) { treqT_ = now; Wr w(pk::TREQ); send(w); }
        break;
      }
      case pk::TRACK: {
        Track t; t.tseq = r.u7(); t.bpm = r.u21(); t.cam = r.u7(); t.dur = r.u21(); r.str(t.title, sizeof t.title); r.str(t.artist, sizeof t.artist); r.str(t.genre, sizeof t.genre);
        if (!r.ok) break;
        t.valid = true; track_ = t; dirty_ = true;
        if (wave_.tseq != t.tseq) wave_.valid = false;
        break;
      }
      case pk::WAVE: {
        Wave w; w.tseq = r.u7(); w.n = r.u7(); if (w.n > 128) w.n = 128;
        for (int k = 0; k < w.n; k++) w.v[k] = r.u7();
        if (!r.ok) break;
        w.valid = w.n > 0; wave_ = w; dirty_ = true;
        break;
      }
      case pk::LHEAD: {
        uint8_t req = r.u7(); uint16_t total = r.u14(), sel = r.u14(); uint8_t sort = r.u7(), compat = r.u7(); char g[28]; r.str(g, sizeof g);
        (void)sort; (void)compat;
        if (!r.ok || req != req_) break;
        total_ = total; sel_ = sel == pk::NONE ? -1 : sel;
        if (!haveHead_) { cur_ = sel_ >= 0 ? sel_ : 0; haveHead_ = true; }
        if (cur_ >= total_) cur_ = total_ > 0 ? total_ - 1 : 0;
        dirty_ = true;
        break;
      }
      case pk::LITEMS: {
        uint8_t req = r.u7(); uint16_t start = r.u14(); uint8_t n = r.u7();
        if (req != req_) break;
        for (int k = 0; k < n && r.ok; k++) {
          Item it; it.idx = start + k; it.bpm = r.u14(); it.cam = r.u7(); it.dur = r.u14(); it.fl = r.u7();
          r.str(it.id, sizeof it.id); r.str(it.title, sizeof it.title); r.str(it.artist, sizeof it.artist);
          if (r.ok) cache_[it.idx % CACHE] = it;
        }
        inFlight_ = false; dirty_ = true;
        break;
      }
      case pk::GENRES: {
        int n = r.u7(); nGen_ = 0;
        for (int k = 0; k < n && r.ok; k++) { r.u14(); char g[25]; r.str(g, sizeof g); if (nGen_ < 40) { strncpy(gen_[nGen_], g, 24); gen_[nGen_][24] = 0; nGen_++; } }
        haveGen_ = true; dirty_ = true;
        break;
      }
      case pk::RESULT: {
        uint8_t code = r.u7(); char t[64]; r.str(t, sizeof t);
        if (!r.ok) break;
        loadWait_ = false;
        if (code == pk::R_LOADED) { say("Caricato", 1500, now); vib(70, 230); setView(V_DECK, now, false); }
        else if (code == pk::R_CONFIRM) { strncpy(confTitle_, t, sizeof confTitle_ - 1); confTitle_[sizeof confTitle_ - 1] = 0; toastUntil_ = 0; setView(V_CONFIRM, now, false); vib(50, 200); }
        else if (code == pk::R_NOTFOUND) say("Brano non trovato", 2000, now);
        else if (code == pk::R_BUSY) say("Sto gia caricando", 1500, now);
        else say(t[0] ? t : "Errore", 2500, now);
        dirty_ = true;
        break;
      }
      default: break;
    }
  }

  // timer: saluto a SOLCO, richieste della lista, uscita dalla lista dopo un po'
  void tick(uint32_t now) {
    if (conn_ && !helloOk_ && now - helloT_ > 2000) {
      helloT_ = now;
      Wr w(pk::HELLO); w.u7(pk::PROTO).u7(pk::MODEL_STOPWATCH).str(fw_); send(w);
    }
    if (deck_.valid && now - deck_.rx > 3000) { deck_.valid = false; dirty_ = true; }
    if (view_ == V_BROWSE) {
      if (now - touchT_ > 30000 && now - moveT_ > 30000) setView(V_DECK, now, true);
      else want(now);
    }
    if (view_ == V_CONFIRM && now - touchT_ > 15000) setView(V_BROWSE, now, false);
    if (loadWait_ && now - loadT_ > 6000) { loadWait_ = false; say("SOLCO non risponde", 2000, now); }
  }

  View view() const { return view_; }
  bool browsing() const { return view_ != V_DECK; }
  bool connected() const { return conn_; }
  bool linked() const { return conn_ && helloOk_; }
  bool toastOn(uint32_t now) const { return toastUntil_ && now < toastUntil_; }
  void setFw(const char* v) { strncpy(fw_, v, sizeof fw_ - 1); }
  // da ridisegnare: dati nuovi o qualcosa che si muove (scritta che scorre, lampeggio, messaggio)
  bool needsRedraw(uint32_t now) const {
    if (dirty_) return true;
    if (toastUntil_ && now < toastUntil_ + 50) return true;
    if (view_ != V_DECK) return true;
    if (marquee_) return true;
    if (deck_.valid && (deck_.flags & (pk::F_PLAYING | pk::F_WARN))) return true;
    return false;
  }

  // ---------- disegno (tela del mondo, W×H) ----------
  void draw(G& g, uint32_t now) {
    dirty_ = false; marquee_ = false;
    toastNow_ = toastUntil_ && now < toastUntil_;
    const int W = g.width(), H = g.height();
    cx_ = W / 2; cy_ = H / 2;
    g.fillScreen(C_BLACK);
    if (view_ == V_DECK) drawDeck(g, now);
    else if (view_ == V_BROWSE) drawBrowse(g, now);
    else drawConfirm(g, now);
    if (toastNow_) drawToast(g);
    else toastUntil_ = 0;
  }

 private:
  // ---------- stato ----------
  bool conn_ = false, helloOk_ = false, dirty_ = true, marquee_ = false;
  uint32_t helloT_ = 0, treqT_ = 0;
  char fw_[12] = "2.0", appVer_[16] = "";
  Deck deck_; Track track_; Wave wave_;
  int bat_ = -1; bool chg_ = false, cal_ = false, calRun_ = false;
  double turns_ = 0, anchor_ = 0; float rpm_ = 0;
  View view_ = V_DECK;
  uint32_t steadyT_ = 0, touchT_ = 0, moveT_ = 0;
  int dragAcc_ = 0;
  // lista
  Item cache_[CACHE];
  uint8_t req_ = 0; bool inFlight_ = false, haveHead_ = false; uint32_t reqT_ = 0;
  int total_ = 0, sel_ = -1, cur_ = 0;
  uint8_t sort_ = pk::S_ARTIST;
  char gen_[40][25]; int nGen_ = 0, genIdx_ = -1; bool haveGen_ = false, genWanted_ = false;
  bool loadWait_ = false; uint32_t loadT_ = 0;
  char confTitle_[64] = "";
  uint32_t hintT_ = 0; bool hint_ = false;
  // messaggio
  char toast_[64] = ""; uint32_t toastUntil_ = 0; bool toastNow_ = false;
  int cx_ = 233, cy_ = 233;

  typedef pk::Writer<96> Wr;
  void send(Wr& w) { size_t n = w.end(); if (n && out.send) out.send(w.b, n, out.ctx); }
  void vib(int ms, int level) { if (out.vibrate) out.vibrate(ms, level, out.ctx); }
  void say(const char* s, uint32_t ms, uint32_t now) {
    size_t n = strlen(s);
    if (n < sizeof toast_) memcpy(toast_, s, n + 1);
    else {                                                  // troppo lungo: si taglia a una parola e si mettono i puntini
      size_t k = sizeof toast_ - 4;
      while (k > 20 && s[k] != ' ') k--;
      memcpy(toast_, s, k); strcpy(toast_ + k, "...");
    }
    toastUntil_ = now + ms; if (!toastUntil_) toastUntil_ = 1; dirty_ = true;
  }

  void setView(View v, uint32_t now, bool buzz) {
    if (v == view_) return;
    bool wasBrowse = view_ != V_DECK, isBrowse = v != V_DECK;
    view_ = v; dirty_ = true; touchT_ = now; dragAcc_ = 0; steadyT_ = 0;
    if (wasBrowse != isBrowse && conn_) { Wr w(pk::BROWSE); w.u7(isBrowse ? 1 : 0); send(w); }
    if (buzz) vib(35, 180);
  }
  void enterBrowse(uint32_t now) {
    if (!linked()) { say(conn_ ? "Apri SOLCO sul tablet" : "Collega il puck a SOLCO", 2000, now); return; }
    if (fabsf(rpm_) > 3) { say("Ferma il disco per sfogliare", 2000, now); return; }
    setView(V_BROWSE, now, true);
    toastUntil_ = 0;
    anchor_ = turns_; moveT_ = now;
    newList(now);
    hintT_ = now; hint_ = true;
  }
  void newList(uint32_t now) {
    for (int i = 0; i < CACHE; i++) cache_[i].idx = -1;
    haveHead_ = false; total_ = 0; cur_ = 0; sel_ = -1;
    request(pk::NONE, now);
  }
  void request(uint16_t start, uint32_t now) {
    req_ = (uint8_t)((req_ + 1) & 0x7F);
    inFlight_ = true; reqT_ = now;
    Wr w(pk::LREQ);
    w.u7(req_).u7(sort_).u7(0).u14(start).u7(20).str(genIdx_ >= 0 ? gen_[genIdx_] : "");
    send(w);
  }
  // chiede i brani vicini se mancano
  void want(uint32_t now) {
    if (!haveHead_) { if (inFlight_ && now - reqT_ > 2500) request(pk::NONE, now); return; }
    if (total_ <= 0) return;
    if (inFlight_ && now - reqT_ < 1500) return;
    for (int d = -6; d <= 6; d++) {
      int i = cur_ + d;
      if (i < 0 || i >= total_) continue;
      if (!item(i)) { int s = cur_ - 10; if (s < 0) s = 0; request((uint16_t)s, now); return; }
    }
  }
  const Item* item(int idx) const {
    if (idx < 0) return nullptr;
    const Item& it = cache_[idx % CACHE];
    return it.idx == idx ? &it : nullptr;
  }
  void moveCursor(int steps, uint32_t now) {
    moveT_ = now;
    if (total_ <= 0) return;
    int c = cur_ + steps;
    if (c < 0) c = 0;
    if (c >= total_) c = total_ - 1;
    if (c != cur_) { cur_ = c; dirty_ = true; vib(22, 140); }
  }
  void cycleSort(uint32_t now) {
    // giro: artista, titolo, BPM, Camelot, compatibili col brano caricato, ultimi aggiunti
    static const uint8_t ORDER[pk::S_COUNT] = { pk::S_ARTIST, pk::S_TITLE, pk::S_BPM, pk::S_KEY, pk::S_COMPAT, pk::S_ADDED };
    int i = 0;
    while (i < pk::S_COUNT && ORDER[i] != sort_) i++;
    sort_ = ORDER[(i + 1) % pk::S_COUNT];
    newList(now); vib(30, 170);
  }
  void cycleGenre(uint32_t now) {
    if (!haveGen_) {
      if (!genWanted_) { genWanted_ = true; Wr w(pk::GREQ); send(w); }
      say("Carico i generi...", 1200, now);
      return;
    }
    if (nGen_ == 0) { say("Nessun genere nei brani", 1800, now); return; }
    genIdx_++;
    if (genIdx_ >= nGen_) genIdx_ = -1;
    newList(now); vib(30, 170);
  }
  void sendLoad(bool force, uint32_t now) {
    const Item* it = item(cur_);
    if (!it) return;
    if (!force) strncpy(confTitle_, it->title, sizeof confTitle_ - 1);
    Wr w(pk::LOAD); w.u7(force ? 1 : 0).str(it->id); send(w);
    loadWait_ = true; loadT_ = now;
    say("Carico...", 6000, now);
  }

  // ---------- disegno: aiuti ----------
  static int chord(int y, int r) { int q = r * r - y * y; return q > 0 ? (int)(2 * sqrtf((float)q)) : 0; }
  // testo centrato in x con larghezza massima: puntini se è lungo, oppure scorre (marquee)
  void text(G& g, const char* s, int x, int y, const lgfx::IFont* f, uint16_t col, int maxW, bool scroll, uint32_t now) {
    g.setFont(f);
    g.setTextColor(col);
    int w = g.textWidth(s);
    if (w <= maxW) { g.setTextDatum(lgfx::middle_center); g.drawString(s, cx_ + x, cy_ + y); return; }
    int h = g.fontHeight();
    if (scroll) {
      marquee_ = true;
      const int gap = 60, period = w + gap;                 // 40 punti al secondo, ferma 1,5 s a ogni giro
      const uint32_t pause = 1500, cycle = pause + (uint32_t)period * 25, t = now % cycle;
      int off = t < pause ? 0 : (int)((t - pause) / 25);
      int x0 = cx_ + x - maxW / 2;
      g.setClipRect(x0, cy_ + y - h, maxW, 2 * h);
      g.setTextDatum(lgfx::middle_left);
      g.drawString(s, x0 - off, cy_ + y);
      g.drawString(s, x0 - off + period, cy_ + y);
      g.clearClipRect();
      return;
    }
    // troppo lungo: si accorcia e si mettono i puntini
    char b[64];
    size_t n = strlen(s); if (n > sizeof b - 4) n = sizeof b - 4;
    for (;;) {
      while (n > 0 && s[n - 1] == ' ') n--;
      memcpy(b, s, n); b[n] = 0; strcat(b, "...");
      if (n == 0 || g.textWidth(b) <= maxW) break;
      n--;
    }
    g.setTextDatum(lgfx::middle_center);
    g.drawString(b, cx_ + x, cy_ + y);
  }
  void keyChip(G& g, uint8_t cam, int x, int y, int w, int h, const lgfx::IFont* f) {
    char cn[4]; pk::camName(cam, cn);
    g.fillRoundRect(cx_ + x - w / 2, cy_ + y - h / 2, w, h, h / 4, cam ? camColor(cam) : C_DARK);
    g.setFont(f); g.setTextDatum(lgfx::middle_center); g.setTextColor(cam ? rgb(10, 11, 13) : C_GRAY);
    g.drawString(cam ? cn : "--", cx_ + x, cy_ + y + 1);
  }
  static void fmtTime(char* b, size_t n, uint32_t ds, bool minus, bool tenths) {
    uint32_t s = ds / 10, m = s / 60;
    if (tenths) snprintf(b, n, "%s%02u:%02u.%u", minus ? "-" : "", (unsigned)m, (unsigned)(s % 60), (unsigned)(ds % 10));
    else snprintf(b, n, "%s%u:%02u", minus ? "-" : "", (unsigned)m, (unsigned)(s % 60));
  }
  // angolo LovyanGFX (0° = ore 3, senso orario) di una frazione di giro partendo da ore 12
  static float ang(float frac) { return -90.0f + frac * 360.0f; }

  void drawRing(G& g, uint32_t now) {
    const int r0 = 205, r1 = 231;
    const bool has = deck_.valid && (deck_.flags & pk::F_LOADED) && deck_.dur > 0;
    const float prog = has ? (float)deck_.pos / (float)deck_.dur : 0;
    const bool warn = has && (deck_.flags & pk::F_WARN);
    const bool blink = warn && (now / 400) % 2 == 0;
    if (has && wave_.valid && wave_.tseq == track_.tseq && track_.tseq == deck_.tseq) {
      const int n = wave_.n;
      const float step = 1.0f / n;
      for (int k = 0; k < n; k++) {
        int amp = wave_.v[k] & 31, band = (wave_.v[k] >> 5) & 3;
        if (band > 2) band = 2;
        int h = 3 + amp * (r1 - r0 - 3) / 31;
        float f0 = k * step, f1 = (k + 1) * step;
        bool played = f1 <= prog;
        uint16_t c = BAND_COL[band];
        if (warn && blink) c = C_RED;
        if (played) c = dim(c, 35);
        g.fillArc(cx_, cy_, r0 + h, r0, ang(f0) + 0.4f, ang(f1) - 0.4f, c);
      }
    } else {
      g.fillArc(cx_, cy_, r0 + 6, r0, 0, 360, C_DARK);
      if (has) g.fillArc(cx_, cy_, r0 + 6, r0, -90, ang(prog), blink ? C_RED : C_AMBER);
    }
    if (has) {                                              // puntina
      float a = ang(prog) * (float)M_PI / 180.0f;
      float ca = cosf(a), sa = sinf(a);
      for (int d = -1; d <= 1; d++) {
        float px = -sa * d, py = ca * d;
        g.drawLine(cx_ + (int)roundf(ca * (r0 - 6) + px), cy_ + (int)roundf(sa * (r0 - 6) + py),
                   cx_ + (int)roundf(ca * (r1 + 1) + px), cy_ + (int)roundf(sa * (r1 + 1) + py), warn ? C_RED : C_WHITE);
      }
    }
  }

  void statusLine(G& g, int y) {
    char b[48];
    const char* st = !conn_ ? "in attesa del tablet" : (!helloOk_ ? "apri SOLCO" : "SOLCO");
    if (bat_ >= 0) snprintf(b, sizeof b, "%s  %s%d%%", st, chg_ ? "+" : "", bat_);
    else snprintf(b, sizeof b, "%s", st);
    g.setFont(&lgfx::fonts::FreeSans9pt7b);
    g.setTextDatum(lgfx::middle_center);
    g.setTextColor(!conn_ || !helloOk_ ? C_AMBER : (bat_ >= 0 && bat_ <= 15 && !chg_ ? C_RED : C_GRAY));
    g.drawString(b, cx_, cy_ + y);
  }

  void drawDeck(G& g, uint32_t now) {
    drawRing(g, now);
    const bool has = deck_.valid && (deck_.flags & pk::F_LOADED) && track_.valid && track_.tseq == deck_.tseq;
    if (!cal_ || calRun_) {
      g.setFont(&lgfx::fonts::FreeSansBold12pt7b); g.setTextDatum(lgfx::middle_center); g.setTextColor(C_YELLOW);
      g.drawString(calRun_ ? "CALIBRAZIONE..." : "DA CALIBRARE", cx_, cy_ + 150);
      g.setFont(&lgfx::fonts::FreeSans9pt7b); g.setTextColor(C_GRAY);
      g.drawString(calRun_ ? "non toccare il disco" : "33 giri, pitch 0, tieni A", cx_, cy_ + 178);
    } else statusLine(g, 178);
    if (!has) {
      g.setFont(&lgfx::fonts::FreeSansBold24pt7b); g.setTextDatum(lgfx::middle_center); g.setTextColor(C_AMBER);
      g.drawString("SOLCO", cx_, cy_ - 40);
      g.setFont(&lgfx::fonts::FreeSans12pt7b); g.setTextColor(C_WHITE);
      if (!conn_) { g.drawString("In attesa del tablet", cx_, cy_ + 20); g.setTextColor(C_GRAY); g.setFont(&lgfx::fonts::FreeSans9pt7b); g.drawString(name, cx_, cy_ + 52); }
      else if (!helloOk_) g.drawString("Apri SOLCO sul tablet", cx_, cy_ + 20);
      else if (deck_.valid && (deck_.flags & pk::F_LOADING)) g.drawString("Carico...", cx_, cy_ + 20);
      else { g.drawString("Tocca per scegliere", cx_, cy_ + 20); g.drawString("un brano", cx_, cy_ + 48); }
      return;
    }
    // titolo e artista
    text(g, track_.title, 0, -128, &lgfx::fonts::FreeSansBold18pt7b, C_WHITE, chord(-128, 192) - 24, true, now);
    text(g, track_.artist[0] ? track_.artist : "-", 0, -90, &lgfx::fonts::FreeSans12pt7b, C_GRAY, chord(-90, 195) - 30, false, now);
    // BPM
    char b[24];
    if (deck_.bpm) snprintf(b, sizeof b, "%u.%02u", (unsigned)(deck_.bpm / 100), (unsigned)(deck_.bpm % 100));
    else snprintf(b, sizeof b, "--");
    g.setFont(&lgfx::fonts::DejaVu72); g.setTextDatum(lgfx::middle_center); g.setTextColor(C_WHITE);
    g.drawString(b, cx_ - 8, cy_ - 26);
    g.setFont(&lgfx::fonts::FreeSansBold9pt7b); g.setTextColor(C_GRAY); g.setTextDatum(lgfx::middle_left);
    g.drawString("BPM", cx_ + g.textWidth("0") , cy_ + 14);
    // pitch
    int32_t p = deck_.pitch;
    snprintf(b, sizeof b, "%s%ld.%02ld%%", p > 0 ? "+" : (p < 0 ? "-" : ""), (long)(labs(p) / 100), (long)(labs(p) % 100));
    g.setFont(&lgfx::fonts::FreeSansBold12pt7b); g.setTextDatum(lgfx::middle_right);
    g.setTextColor(p == 0 ? C_GREEN : C_WHITE);
    g.drawString(b, cx_ - 6, cy_ + 14);
    // tempo rimanente
    const bool warn = deck_.flags & pk::F_WARN;
    uint32_t rem = deck_.dur > deck_.pos ? deck_.dur - deck_.pos : 0;
    fmtTime(b, sizeof b, rem, true, true);
    g.setFont(&lgfx::fonts::DejaVu56); g.setTextDatum(lgfx::middle_center);
    g.setTextColor(warn && (now / 400) % 2 == 0 ? C_RED : (warn ? rgb(255, 160, 170) : C_WHITE));
    g.drawString(b, cx_, cy_ + 64);
    // tonalità e deck (sotto il messaggio, se c'è, non si disegnano)
    if (toastNow_) return;
    keyChip(g, track_.cam, -56, 120, 86, 40, &lgfx::fonts::FreeSansBold12pt7b);
    snprintf(b, sizeof b, "DECK %u", (unsigned)deck_.deck);
    g.setFont(&lgfx::fonts::FreeSansBold12pt7b); g.setTextDatum(lgfx::middle_center);
    g.setTextColor((deck_.flags & pk::F_PLAYING) ? C_GREEN : C_GRAY);
    g.drawString(b, cx_ + 50, cy_ + 121);
  }

  void drawBrowse(G& g, uint32_t now) {
    // anello: dove sei nella lista
    g.fillArc(cx_, cy_, 222, 216, 0, 360, C_DARK);
    if (total_ > 0) {
      float f = total_ > 1 ? (float)cur_ / (float)(total_ - 1) : 0;
      float a = ang(f * 0.98f);
      g.fillArc(cx_, cy_, 231, 207, a - 3, a + 3, C_AMBER);
    }
    // intestazione: ordine; piede: genere
    g.setFont(&lgfx::fonts::FreeSansBold12pt7b); g.setTextDatum(lgfx::middle_center); g.setTextColor(C_AMBER);
    g.drawString(SORT_NAME[sort_ < pk::S_COUNT ? sort_ : 0], cx_, cy_ - 168);
    g.setFont(&lgfx::fonts::FreeSans9pt7b); g.setTextColor(C_GRAY);
    g.drawString("tocca: cambia ordine", cx_, cy_ - 143);
    const char* gname = genIdx_ >= 0 ? gen_[genIdx_] : "TUTTI I GENERI";
    text(g, gname, 0, 168, &lgfx::fonts::FreeSansBold12pt7b, C_CYAN, chord(168, 200) - 16, false, now);
    countLine(g, now);
    if (!haveHead_) { text(g, "Carico la lista...", 0, 0, &lgfx::fonts::FreeSans12pt7b, C_WHITE, 380, false, now); return; }
    if (total_ <= 0) { text(g, "Nessun brano", 0, 0, &lgfx::fonts::FreeSansBold12pt7b, C_WHITE, 380, false, now); return; }
    char b[32];
    // vicini (sopra e sotto)
    for (int d = -1; d <= 1; d += 2) {
      const Item* it = item(cur_ + d);
      int y = d * 100;
      if (cur_ + d < 0 || cur_ + d >= total_) continue;
      if (d > 0 && toastNow_) continue;                     // sotto il messaggio
      if (!it) { text(g, "...", 0, y, &lgfx::fonts::FreeSans12pt7b, C_GRAY, 200, false, now); continue; }
      int cw = chord(y + (d < 0 ? -12 : 12), 200) - 40;
      text(g, it->title, 0, y - 10, &lgfx::fonts::FreeSans12pt7b, (it->fl & pk::I_LOADED) ? C_AMBER : rgb(205, 210, 218), cw, false, now);
      fmtBpm(b, sizeof b, it->bpm);
      char cn[4]; pk::camName(it->cam, cn);
      char line[48]; snprintf(line, sizeof line, "%s   %s", b, cn[0] ? cn : "--");
      text(g, line, 0, y + 16, &lgfx::fonts::FreeSans9pt7b, C_GRAY, cw, false, now);
    }
    // quello scelto
    g.fillRoundRect(cx_ - 190, cy_ - 58, 380, 116, 18, C_PANEL);
    g.drawRoundRect(cx_ - 190, cy_ - 58, 380, 116, 18, C_AMBER);
    g.drawRoundRect(cx_ - 189, cy_ - 57, 378, 114, 17, C_AMBER);
    const Item* it = item(cur_);
    if (!it) { text(g, "...", 0, 0, &lgfx::fonts::FreeSansBold12pt7b, C_WHITE, 300, false, now); return; }
    text(g, it->title, 0, -30, &lgfx::fonts::FreeSansBold12pt7b, (it->fl & pk::I_LOADED) ? C_AMBER : C_WHITE, 350, true, now);
    text(g, it->artist[0] ? it->artist : "-", 0, -2, &lgfx::fonts::FreeSans12pt7b, C_GRAY, 350, false, now);
    fmtBpm(b, sizeof b, it->bpm);
    g.setFont(&lgfx::fonts::FreeSansBold12pt7b); g.setTextDatum(lgfx::middle_right); g.setTextColor(C_WHITE);
    g.drawString(b, cx_ - 50, cy_ + 32);
    keyChip(g, it->cam, 0, 32, 64, 30, &lgfx::fonts::FreeSansBold9pt7b);
    fmtTimeS(b, sizeof b, it->dur);
    g.setTextDatum(lgfx::middle_left); g.setTextColor(C_WHITE);
    g.drawString(b, cx_ + 46, cy_ + 32);
    if (it->fl & pk::I_PLAYED) { g.fillCircle(cx_ + 166, cy_ - 30, 6, C_GREEN); }
  }
  // riga sotto la lista: all'apertura come si scorre, poi a che punto sei
  void countLine(G& g, uint32_t now) {
    g.setFont(&lgfx::fonts::FreeSans9pt7b); g.setTextDatum(lgfx::middle_center);
    if (hint_ && now - hintT_ < 4000) { g.setTextColor(C_AMBER); g.drawString("gira il disco o scorri col dito", cx_, cy_ + 140); return; }
    hint_ = false;
    if (!haveHead_ || total_ <= 0) return;
    char b[32]; snprintf(b, sizeof b, "%d / %d", cur_ + 1, total_);
    g.setTextColor(C_GRAY); g.drawString(b, cx_, cy_ + 140);
  }

  static void fmtBpm(char* b, size_t n, uint16_t bpm10) {
    if (!bpm10) snprintf(b, n, "-- BPM");
    else snprintf(b, n, "%u.%u BPM", (unsigned)(bpm10 / 10), (unsigned)(bpm10 % 10));
  }
  static void fmtTimeS(char* b, size_t n, uint16_t s) { if (!s) snprintf(b, n, "-:--"); else snprintf(b, n, "%u:%02u", (unsigned)(s / 60), (unsigned)(s % 60)); }

  void drawConfirm(G& g, uint32_t now) {
    g.fillArc(cx_, cy_, 231, 207, 0, 360, (now / 400) % 2 ? C_RED : dim(C_RED, 40));
    g.setFont(&lgfx::fonts::FreeSansBold18pt7b); g.setTextDatum(lgfx::middle_center); g.setTextColor(C_RED);
    g.drawString("IN ONDA", cx_, cy_ - 120);
    g.setFont(&lgfx::fonts::FreeSans12pt7b); g.setTextColor(C_WHITE);
    g.drawString("Il deck sta suonando.", cx_, cy_ - 80);
    g.drawString("Caricare comunque?", cx_, cy_ - 52);
    text(g, confTitle_, 0, -14, &lgfx::fonts::FreeSansBold12pt7b, C_AMBER, 340, true, now);
    g.fillRoundRect(cx_ - 170, cy_ + 30, 160, 90, 20, C_DARK);
    g.fillRoundRect(cx_ + 10, cy_ + 30, 160, 90, 20, C_RED);
    g.setFont(&lgfx::fonts::FreeSansBold18pt7b);
    g.setTextColor(C_WHITE); g.drawString("NO", cx_ - 90, cy_ + 75);
    g.setTextColor(C_WHITE); g.drawString("CARICA", cx_ + 90, cy_ + 75);
  }

  // messaggio in un riquadro dove copre le cose meno importanti (deck: tonalità e numero del deck;
  // lista: il brano sotto; conferma: la scritta in alto), sempre dentro l'anello del bordo.
  // Se non sta in una riga si usa un carattere più piccolo, poi due righe.
  static int toastMaxW(int y, int h) {
    const int R = 202, RR = 14;                          // raggio libero e raggio degli angoli
    int e = abs(y) + h / 2 - RR, q = (R - RR) * (R - RR) - e * e;
    return q > 0 ? 2 * (RR + (int)sqrtf((float)q)) : 0;
  }
  void toastBox(G& g, int y, int w, int h) {
    g.fillRoundRect(cx_ - w / 2, cy_ + y - h / 2, w, h, 14, rgb(16, 18, 22));
    g.drawRoundRect(cx_ - w / 2, cy_ + y - h / 2, w, h, 14, C_AMBER);
    g.setTextDatum(lgfx::middle_center); g.setTextColor(C_WHITE);
  }
  // copia s in out accorciandola con i puntini finché sta in maxW (carattere già scelto)
  static void fit(G& g, const char* s, char* out, size_t cap, int maxW) {
    size_t n = strlen(s); if (n > cap - 4) n = cap - 4;
    memcpy(out, s, n); out[n] = 0;
    if (g.textWidth(out) <= maxW) return;
    for (;;) {
      while (n > 0 && s[n - 1] == ' ') n--;
      memcpy(out, s, n); out[n] = 0; strcat(out, "...");
      if (n == 0 || g.textWidth(out) <= maxW) return;
      n--;
    }
  }
  void drawToast(G& g) {
    const int y = view_ == V_DECK ? 116 : (view_ == V_BROWSE ? 100 : -104);
    const lgfx::IFont* fonts[2] = { &lgfx::fonts::FreeSansBold12pt7b, &lgfx::fonts::FreeSans9pt7b };
    for (const lgfx::IFont* f : fonts) {                 // una riga
      g.setFont(f);
      int h = g.fontHeight() + 20, w = g.textWidth(toast_) + 34;
      if (w <= toastMaxW(y, h)) { toastBox(g, y, w, h); g.setFont(f); g.drawString(toast_, cx_, cy_ + y + 1); return; }
    }
    // due righe, carattere piccolo: a capo allo spazio più vicino a metà
    g.setFont(fonts[1]);
    const int lh = g.fontHeight(), h = 2 * lh + 16, mw = toastMaxW(y, h) - 34;
    const size_t n = strlen(toast_);
    size_t cut = 0;
    for (size_t i = 1; i + 1 < n; i++) if (toast_[i] == ' ' && (!cut || labs((long)i - (long)n / 2) < labs((long)cut - (long)n / 2))) cut = i;
    char a[64], b[64], l1[64], l2[64];
    if (cut) { memcpy(a, toast_, cut); a[cut] = 0; strncpy(b, toast_ + cut + 1, sizeof b - 1); b[sizeof b - 1] = 0; }
    else { strncpy(a, toast_, sizeof a - 1); a[sizeof a - 1] = 0; b[0] = 0; }
    fit(g, a, l1, sizeof l1, mw); fit(g, b, l2, sizeof l2, mw);
    int w = g.textWidth(l1); if (g.textWidth(l2) > w) w = g.textWidth(l2);
    w += 34;
    toastBox(g, y, w, h); g.setFont(fonts[1]);
    g.drawString(l1, cx_, cy_ + y - lh / 2 + 1);
    g.drawString(l2, cx_, cy_ + y + lh / 2 + 1);
  }
};

}  // namespace pui
