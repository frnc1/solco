# SOLCO — lettore per DJ su tablet

Un tablet Android diventa un lettore da collegare al mixer: forma d'onda, BPM e tonalità rilevati in automatico, cue, hot cue, loop, key lock, slip, reverse e scratch con la jog sullo schermo o con una jog fisica.

## Installare l'app sul tablet

1. Dal tablet apri la pagina **Releases** di questo repository e scarica `solco.apk` dall'ultima versione.
2. Apri il file scaricato. La prima volta Android chiede di permettere l'installazione da Chrome (o dall'app File): conferma.
3. Avvia **SOLCO**, tocca **BRANI** → **+ IMPORTA** e scegli i brani salvati sul tablet (MP3, AIFF, WAV, FLAC, M4A). Vengono copiati nell'app e analizzati una volta sola.

Per aggiornare basta installare il nuovo `solco.apk` sopra quello vecchio: libreria, cue e impostazioni restano.

## Lista dei brani

- **Ordine**: RECENTI, TITOLO, ARTISTA, BPM oppure **CAMELOT** (1A, 1B, 2A… e, a pari chiave, per BPM).
- **GENERE**: mostra solo i brani di un genere, preso dai tag del file. FLAC, AIFF, MP3 e M4A possono averlo; i WAV di solito no. Dentro il genere puoi ordinare per BPM o CAMELOT.
- **COMPATIBILI**: solo i brani entro il 6% di BPM da quello caricato e in chiave compatibile (stesso numero, oppure numero accanto con la stessa lettera).

## Comandi a schermo

Senza la jog fisica collegata l'app mostra tutti i comandi sullo schermo. In **verticale** (di serie) la disposizione è quella di un lettore da club: schermo sopra, hot cue e loop, jog al centro, fader del tempo a destra, CUE e PLAY in basso a sinistra.

- **Jog**: il bordo accelera o frena il brano in onda (in pausa sposta il punto e lo fa sentire). In modo **VINILE**, toccando il centro fermi il brano sotto il dito e girando fai scratch; un giro vale 1,8 s di brano, come un 33 giri. I tasti ◀ ▶ accanto alla jog spingono a velocità costante.
- **Fader del tempo**: si sposta solo trascinandolo, mai di colpo nel punto toccato (− in alto, + in basso). **TEMPO 0** va tenuto premuto. Cambiando il range (±6…50%) il tempo resta lo stesso.
- **Orientamento**: bloccato, così il tablet non gira da solo durante la serata. Si cambia da *Impostazioni → Schermo → Orientamento* (verticale, orizzontale o automatico).

## Versione per Windows (Galaxy Book e altri PC touch)

La stessa app gira anche su Windows, in una finestra a schermo intero: comoda su un portatile touch come il Galaxy Book 360, meglio se piegato a tablet e appoggiato sul tavolo.

- **Installazione**: dalla pagina *Releases* scarica **SOLCO-Setup.exe** e aprilo. Se compare «Windows ha protetto il PC», tocca «Ulteriori informazioni» e poi «Esegui comunque». Si crea l'icona SOLCO sul desktop.
- **Schermo intero**: parte già a schermo intero; F11 o il tasto ⛶ in alto lo attivano e disattivano.
- **Audio**: esce dall'uscita predefinita di Windows (jack delle cuffie o scheda audio USB).
- **Brani e jog fisica**: si importano come sul tablet; la jog SOLCO via USB viene riconosciuta da sola.

## Collegamenti

- **Solo comandi a schermo**: basta un cavo **USB-C → RCA con DAC integrato** (i tablet Samsung recenti non hanno il jack e con un cavo senza DAC non esce suono). Il cavo occupa l'unica presa del tablet, quindi durante il set non si ricarica.
- **Con la jog fisica**: **hub USB-C** nel tablet, e nell'hub: la jog SOLCO, una scheda audio USB (es. Behringer UCA222) e il caricatore.
- **Audio:** uscita RCA della scheda audio → ingresso CD/LINE di un canale del mixer.
- **Jog e comandi fisici:** l'app riconosce da sola la jog SOLCO; altri controller MIDI si assegnano da *Impostazioni → Comandi* (ASSEGNA, poi muovi il comando). I fader del tempo a 14 bit su due CC vengono riconosciuti da soli. Se la jog del controller manda il bordo su un CC a parte, assegna anche «Jog (bordo)». Con un controller che ha solo jog e fader, metti *Impostazioni → Schermo → Comandi a schermo* su **SEMPRE** per tenere CUE, PLAY e gli altri tasti sullo schermo.

## Jog, pulsanti e supporto da stampare

Tutto in `hardware/`: lista della spesa senza saldature, piatti `.3mf` pronti per la stampante, montaggio e schema dei collegamenti (`hardware/README.md`). Il programma della scheda è in `firmware/`.

## Come è fatto

| Cartella | Contenuto |
|---|---|
| `web/` | L'app vera e propria (HTML, CSS, JavaScript). Motore audio in AudioWorklet (`js/worklet.js`), analisi dei brani in un Web Worker (`js/analysis.js`). |
| `android/` | Contenitore Android: WebView a schermo intero, comandi MIDI via USB, selettore dei file. |
| `tests/` | Test del motore audio e dell'analisi (`node tests/engine.test.js`, `node tests/analysis.test.js`), del firmware (`python3 tests/firmware_test.py`) e dell'interfaccia in Chrome headless: jog a schermo (`python3 tests/ui_jog_test.py`), filtro per genere (`python3 tests/ui_genre_test.py`), assegnazione di controller MIDI qualsiasi (`python3 tests/ui_midi_learn_test.py`). |
| `hardware/` | Pezzi da stampare (`stampa/`), anteprime, generatore dei modelli (`cad/`). |
| `firmware/` | Programma CircuitPython per il Pico H della jog. |
| `.github/workflows/apk.yml` | Ogni modifica sul ramo `main` compila un nuovo `solco.apk` e lo pubblica tra le Releases. |

La chiave di firma `android/solco.jks` serve solo a installare gli aggiornamenti sopra la versione precedente.

Carattere tipografico: Inter (SIL Open Font License, vedi `web/fonts/LICENSE-Inter.txt`).
