# SOLCO Puck (M5StickS3)

Programma per il puck del giradischi: il giroscopio dello stick misura quanto gira il disco e lo manda a SOLCO via Bluetooth MIDI (nome «SOLCO Puck XXXX»). Istruzioni d'uso nel README principale, sezione «Giradischi come controller».

## Protocollo (canale MIDI 13, control change)

| CC | Valore |
|---|---|
| 102, 103, 104 | giri al minuto × 4000 con segno, 21 bit (alto, medio, basso; spostati di 2^20). SOLCO applica il valore all'arrivo del 104. Inviati 100 volte al secondo (20 a disco fermo). |
| 105 | batteria in % (ogni secondo) |
| 106 | stato: bit0 calibrato, bit1 calibrazione in corso, bit2 in carica |

## Compilazione

Lo compila GitHub Actions a ogni modifica (`solco-puck.bin` nella versione pubblicata). A mano: core esp32 3.3.12, librerie M5Unified 0.3.0, M5GFX 0.3.0, NimBLE-Arduino 2.5.2, scheda *ESP32S3 Dev Module* con USB CDC all'avvio, flash 8 MB, PSRAM disattivata.
