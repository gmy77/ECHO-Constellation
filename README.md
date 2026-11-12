# ECHO Constellation

Satelliti in tempo reale su una mappa piatta del mondo, in stile WinUI. Fa parte della famiglia ECHO.

**Online:** https://echo-constellation.gimmy077.workers.dev

- **Mappa in tempo reale**: planisfero con ombra della notte, punto subsolare, zoom e trascinamento
  (la mappa si ripete in orizzontale, quindi non ha bordi).
- **Costellazioni attivabili una per una**: ISS e Tiangong, Starlink, GPS, GLONASS, Galileo, BeiDou,
  OneWeb, Amazon Leo (Kuiper), Iridium NEXT. Ognuna ha le sue traiettorie tratteggiate animate.
- **Stazioni spaziali**: posizione, quota, velocità, luce o ombra, passaggi sopra casa nelle prossime 72 ore.
- **Grafici**: cielo sopra casa, satelliti di navigazione in vista nelle 24 ore, quote, istogramma per costellazione.
- **Impostazioni**: tema chiaro, scuro o di sistema, posizione di casa, lunghezza delle traiettorie.

Le posizioni sono calcolate nel browser con SGP4 a partire dagli elementi orbitali pubblici di CelesTrak:
non è telemetria ricevuta dai satelliti.

## Come è fatto

| Parte | Dove | Linguaggio |
|---|---|---|
| Pagina (mappa, grafici, interfaccia) | `web/` | HTML, CSS, JavaScript senza framework |
| Programma per Windows | `src/main.rs` | Rust (`tiny_http`, `ureq`) |
| Versione online | `worker/index.js`, `wrangler.toml` | Cloudflare Worker + KV |

La pagina chiede i dati sempre a `api/gp?group=…`. In locale risponde `ECHO Constellation.exe`, online
risponde il Worker. Tutti e due tengono una copia di ogni costellazione per due ore, perché CelesTrak
aggiorna i dati con quella cadenza e risponde 403 a chi li richiede più spesso. Se CelesTrak non risponde
viene servita l'ultima copia, con un avviso nella pagina.

## Programma per Windows

```bash
cargo build --release
```

L'exe (`target/release/echo-constellation.exe`) contiene la pagina al suo interno: basta avviarlo e si apre
il browser su http://localhost:8796/. La cache sta nella cartella `cache` accanto all'exe.
Per fermarlo si chiude la sua finestra. Se è già in esecuzione, un secondo avvio apre solo la pagina.

Opzioni: `--no-browser`, `--porta N`, `--cartella web` (serve i file dal disco, comodo mentre si modifica la pagina).

## Pubblicazione online

```bash
wrangler deploy
```

Carica la cartella `web/` e il Worker (`deploy.bat` fa la stessa cosa). Il push su GitHub da solo non aggiorna la pagina online.

## Fonti e ringraziamenti

- Dati orbitali: [CelesTrak](https://celestrak.org) (Dr. T.S. Kelso)
- Calcolo delle orbite: [satellite.js](https://github.com/shashwatak/satellite-js) (MIT)
- Cartografia: [Natural Earth](https://www.naturalearthdata.com) tramite world-atlas e topojson-client (ISC)
