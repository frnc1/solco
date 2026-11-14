# SOLCO — lettore per DJ su tablet

Un tablet Android diventa un lettore da collegare al mixer: forma d'onda, BPM e tonalità rilevati in automatico, cue, hot cue, loop, key lock, slip, reverse e scratch con una jog fisica.

## Installare l'app sul tablet

1. Dal tablet apri la pagina **Releases** di questo repository e scarica `solco.apk` dall'ultima versione.
2. Apri il file scaricato. La prima volta Android chiede di permettere l'installazione da Chrome (o dall'app File): conferma.
3. Avvia **SOLCO**, tocca **BRANI** → **+ IMPORTA** e scegli i brani salvati sul tablet (MP3, AIFF, WAV, FLAC, M4A). Vengono copiati nell'app e analizzati una volta sola.

Per aggiornare basta installare il nuovo `solco.apk` sopra quello vecchio: libreria, cue e impostazioni restano.

## Collegamenti

- **Audio:** adattatore USB-C → jack 3,5 mm, poi cavo jack → 2 RCA verso un ingresso del mixer.
- **Jog e comandi fisici:** controller USB MIDI. L'app riconosce da sola la jog SOLCO; altri controller si assegnano da *Impostazioni → Comandi*.

## Come è fatto

| Cartella | Contenuto |
|---|---|
| `web/` | L'app vera e propria (HTML, CSS, JavaScript). Motore audio in AudioWorklet (`js/worklet.js`), analisi dei brani in un Web Worker (`js/analysis.js`). |
| `android/` | Contenitore Android: WebView a schermo intero, comandi MIDI via USB, selettore dei file. |
| `tests/` | Test del motore audio e dell'analisi (`node tests/engine.test.js`, `node tests/analysis.test.js`). |
| `.github/workflows/apk.yml` | Ogni modifica sul ramo `main` compila un nuovo `solco.apk` e lo pubblica tra le Releases. |

La chiave di firma `android/solco.jks` serve solo a installare gli aggiornamenti sopra la versione precedente.

Carattere tipografico: Inter (SIL Open Font License, vedi `web/fonts/LICENSE-Inter.txt`).
