// Simulazione sul computer delle schermate del puck con schermo (firmware/puck/solco_puck_sw/ui.h).
// Stessa logica e stessi disegni del puck (LovyanGFX), senza hardware: controlla il comportamento
// (lista, caricamento, conferma, ritorno al deck) e salva le schermate in PNG.
//
// Compilazione (serve M5GFX): tests/build_puck_sim.sh  → /tmp/puck_ui_sim <cartella per le immagini PPM>
#ifndef LGFX_LINUX_FB
#define LGFX_LINUX_FB
#endif
#include <lgfx/v1/platforms/common.hpp>
#include <lgfx/v1/LGFX_Sprite.hpp>
#include <lgfx/v1/lgfx_fonts.hpp>
#include <cstdio>
#include <string>
#include <vector>
#include "ui.h"

static int fails = 0;
static void check(const char* name, bool ok, const std::string& info = "") {
  printf("%s%s%s\n", ok ? "ok   " : "FAIL ", name, ok || info.empty() ? "" : ("  -> " + info).c_str());
  if (!ok) fails++;
}

// ---------- messaggi in uscita dal puck ----------
static std::vector<std::vector<uint8_t>> sent;
static int vibs = 0;
static void onSend(const uint8_t* d, size_t n, void*) { sent.emplace_back(d, d + n); }
static void onVib(int, int, void*) { vibs++; }
static int countCmd(uint8_t cmd) { int c = 0; for (auto& m : sent) if (m.size() > 4 && m[4] == cmd) c++; return c; }
static const std::vector<uint8_t>* last(uint8_t cmd) { for (int i = (int)sent.size() - 1; i >= 0; i--) if (sent[i].size() > 4 && sent[i][4] == cmd) return &sent[i]; return nullptr; }

// ---------- messaggi da SOLCO ----------
typedef pk::Writer<2048> W;
static void feed(pui::Puck& p, W& w, uint32_t now) { size_t n = w.end(); p.onSysex(w.b, n, now); }

struct T { const char* id; const char* title; const char* artist; int bpm10; int cam; int dur; };
static const T LIB[] = {
  { "ta1", "Around the World", "Daft Punk", 1213, 15, 429 }, { "ta2", "Blue Monday", "New Order", 1300, 9, 449 },
  { "ta3", "Can You Feel It", "Mr. Fingers", 1200, 18, 376 }, { "ta4", "Da Funk", "Daft Punk", 1115, 13, 328 },
  { "ta5", "Energy Flash", "Joey Beltram", 1340, 3, 312 }, { "ta6", "French Kiss", "Lil Louis", 1230, 21, 595 },
  { "ta7", "Good Life", "Inner City", 1220, 4, 330 }, { "ta8", "Insomnia (Monster Mix)", "Faithless", 1280, 22, 512 },
  { "ta9", "Music Sounds Better With You", "Stardust", 1240, 11, 412 }, { "tb0", "Your Love", "Frankie Knuckles", 1170, 7, 462 },
};
static const int NLIB = sizeof LIB / sizeof LIB[0];

static void answerList(pui::Puck& p, uint32_t now, int selIdx) {
  const auto* m = last(pk::LREQ);
  if (!m) return;
  pk::Reader r(m->data(), m->size());
  uint8_t req = r.u7(), sort = r.u7(), compat = r.u7(); uint16_t start = r.u14(); uint8_t count = r.u7();
  if (start == pk::NONE) start = (uint16_t)std::max(0, selIdx - count / 2);
  { W w(pk::LHEAD); w.u7(req).u14(NLIB).u14(selIdx < 0 ? pk::NONE : selIdx).u7(sort).u7(compat).str(""); feed(p, w, now); }
  int end = std::min(NLIB, start + count);
  for (int i = start; i < end; i += 6) {
    W w(pk::LITEMS); int n = std::min(6, end - i);
    w.u7(req).u14(i).u7(n);
    for (int k = 0; k < n; k++) { const T& t = LIB[i + k]; w.u14(t.bpm10).u7(t.cam).u14(t.dur).u7(i + k == selIdx ? 5 : (i + k == 2 ? 6 : 4)).str(t.id).str(t.title).str(t.artist); }
    feed(p, w, now);
  }
}

// ---------- schermo rotondo: tela del mondo girata come fa il puck ----------
static lgfx::LGFX_Sprite world, screen;
static void shot(pui::Puck& p, const char* dir, const char* name, uint32_t now, float angleDeg) {
  p.draw(world, now);
  screen.fillScreen(0x0000);
  world.pushRotateZoom(&screen, screen.width() / 2.0f, screen.height() / 2.0f, angleDeg, 1, 1);
  // bordo dello schermo: fuori dal cerchio nero, cornice grigia
  const int c = screen.width() / 2;
  for (int y = 0; y < screen.height(); y++)
    for (int x = 0; x < screen.width(); x++) {
      int dx = x - c, dy = y - c;
      if (dx * dx + dy * dy > 233 * 233) screen.drawPixel(x, y, (dx * dx + dy * dy < 246 * 246) ? pui::rgb(70, 74, 82) : pui::rgb(18, 19, 22));
    }
  // immagine PPM (la converte in PNG chi la usa)
  std::string path = std::string(dir) + "/" + name + ".ppm";
  FILE* f = fopen(path.c_str(), "wb");
  if (!f) return;
  fprintf(f, "P6 %d %d 255\n", screen.width(), screen.height());
  for (int y = 0; y < screen.height(); y++)
    for (int x = 0; x < screen.width(); x++) {
      uint32_t px = screen.readPixel(x, y);
      uint8_t rgb3[3] = { (uint8_t)(((px >> 11) & 31) * 255 / 31), (uint8_t)(((px >> 5) & 63) * 255 / 63), (uint8_t)((px & 31) * 255 / 31) };
      fwrite(rgb3, 1, 3, f);
    }
  fclose(f);
}

int main(int argc, char** argv) {
  const char* dir = argc > 1 ? argv[1] : "/tmp";
  world.setColorDepth(16); world.createSprite(466, 466);
  screen.setColorDepth(16); screen.createSprite(490, 490);

  pui::Puck p;
  p.out.send = onSend; p.out.vibrate = onVib;
  strcpy(p.name, "SOLCO Puck 3F2A");
  uint32_t now = 1000;
  p.setStatus(82, false, true, false);

  shot(p, dir, "puck_0_attesa", now, 0);
  p.onConnect(true, now);
  now += 2100; p.tick(now);
  check("HELLO dopo il collegamento", countCmd(pk::HELLO) == 1);
  shot(p, dir, "puck_1_apri_solco", now, 0);
  { W w(pk::HELLOK); w.u7(1).str("1.6.0"); feed(p, w, now); }
  check("collegato a SOLCO", p.linked());
  now += 2100; p.tick(now);
  check("niente altri HELLO", countCmd(pk::HELLO) == 1);
  { W w(pk::STATE); w.u7(0).u21(0).u21(0).u21(0).s21(0).u7(0).u7(1); feed(p, w, now); }
  shot(p, dir, "puck_2_nessun_brano", now, 0);

  // brano caricato e in onda
  { W w(pk::TRACK); w.u7(3).u21(12450).u7(15).u21(4290).str("Around the World (Radio Edit)").str("Daft Punk").str("House"); feed(p, w, now); }
  { W w(pk::WAVE); w.u7(3).u7(120); for (int k = 0; k < 120; k++) { int a = (int)(14 + 13 * sin(k * 0.21) * sin(k * 0.05 + 1)); if (a < 2) a = 2; w.u7(a | ((k / 17) % 3) << 5); } feed(p, w, now); }
  { W w(pk::STATE); w.u7(pk::F_LOADED | pk::F_PLAYING | pk::F_TT).u21(1530).u21(4290).u21(12687).s21(191).u7(3).u7(1); feed(p, w, now); }
  check("brano letto senza TREQ", countCmd(pk::TREQ) == 0);
  shot(p, dir, "puck_3_deck", now - now % 20000 + 500, 0);     // titolo all'inizio del giro
  shot(p, dir, "puck_3b_deck_ruotato", now, 37);         // lo stesso, con il puck girato di 37° (contro-rotazione)
  { W w(pk::STATE); w.u7(pk::F_LOADED | pk::F_PLAYING | pk::F_TT | pk::F_WARN).u21(4050).u21(4290).u21(12687).s21(191).u7(3).u7(1); feed(p, w, now); }
  shot(p, dir, "puck_4_fine_brano", (now / 800) * 800 + 100, 0);

  // stato con un altro brano: il puck chiede i dati
  { W w(pk::STATE); w.u7(pk::F_LOADED).u21(0).u21(3000).u21(12000).s21(0).u7(4).u7(1); feed(p, w, now + 5000); }
  check("TREQ se il brano cambia", countCmd(pk::TREQ) == 1);
  { W w(pk::TRACK); w.u7(4).u21(12000).u7(18).u21(3760).str("Can You Feel It").str("Mr. Fingers").str("Deep House"); feed(p, w, now); }

  // a disco in moto la lista non si apre
  p.setMotion(0.0, 33.3f, now);
  p.buttonA(now);
  check("lista chiusa a disco in moto", p.view() == pui::V_DECK);
  // con un brano nel deck un tocco non apre la lista (dito sul puck mentre si cerca l'attacco)
  p.setMotion(0.0, 0.0f, now);
  p.tap(0, 0, now);
  check("tocco con un brano caricato: lista chiusa", p.view() == pui::V_DECK && p.toastOn(now));
  // disco fermo: tasto A → lista
  sent.clear();
  now += 1600;
  p.buttonA(now);
  check("lista aperta", p.view() == pui::V_BROWSE);
  check("BROWSE acceso", last(pk::BROWSE) && (*last(pk::BROWSE))[5] == 1);
  check("LREQ intorno al brano caricato", last(pk::LREQ) && pk::Reader(last(pk::LREQ)->data(), last(pk::LREQ)->size()).u7() >= 0);
  {
    pk::Reader r(last(pk::LREQ)->data(), last(pk::LREQ)->size());
    r.u7(); uint8_t sort = r.u7(); r.u7(); uint16_t start = r.u14(); uint8_t count = r.u7();
    check("prima richiesta: ordine ARTISTA, intorno al caricato", sort == pk::S_ARTIST && start == pk::NONE && count == 20);
  }
  shot(p, dir, "puck_5_carico_lista", now, 0);
  answerList(p, now, 2);
  shot(p, dir, "puck_6_lista", now, 0);
  // girare il disco scorre: 15° = un brano
  p.setMotion(30.5 / 360.0, 4.0f, now + 100);
  now += 200;
  shot(p, dir, "puck_7_lista_scorsa", now, -30.5f);
  // conferma: il deck sta suonando
  sent.clear();
  p.tap(5, 10, now);
  {
    const auto* m = last(pk::LOAD);
    check("LOAD inviato", m != nullptr);
    if (m) { pk::Reader r(m->data(), m->size()); uint8_t force = r.u7(); char id[16]; r.str(id, 16); check("LOAD del brano giusto, senza forzare", force == 0 && std::string(id) == "ta5", id); }
  }
  shot(p, dir, "puck_7b_carico", now, 0);
  { W w(pk::RESULT); w.u7(pk::R_CONFIRM).str("Energy Flash"); feed(p, w, now); }
  check("schermata di conferma", p.view() == pui::V_CONFIRM);
  check("conferma: niente messaggio sopra i tasti", !p.toastOn(now));
  shot(p, dir, "puck_8_conferma", now, 0);
  sent.clear();
  p.tap(80, 70, now);                                      // tocco su CARICA
  {
    const auto* m = last(pk::LOAD);
    check("LOAD forzato", m && pk::Reader(m->data(), m->size()).u7() == 1);
  }
  { W w(pk::RESULT); w.u7(pk::R_LOADED).str("Energy Flash"); feed(p, w, now); }
  check("caricato: si torna al deck", p.view() == pui::V_DECK);
  check("BROWSE spento", last(pk::BROWSE) && (*last(pk::BROWSE))[5] == 0);
  shot(p, dir, "puck_9_caricato", now, 0);

  // cambio ordine dalla lista (tocco in alto) e uscita da sola quando parte il giradischi
  p.setMotion(0.0, 0.0f, now);
  p.buttonA(now);
  answerList(p, now, 4);
  sent.clear();
  p.tap(0, -170, now);
  {
    const auto* m = last(pk::LREQ);
    pk::Reader r(m->data(), m->size()); r.u7();
    check("tocco in alto: ordine TITOLO", m && r.u7() == pk::S_TITLE);
  }
  answerList(p, now, 4);
  for (int k = 0; k < 10; k++) { now += 100; p.setMotion(0.0, 33.3f, now); }
  check("giradischi partito: torna al deck", p.view() == pui::V_DECK);
  // messaggi lunghi: carattere piccolo o due righe, dentro l'anello
  p.message("Non riuscita: 33 giri, pitch 0", 5000, now);
  shot(p, dir, "puck_11_messaggio_lungo", now, 0);
  p.setMotion(0.0, 0.0f, now);
  p.buttonA(now);
  answerList(p, now, 4);
  { W w(pk::RESULT); w.u7(pk::R_ERROR).str("Impossibile leggere il file audio dalla cartella scelta"); feed(p, w, now); }
  shot(p, dir, "puck_12_errore_in_lista", now, 0);
  p.buttonB(now);
  check("tasto B: chiude la lista", p.view() == pui::V_DECK);
  // senza collegamento la lista non si apre
  p.onConnect(false, now);
  p.buttonA(now);
  check("scollegato: niente lista", p.view() == pui::V_DECK);
  shot(p, dir, "puck_10_scollegato", now, 0);
  check("qualche vibrazione", vibs > 3);

  printf("%s\n", fails ? "PROVE FALLITE" : "tutte le prove del puck con schermo passano");
  return fails ? 1 : 0;
}
