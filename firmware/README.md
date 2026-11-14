# SOLCO — programma della scheda (firmware)

Funziona con **CircuitPython 9 o 10** su **Raspberry Pi Pico H (RP2040)**. Non serve copiare librerie.

## Installazione (una volta sola, dal Galaxy Book)
1. Scarica da circuitpython.org il file `.uf2` per **Raspberry Pi Pico** (non "Pico 2").
2. Tieni premuto il pulsantino **BOOTSEL** del Pico e collegalo al computer con il cavo micro-USB: compare un'unità chiamata `RPI-RP2`.
3. Trascina il file `.uf2` dentro `RPI-RP2`. Il Pico si riavvia e compare l'unità `CIRCUITPY`.
4. Copia in `CIRCUITPY` i file `boot.py` e `code.py` di questa cartella (sostituisci il `code.py` che c'è già).
5. Scollega e ricollega il cavo. La scheda ora si presenta come **SOLCO Jog**.

Per aggiornare in futuro basta ricopiare `code.py` dentro `CIRCUITPY`.

## Cosa fa
- Pulsanti → note MIDI sul canale 1; con SHIFT premuto alcuni tasti mandano la seconda funzione.
- Jog magnetica (AS5600, 4096 posizioni per giro) → pitch bend sul canale 16.
- Tocco sul rame della jog → nota 64 (scratch in modalità vinile).
- Fader NeoSlider → pitch bend sul canale 15; i suoi led diventano verdi al centro.
- Manopola → CC 64 sul canale 1 (con SHIFT: brano precedente/successivo).

## Regolazioni
- **Jog al contrario:** tieni premuti SHIFT e ◀ JUMP mentre colleghi il cavo. Il led lampeggia 3 volte e la scelta resta in memoria.
- **Sensibilità del tocco:** in cima a `code.py` (`TOCCO_ON`, `TOCCO_OFF`). Valori più bassi = più sensibile.
- **Led del Pico:** fisso = tutto ok · lento = magnete da sistemare · veloce = sensore non trovato.

La prova su computer (`python3 tests/firmware_test.py`) simula pulsanti, jog, tocco e fader e controlla i messaggi MIDI.
