// Prova del protocollo del puck con schermo, lato puck (firmware/puck/solco_puck_sw/proto.h) sul computer.
// La usa tests/puck_proto.test.js:
//   puck_proto_host decode   < righe esadecimali (SysEx dal tablet)  → una riga JSON per messaggio
//   puck_proto_host encode                                         → SysEx dal puck in esadecimale
//   puck_proto_host ble      < righe esadecimali                    → stesso SysEx dopo pacchetti BLE da 20/23/185 byte
// Compilazione: g++ -std=c++17 -O1 -I firmware/puck/solco_puck_sw tests/puck_proto_host.cpp -o /tmp/puck_proto_host
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "proto.h"

static std::vector<uint8_t> unhex(const std::string& s) {
  std::vector<uint8_t> v;
  for (size_t i = 0; i + 1 < s.size(); i += 2) v.push_back((uint8_t)std::stoul(s.substr(i, 2), nullptr, 16));
  return v;
}
static std::string hex(const uint8_t* d, size_t n) {
  static const char* H = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) { s += H[d[i] >> 4]; s += H[d[i] & 15]; }
  return s;
}
static std::string jstr(const char* s) {
  std::string o = "\"";
  for (; *s; s++) { if (*s == '"' || *s == '\\') o += '\\'; o += *s; }
  return o + "\"";
}

static void decode(const std::vector<uint8_t>& m) {
  pk::Reader r(m.data(), m.size());
  if (!r.ok) { printf("null\n"); return; }
  char a[128], b[128], c[128], d[128];
  std::string o = "{\"cmd\":" + std::to_string(r.cmd);
  switch (r.cmd) {
    case pk::STATE: {
      int fl = r.u7(); long pos = r.u21(), dur = r.u21(), bpm = r.u21(); long pitch = r.s21(); int tseq = r.u7(), deck = r.u7();
      o += ",\"flags\":" + std::to_string(fl) + ",\"pos\":" + std::to_string(pos) + ",\"dur\":" + std::to_string(dur) + ",\"bpm\":" + std::to_string(bpm) +
           ",\"pitch\":" + std::to_string(pitch) + ",\"tseq\":" + std::to_string(tseq) + ",\"deck\":" + std::to_string(deck);
      break;
    }
    case pk::TRACK: {
      int tseq = r.u7(); long bpm = r.u21(); int cam = r.u7(); long dur = r.u21(); r.str(a, sizeof a); r.str(b, sizeof b); r.str(c, sizeof c);
      char cn[4]; pk::camName(cam, cn);
      o += ",\"tseq\":" + std::to_string(tseq) + ",\"bpm\":" + std::to_string(bpm) + ",\"cam\":" + std::to_string(cam) + ",\"camName\":" + jstr(cn) +
           ",\"dur\":" + std::to_string(dur) + ",\"title\":" + jstr(a) + ",\"artist\":" + jstr(b) + ",\"genre\":" + jstr(c);
      break;
    }
    case pk::WAVE: {
      int tseq = r.u7(), n = r.u7();
      o += ",\"tseq\":" + std::to_string(tseq) + ",\"bins\":[";
      for (int k = 0; k < n; k++) o += (k ? "," : "") + std::to_string(r.u7());
      o += "]";
      break;
    }
    case pk::LHEAD: {
      int req = r.u7(), total = r.u14(), sel = r.u14(), sort = r.u7(), compat = r.u7(); r.str(a, sizeof a);
      o += ",\"req\":" + std::to_string(req) + ",\"total\":" + std::to_string(total) + ",\"sel\":" + std::to_string(sel) + ",\"sort\":" + std::to_string(sort) +
           ",\"compat\":" + std::to_string(compat) + ",\"genre\":" + jstr(a);
      break;
    }
    case pk::LITEMS: {
      int req = r.u7(), start = r.u14(), n = r.u7();
      o += ",\"req\":" + std::to_string(req) + ",\"start\":" + std::to_string(start) + ",\"items\":[";
      for (int k = 0; k < n; k++) {
        int bpm = r.u14(), cam = r.u7(), dur = r.u14(), fl = r.u7(); r.str(a, 16); r.str(b, 52); r.str(c, 36);
        o += std::string(k ? "," : "") + "{\"bpm\":" + std::to_string(bpm) + ",\"cam\":" + std::to_string(cam) + ",\"dur\":" + std::to_string(dur) +
             ",\"fl\":" + std::to_string(fl) + ",\"id\":" + jstr(a) + ",\"title\":" + jstr(b) + ",\"artist\":" + jstr(c) + "}";
      }
      o += "]";
      break;
    }
    case pk::GENRES: {
      int n = r.u7();
      o += ",\"list\":[";
      for (int k = 0; k < n; k++) { int cnt = r.u14(); r.str(a, 25); o += std::string(k ? "," : "") + "{\"n\":" + std::to_string(cnt) + ",\"name\":" + jstr(a) + "}"; }
      o += "]";
      break;
    }
    case pk::RESULT: { int code = r.u7(); r.str(a, sizeof a); o += ",\"code\":" + std::to_string(code) + ",\"text\":" + jstr(a); break; }
    case pk::HELLOK: { int deck = r.u7(); r.str(a, sizeof a); o += ",\"deck\":" + std::to_string(deck) + ",\"version\":" + jstr(a); break; }
    default: printf("null\n"); return;
  }
  if (!r.ok) { printf("null\n"); return; }
  (void)d;
  printf("%s}\n", o.c_str());
}

template <size_t N> static void out(pk::Writer<N>& w) { size_t n = w.end(); printf("%s\n", hex(w.b, n).c_str()); }

static void encode() {
  { pk::Writer<64> w(pk::HELLO); w.u7(pk::PROTO).u7(pk::MODEL_STOPWATCH).str("2.0"); out(w); }
  { pk::Writer<64> w(pk::LREQ); w.u7(5).u7(pk::S_ARTIST).u7(0).u14(pk::NONE).u7(30).str(""); out(w); }
  { pk::Writer<64> w(pk::LREQ); w.u7(127).u7(pk::S_KEY).u7(1).u14(1234).u7(12).str("tech house"); out(w); }
  { pk::Writer<64> w(pk::LOAD); w.u7(0).str("t1x2y3z"); out(w); }
  { pk::Writer<64> w(pk::LOAD); w.u7(1).str("tabc"); out(w); }
  { pk::Writer<64> w(pk::BROWSE); w.u7(1); out(w); }
  { pk::Writer<64> w(pk::BROWSE); w.u7(0); out(w); }
  { pk::Writer<64> w(pk::GREQ); out(w); }
  { pk::Writer<64> w(pk::TREQ); out(w); }
}

struct Got { std::vector<std::vector<uint8_t>> msgs; };
static void onSx(const uint8_t* d, size_t n, void* ctx) { ((Got*)ctx)->msgs.emplace_back(d, d + n); }

static void ble(const std::vector<uint8_t>& m) {
  const size_t mtus[] = { 20, 23, 185 };
  std::string res;
  for (size_t mtu : mtus) {
    Got g;
    pk::BleMidiIn<2048> in(onSx, &g);
    std::vector<std::vector<uint8_t>> pkts;
    pk::bleSysexPackets(m.data(), m.size(), mtu, 1234, [&](const uint8_t* p, size_t n) { pkts.emplace_back(p, p + n); });
    bool sizeOk = true;
    for (auto& p : pkts) { if (p.size() > mtu) sizeOk = false; in.feed(p.data(), p.size()); }
    // un pacchetto di note (rotazione del puck) in mezzo non deve disturbare
    const uint8_t frame[] = { 0x89, 0xD2, 0x8C, 0x01, 0x02, 0xD2, 0x9C, 0x03, 0x04 };
    in.feed(frame, sizeof frame);
    if (!sizeOk || g.msgs.size() != 1) { res += (res.empty() ? "" : " ") + std::string("ERR"); continue; }
    res += (res.empty() ? "" : " ") + hex(g.msgs[0].data(), g.msgs[0].size());
  }
  printf("%s\n", res.c_str());
}

int main(int argc, char** argv) {
  std::string mode = argc > 1 ? argv[1] : "";
  if (mode == "encode") { encode(); return 0; }
  char line[1 << 16];
  while (fgets(line, sizeof line, stdin)) {
    std::string s(line);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    if (s.empty()) continue;
    auto m = unhex(s);
    if (mode == "decode") decode(m);
    else if (mode == "ble") ble(m);
  }
  return 0;
}
