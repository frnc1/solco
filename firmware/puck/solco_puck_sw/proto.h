// SOLCO Puck con schermo — protocollo verso SOLCO (Bluetooth MIDI).
// Solo C++ standard: lo stesso file compila sul puck e sul computer (tests/puck_proto_host.cpp).
//
// Messaggi SysEx:  F0 7D 53 4C <comando> <dati a 7 bit> F7
//   numeri: u7 = 1 byte, u14 = 2 byte, u21 = 3 byte (dal più alto), s21 = u21 di (v + 2^20)
//   testi:  lunghezza u7 + caratteri ASCII stampabili
// Specchio esatto di PuckProto in web/js/midi.js.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace pk {

enum Cmd : uint8_t {
  STATE = 0x01, TRACK = 0x02, WAVE = 0x03, LHEAD = 0x04, LITEMS = 0x05, GENRES = 0x06, RESULT = 0x07, HELLOK = 0x08,
  HELLO = 0x10, LREQ = 0x11, LOAD = 0x12, BROWSE = 0x13, GREQ = 0x14, TREQ = 0x15,
};
static const uint16_t NONE = 0x3FFF;      // indice «nessuno» / «intorno al brano caricato»
static const uint8_t PROTO = 1;           // versione del protocollo
static const uint8_t MODEL_STOPWATCH = 2;

// bit dello stato del deck (STATE.flags)
enum Flag : uint8_t { F_LOADED = 1, F_PLAYING = 2, F_LOOP = 4, F_WARN = 8, F_TT = 16, F_KEYLOCK = 32, F_LOADING = 64 };
// ordine della lista (LREQ.sort)
enum Sort : uint8_t { S_ADDED = 0, S_TITLE = 1, S_ARTIST = 2, S_BPM = 3, S_KEY = 4, S_COMPAT = 5, S_COUNT = 6 };
// esito di LOAD (RESULT.code)
enum Res : uint8_t { R_LOADED = 0, R_CONFIRM = 1, R_NOTFOUND = 2, R_BUSY = 3, R_ERROR = 4 };
// bit degli elementi della lista (LITEMS.fl)
enum ItemFlag : uint8_t { I_LOADED = 1, I_PLAYED = 2, I_ANALYZED = 4 };

// -------- scrittura --------
template <size_t CAP>
struct Writer {
  uint8_t b[CAP];
  size_t n = 0;
  bool ok = true;
  explicit Writer(uint8_t cmd) { put(0xF0); put(0x7D); put(0x53); put(0x4C); put(cmd & 0x7F); }
  void put(uint8_t v) { if (n < CAP) b[n++] = v; else ok = false; }
  Writer& u7(int v) { put((uint8_t)(v < 0 ? 0 : v > 127 ? 127 : v)); return *this; }
  Writer& u14(long v) { if (v < 0) v = 0; if (v > 0x3FFF) v = 0x3FFF; put((v >> 7) & 0x7F); put(v & 0x7F); return *this; }
  Writer& u21(long v) { if (v < 0) v = 0; if (v > 0x1FFFFF) v = 0x1FFFFF; put((v >> 14) & 0x7F); put((v >> 7) & 0x7F); put(v & 0x7F); return *this; }
  Writer& s21(long v) { if (v < -0xFFFFF) v = -0xFFFFF; if (v > 0xFFFFF) v = 0xFFFFF; return u21(v + 0x100000); }
  Writer& str(const char* s, size_t max = 127) {
    size_t len = s ? strlen(s) : 0;
    if (len > max) len = max;
    if (len > 127) len = 127;
    put((uint8_t)len);
    for (size_t i = 0; i < len; i++) { uint8_t c = (uint8_t)s[i]; put(c >= 0x20 && c <= 0x7E ? c : '?'); }
    return *this;
  }
  size_t end() { put(0xF7); return ok ? n : 0; }
};

// -------- lettura --------
struct Reader {
  const uint8_t* p; size_t i, e; bool ok = true; uint8_t cmd = 0;
  Reader(const uint8_t* d, size_t n) : p(d), i(5), e(n ? n - 1 : 0) {
    ok = n >= 6 && d[0] == 0xF0 && d[1] == 0x7D && d[2] == 0x53 && d[3] == 0x4C && d[n - 1] == 0xF7;
    if (ok) cmd = d[4];
  }
  uint8_t byte() { if (i >= e) { ok = false; return 0; } return p[i++] & 0x7F; }
  uint8_t u7() { return byte(); }
  uint16_t u14() { uint16_t h = byte(); return (uint16_t)((h << 7) | byte()); }
  uint32_t u21() { uint32_t a = byte(), b = byte(); return (a << 14) | (b << 7) | byte(); }
  int32_t s21() { return (int32_t)u21() - 0x100000; }
  // copia il testo (troncato a cap-1) e termina con 0
  void str(char* out, size_t cap) {
    uint8_t n = byte();
    size_t k = 0;
    for (uint8_t j = 0; j < n; j++) { uint8_t c = byte(); if (k + 1 < cap) out[k++] = (c >= 0x20 && c <= 0x7E) ? (char)c : '?'; }
    if (cap) out[k] = 0;
  }
};

// -------- Bluetooth MIDI in arrivo: ricompone i SysEx (anche divisi su più pacchetti) --------
// Pacchetto: intestazione (bit7=1), poi [orario][stato][dati]...; nei SysEx lunghi i pacchetti
// seguenti iniziano con l'intestazione e continuano coi dati; F7 è preceduto da un byte d'orario.
template <size_t MAX>
class BleMidiIn {
 public:
  typedef void (*Cb)(const uint8_t* d, size_t n, void* ctx);
  BleMidiIn(Cb cb, void* ctx) : cb_(cb), ctx_(ctx) {}
  void feed(const uint8_t* p, size_t n) {
    if (n < 2 || !(p[0] & 0x80)) return;
    size_t i = 1;
    while (i < n) {
      uint8_t b = p[i];
      if (b & 0x80) {                       // byte d'orario
        i++;
        if (i >= n) break;
        uint8_t s = p[i];
        if (s & 0x80) { status(s); i++; }
        continue;                            // altrimenti: dati con lo stato precedente
      }
      data(b);
      i++;
    }
  }
  void reset() { sx_ = false; len_ = 0; over_ = false; }
 private:
  void status(uint8_t s) {
    if (s >= 0xF8) return;                                    // tempo reale: non interrompe nulla
    if (s == 0xF0) { sx_ = true; over_ = false; len_ = 0; buf_[len_++] = s; return; }
    if (s == 0xF7) {
      if (sx_ && !over_ && len_ + 1 <= MAX) { buf_[len_++] = s; if (cb_) cb_(buf_, len_, ctx_); }
      sx_ = false; len_ = 0;
      return;
    }
    sx_ = false; len_ = 0;                                    // un altro stato chiude un SysEx incompleto
  }
  void data(uint8_t b) {
    if (!sx_) return;                                         // i messaggi di canale non servono al puck
    if (len_ + 1 < MAX) buf_[len_++] = b; else over_ = true;
  }
  Cb cb_; void* ctx_;
  uint8_t buf_[MAX];
  size_t len_ = 0;
  bool sx_ = false, over_ = false;
};

// -------- Bluetooth MIDI in uscita: un SysEx diviso in pacchetti da al più `mtu` byte --------
// emit(pkt, n) viene chiamata per ogni pacchetto. tsMs = orario in millisecondi (13 bit).
template <typename Emit>
inline int bleSysexPackets(const uint8_t* m, size_t n, size_t mtu, uint16_t tsMs, Emit emit) {
  if (mtu < 5) return 0;
  if (mtu > 512) mtu = 512;
  uint8_t pkt[512];
  const uint8_t hdr = 0x80 | ((tsMs >> 7) & 0x3F), ts = 0x80 | (tsMs & 0x7F);
  size_t k = 0;
  int count = 0;
  pkt[k++] = hdr;
  pkt[k++] = ts;
  for (size_t i = 0; i < n; i++) {
    const uint8_t b = m[i];
    const size_t need = (b == 0xF7) ? 2 : 1;
    if (k + need > mtu) { emit(pkt, k); count++; k = 0; pkt[k++] = hdr; }
    if (b == 0xF7) pkt[k++] = ts;
    pkt[k++] = b;
  }
  if (k > 1) { emit(pkt, k); count++; }
  return count;
}

// Camelot: codice 1..24 (1A=1, 1B=2 … 12B=24) → «8A»; 0 = sconosciuto → ""
inline void camName(uint8_t k, char out[4]) {
  if (k < 1 || k > 24) { out[0] = 0; return; }
  int n = (k + 1) / 2;
  int i = 0;
  if (n >= 10) out[i++] = '1';
  out[i++] = (char)('0' + n % 10);
  out[i++] = (k % 2) ? 'A' : 'B';
  out[i] = 0;
}

}  // namespace pk
