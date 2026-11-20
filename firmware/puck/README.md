# SOLCO Puck (M5StickS3)

Programma per il puck del giradischi: il giroscopio dello stick misura quanto gira il disco e lo manda a SOLCO via Bluetooth MIDI (nome «SOLCO Puck XXXX»). Istruzioni d'uso nel README principale, sezione «Giradischi come controller».

## Protocollo (canale MIDI 13)

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
| 106 | stato: bit0 calibrato, bit1 calibrazione in corso, bit2 in carica |

Con orario e angolo SOLCO fa seguire al brano la **posizione** del disco, come un DVS: un margine di pochi millesimi (adattato da solo ai ritardi del Bluetooth) assorbe l'arrivo irregolare dei pacchetti, tra un campione e l'altro la traiettoria è interpolata con le velocità misurate, e il punto dello scratch non scivola.

**Programma 1.0** (solo velocità): CC 102, 103, 104 = giri al minuto × 4000 con segno, 21 bit. SOLCO lo riconosce ancora e segue la velocità.

`tests/vc_sim.js` simula disco, puck e Bluetooth (pacchetti ogni 7,5, 15 e 30 ms, ritardi irregolari) e misura ritardo, scivolamento del punto dopo gli scratch e tremolio del tempo.

## Compilazione

Lo compila GitHub Actions a ogni modifica (`solco-puck.bin` nella versione pubblicata). A mano: core esp32 3.3.12, librerie M5Unified 0.3.0, M5GFX 0.3.0, NimBLE-Arduino 2.5.2, scheda *ESP32S3 Dev Module* con USB CDC all'avvio, flash 8 MB, PSRAM disattivata.
