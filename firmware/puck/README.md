# SOLCO Puck (M5StickS3 e M5Stack StopWatch)

Programmi per il puck del giradischi: il giroscopio misura quanto gira il disco e lo manda a SOLCO via Bluetooth MIDI (nome «SOLCO Puck XXXX»). Istruzioni d'uso nel README principale, sezioni «Giradischi come controller» e «Puck con schermo».

| Cartella | Scheda | Nella versione pubblicata |
|---|---|---|
| `solco_puck/` | M5StickS3 | `solco-puck.bin` |
| `solco_puck_sw/` | M5Stack StopWatch (schermo tondo 466×466, tocco) | `solco-puck-stopwatch.bin` |

Il file `.bin` è un'immagine unica da scrivere all'indirizzo `0x0`.

## Protocollo del disco (canale MIDI 13, tutti e due i puck)

**Programma 1.1.** Ogni 10 ms (ogni 50 ms a disco fermo) un solo pacchetto Bluetooth di 17 byte con 4 messaggi, 56 bit utili:

| Messaggio | Contenuto |
|---|---|
| `8C tt tt` | orario del puck in decimi di millisecondo (14 bit, riparte ogni 1,6384 s) |
| `9C aa aa` | angolo del disco, bit 0–13 (angolo in 1/524288 di giro, 21 bit, riparte ogni 4 giri) |
| `AC aa rr` | angolo bit 14–20 e giri al minuto bit 0–6 |
| `EC rr rr` | giri al minuto bit 7–20 (giri al minuto × 4000 con segno, spostati di 2^20) |

Ogni secondo, con il pacchetto di stato:

| CC | Valore |
|---|---|
| 105 | batteria in % |
| 106 | stato: bit0 calibrato, bit1 calibrazione in corso, bit2 in carica (StopWatch: cavo USB collegato) |

Con orario e angolo SOLCO fa seguire al brano la **posizione** del disco, come un DVS: un margine di pochi millesimi (adattato da solo ai ritardi del Bluetooth) assorbe l'arrivo irregolare dei pacchetti, tra un campione e l'altro la traiettoria è interpolata con le velocità misurate, e il punto dello scratch non scivola.

**Programma 1.0** (solo velocità): CC 102, 103, 104 = giri al minuto × 4000 con segno, 21 bit. SOLCO lo riconosce ancora e segue la velocità.

`tests/vc_sim.js` simula disco, puck e Bluetooth (pacchetti ogni 7,5, 15 e 30 ms, ritardi irregolari) e misura ritardo, scivolamento del punto dopo gli scratch e tremolio del tempo.

## Puck con schermo: messaggi SysEx

Sullo stesso collegamento Bluetooth MIDI, in tutti e due i versi: `F0 7D 53 4C cmd … F7` (`7D` = uso non commerciale, `53 4C` = «SL»). Codifica dei campi: **u7** un byte; **u14** due byte, prima i 7 bit alti; **u21** tre byte, prima i 7 bit alti; **s21** = u21 del valore + 2^20; **testo** = lunghezza (u7) e caratteri ASCII stampabili (accenti tolti, `?` per il resto). Stesso codice in `web/js/midi.js` (PuckProto) e in `solco_puck_sw/proto.h`; `tests/puck_proto.test.js` controlla che i due diano gli stessi byte, anche spezzati in pacchetti Bluetooth da 20, 23 e 185 byte.

Da SOLCO al puck:

| cmd | Nome | Campi | Quando |
|---|---|---|---|
| `01` | STATE | stato u7, posizione u21, durata u21 (decimi di s), BPM×100 u21, pitch %×100 s21, n° brano u7, deck u7 | 10 volte al secondo |
| `02` | TRACK | n° brano, BPM×100 u21, Camelot u7, durata u21 (decimi di s), titolo (48), artista (40), genere (24) | a ogni brano caricato e su richiesta |
| `03` | WAVE | n° brano, quanti (120), spicchi u7: ampiezza 0–31 + banda × 32 (0 bassi, 1 medi, 2 alti) | con TRACK |
| `04` | LHEAD | richiesta u7, totale u14, brano caricato u14 (`3FFF` = nessuno), ordine u7, compatibili u7, genere | risposta a LREQ |
| `05` | LITEMS | richiesta, primo u14, quanti u7 (al più 6), poi per ognuno: BPM×10 u14, Camelot u7, durata s u14, segni u7, id (15), titolo (48), artista (32) | dopo LHEAD |
| `06` | GENRES | quanti u7, poi per ognuno: brani u14, nome (24) — i 40 più usati, in ordine alfabetico | risposta a GREQ |
| `07` | RESULT | esito u7: 0 caricato, 1 deck in onda (serve conferma), 2 brano non trovato, 3 sta già caricando, 4 errore; testo | risposta a LOAD |
| `08` | HELLOK | deck u7, versione di SOLCO (16) | risposta a HELLO |

Stato: bit0 brano caricato, bit1 in riproduzione, bit2 loop, bit3 fine brano vicina, bit4 giradischi, bit5 key lock, bit6 sta caricando. Camelot: 1A = 1, 1B = 2 … 12B = 24, 0 = non nota. Segni dei brani: bit0 nel deck, bit1 suonato nelle ultime 12 ore, bit2 analizzato.

Dal puck a SOLCO:

| cmd | Nome | Campi |
|---|---|---|
| `10` | HELLO | protocollo u7 (1), modello u7 (2 = StopWatch), versione del programma (16) — ogni 2 s finché SOLCO non risponde |
| `11` | LREQ | richiesta u7, ordine u7 (0 ultimi aggiunti, 1 titolo, 2 artista, 3 BPM, 4 Camelot, 5 compatibili), compatibili u7, primo u14 (`3FFF` = intorno al brano caricato), quanti u7 (al più 40), genere (vuoto = tutti) |
| `12` | LOAD | forza u7 (1 = carica anche se il deck è in onda), id del brano |
| `13` | BROWSE | 1 = lista aperta (il disco scorre la lista, il brano resta fermo), 0 = chiusa |
| `14` | GREQ | chiede i generi |
| `15` | TREQ | chiede TRACK e WAVE (quando il n° brano di STATE è nuovo) |

Mentre la lista è aperta SOLCO tiene fermo l'angolo dato al motore e alla chiusura toglie il giro fatto: il brano non salta. Se il puck tace per 5 secondi SOLCO smette di mandargli lo stato; al ritorno il puck manda di nuovo HELLO.

## Il programma dello StopWatch

`solco_puck_sw.ino` fa la misura e il Bluetooth (come lo stick) sull'unità 1 del processore, lo schermo sull'unità 0. `ui.h` contiene schermate e logica (deck, lista, conferma) e disegna su una tela con l'alto verso il DJ, che a ogni fotogramma viene girata sullo schermo al contrario dei giri del disco (contro-rotazione, con la posizione prevista al momento in cui l'immagine arriva sullo schermo). `ui.h` compila anche sul computer: `tests/build_puck_sim.sh` e `/tmp/puck_ui_sim cartella` provano la logica (più di 20 controlli) e salvano le schermate (`schermate_stopwatch.png`).

## Compilazione

Li compila GitHub Actions a ogni modifica. A mano: core esp32 3.3.12, librerie M5Unified 0.3.0, M5GFX 0.3.0, NimBLE-Arduino 2.5.2, scheda *ESP32S3 Dev Module* con USB CDC all'avvio;
- stick: flash 8 MB, PSRAM disattivata (`esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=default_8MB,PSRAM=disabled`);
- StopWatch: flash 16 MB, partizioni «16M Flash (3MB APP/9.9MB FATFS)», PSRAM OPI (`esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi`).
