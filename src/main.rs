//! ECHO Constellation - server locale della dashboard satelliti.
//!
//! Serve la pagina (incorporata nell'exe) e fa da cache per i dati orbitali di
//! CelesTrak: ogni costellazione viene scaricata al massimo una volta ogni due
//! ore, perché CelesTrak aggiorna i dati con quella cadenza e rifiuta (403) chi
//! li richiede più spesso. Se CelesTrak non risponde si usa l'ultima copia.
//!
//! Uso: ECHO Constellation.exe [--no-browser] [--porta 8796] [--cartella <dir>]
//!   --cartella  serve i file dal disco invece che dall'exe (utile durante lo sviluppo)

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tiny_http::{Header, Method, Request, Response, Server};

const PORTA: u16 = 8796;
const DURATA_CACHE: Duration = Duration::from_secs(2 * 3600);

/// Gruppi CelesTrak ammessi: il server non fa da proxy generico.
const GRUPPI: [&str; 9] = [
    "stations", "starlink", "gps-ops", "glo-ops", "galileo", "beidou", "oneweb", "kuiper", "iridium-NEXT",
];

struct Risorsa {
    percorso: &'static str,
    tipo: &'static str,
    dati: &'static [u8],
}

macro_rules! risorsa {
    ($percorso:literal, $tipo:literal) => {
        Risorsa { percorso: $percorso, tipo: $tipo, dati: include_bytes!(concat!("../web/", $percorso)) }
    };
}

/// File della pagina, incorporati nell'exe al momento della compilazione.
static RISORSE: &[Risorsa] = &[
    risorsa!("index.html", "text/html; charset=utf-8"),
    risorsa!("css/fluent.css", "text/css; charset=utf-8"),
    risorsa!("js/app.js", "text/javascript; charset=utf-8"),
    risorsa!("js/astro.js", "text/javascript; charset=utf-8"),
    risorsa!("js/charts.js", "text/javascript; charset=utf-8"),
    risorsa!("js/map.js", "text/javascript; charset=utf-8"),
    risorsa!("js/store.js", "text/javascript; charset=utf-8"),
    risorsa!("vendor/satellite.min.js", "text/javascript; charset=utf-8"),
    risorsa!("vendor/topojson-client.min.js", "text/javascript; charset=utf-8"),
    risorsa!("vendor/countries-50m.json", "application/json"),
];

struct Stato {
    cache: PathBuf,
    cartella: Option<PathBuf>,
    /// Un solo scaricamento alla volta: evita doppie richieste a CelesTrak.
    scaricamento: Mutex<()>,
}

fn intestazione(nome: &str, valore: &str) -> Header {
    Header::from_bytes(nome.as_bytes(), valore.as_bytes()).expect("intestazione valida")
}

fn secondi(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Vero se il testo contiene almeno una coppia di righe TLE.
fn tle_valido(testo: &str) -> bool {
    testo.lines().any(|r| r.starts_with("1 ")) && testo.lines().any(|r| r.starts_with("2 "))
}

fn scarica(gruppo: &str) -> Result<String, String> {
    let url = format!("https://celestrak.org/NORAD/elements/gp.php?GROUP={gruppo}&FORMAT=tle");
    let risposta = ureq::get(&url)
        .set("User-Agent", "echo-constellation/1.0")
        .timeout(Duration::from_secs(40))
        .call();
    match risposta {
        Ok(r) => {
            let testo = r.into_string().map_err(|e| format!("CelesTrak non raggiungibile ({e})"))?;
            if tle_valido(&testo) {
                Ok(testo)
            } else {
                Err("CelesTrak ha risposto senza dati orbitali".into())
            }
        }
        // CelesTrak rifiuta un secondo scaricamento finché i dati non cambiano
        Err(ureq::Error::Status(403, _)) => Err("CelesTrak permette un solo scaricamento ogni due ore per \
             costellazione e questa è già stata scaricata di recente. Riprova più tardi"
            .into()),
        Err(e) => Err(format!("CelesTrak non raggiungibile ({e})")),
    }
}

/// Restituisce (testo, istante dello scaricamento, copia scaduta) per un gruppo.
fn leggi_gruppo(stato: &Stato, gruppo: &str) -> Result<(String, u64, bool), String> {
    let _guardia = stato.scaricamento.lock().unwrap_or_else(|e| e.into_inner());
    let file = stato.cache.join(format!("{gruppo}.tle"));
    let salvato = fs::metadata(&file).and_then(|m| m.modified()).ok();
    if let Some(quando) = salvato {
        let eta = SystemTime::now().duration_since(quando).unwrap_or_default();
        if eta < DURATA_CACHE {
            if let Ok(testo) = fs::read_to_string(&file) {
                return Ok((testo, secondi(quando), false));
            }
        }
    }
    match scarica(gruppo) {
        Ok(testo) => {
            let _ = fs::create_dir_all(&stato.cache);
            if let Err(e) = fs::write(&file, &testo) {
                eprintln!("[cache] {gruppo}: non riesco a salvare la copia ({e})");
            }
            println!("[celestrak] {gruppo}: scaricati {} satelliti", testo.lines().filter(|r| r.starts_with("1 ")).count());
            Ok((testo, secondi(SystemTime::now()), false))
        }
        Err(motivo) => {
            println!("[celestrak] {gruppo}: {motivo}");
            // meglio dati vecchi che niente
            match (salvato, fs::read_to_string(&file)) {
                (Some(quando), Ok(testo)) => Ok((testo, secondi(quando), true)),
                _ => Err(motivo),
            }
        }
    }
}

fn rispondi(richiesta: Request, codice: u16, tipo: &str, corpo: Vec<u8>, extra: Vec<Header>) {
    let mut risposta = Response::from_data(corpo)
        .with_status_code(codice)
        .with_header(intestazione("Content-Type", tipo))
        .with_header(intestazione("Cache-Control", "no-cache"));
    for h in extra {
        risposta.add_header(h);
    }
    let _ = richiesta.respond(risposta);
}

fn testo(richiesta: Request, codice: u16, messaggio: &str) {
    rispondi(richiesta, codice, "text/plain; charset=utf-8", messaggio.as_bytes().to_vec(), vec![]);
}

fn gestisci(richiesta: Request, stato: &Stato) {
    if *richiesta.method() != Method::Get {
        return testo(richiesta, 405, "Metodo non ammesso");
    }
    let url = richiesta.url().to_string();
    let (percorso, query) = url.split_once('?').unwrap_or((url.as_str(), ""));

    if percorso == "/api/gp" {
        let gruppo = query.split('&').find_map(|c| c.strip_prefix("group=")).unwrap_or("");
        if !GRUPPI.contains(&gruppo) {
            return testo(richiesta, 400, "Gruppo sconosciuto");
        }
        return match leggi_gruppo(stato, gruppo) {
            Ok((dati, scaricato, scaduto)) => rispondi(
                richiesta,
                200,
                "text/plain; charset=utf-8",
                dati.into_bytes(),
                vec![
                    intestazione("X-Echo-Scaricato", &scaricato.to_string()),
                    intestazione("X-Echo-Scaduto", if scaduto { "1" } else { "0" }),
                ],
            ),
            Err(motivo) => testo(richiesta, 502, &motivo),
        };
    }

    // File statici: solo quelli dell'elenco, così non si può uscire dalla cartella
    let nome = if percorso == "/" { "index.html" } else { percorso.trim_start_matches('/') };
    let Some(risorsa) = RISORSE.iter().find(|r| r.percorso == nome) else {
        return testo(richiesta, 404, "Non trovato");
    };
    let dati = match &stato.cartella {
        Some(cartella) => fs::read(cartella.join(risorsa.percorso)).unwrap_or_else(|_| risorsa.dati.to_vec()),
        None => risorsa.dati.to_vec(),
    };
    rispondi(richiesta, 200, risorsa.tipo, dati, vec![]);
}

fn apri_browser(indirizzo: &str) {
    #[cfg(windows)]
    let esito = Command::new("cmd").args(["/C", "start", "", indirizzo]).spawn();
    #[cfg(not(windows))]
    let esito = Command::new("xdg-open").arg(indirizzo).spawn();
    if let Err(e) = esito {
        eprintln!("Non riesco ad aprire il browser ({e}): apri a mano {indirizzo}");
    }
}

fn main() {
    let mut porta = PORTA;
    let mut apri = true;
    let mut cartella = None;
    let mut argomenti = std::env::args().skip(1);
    while let Some(a) = argomenti.next() {
        match a.as_str() {
            "--no-browser" => apri = false,
            "--porta" => porta = argomenti.next().and_then(|v| v.parse().ok()).unwrap_or(PORTA),
            "--cartella" => cartella = argomenti.next().map(PathBuf::from),
            _ => {
                eprintln!("Uso: ECHO Constellation [--no-browser] [--porta {PORTA}] [--cartella <dir>]");
                return;
            }
        }
    }

    let indirizzo = format!("http://localhost:{porta}/");
    let server = match Server::http(("127.0.0.1", porta)) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            // quasi sempre vuol dire che ECHO Constellation è già in esecuzione: basta aprire la pagina
            println!("Porta {porta} occupata ({e}): apro la pagina già attiva.");
            if apri {
                apri_browser(&indirizzo);
            }
            return;
        }
    };

    let cache = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("cache")))
        .unwrap_or_else(|| PathBuf::from("cache"));
    let stato = Arc::new(Stato { cache, cartella, scaricamento: Mutex::new(()) });

    println!("ECHO Constellation {} in ascolto su {indirizzo}", env!("CARGO_PKG_VERSION"));
    println!("Chiudi questa finestra per fermare il programma.");
    if apri {
        apri_browser(&indirizzo);
    }

    let fili: Vec<_> = (0..4)
        .map(|_| {
            let (server, stato) = (Arc::clone(&server), Arc::clone(&stato));
            thread::spawn(move || {
                while let Ok(richiesta) = server.recv() {
                    gestisci(richiesta, &stato);
                }
            })
        })
        .collect();
    for filo in fili {
        let _ = filo.join();
    }
}
