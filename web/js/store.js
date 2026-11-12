// ECHO Constellation - costellazioni, impostazioni, scaricamento dei dati e calcolo delle posizioni
/* global satellite */
import { DEG, RAD, RE, wrap180, jdFromMs, sunAt, sunAltitude, isSunlit } from './astro.js';

/** Stazioni abitate mostrate con icona dedicata (numero di catalogo NORAD). */
export const STATIONS = {
  25544: { short: 'ISS', name: 'Stazione spaziale internazionale', color: { dark: '#ffb13b', light: '#b85c00' } },
  48274: { short: 'Tiangong', name: 'Stazione spaziale cinese Tiangong', color: { dark: '#ff8a65', light: '#b8431c' } },
};

/**
 * Costellazioni selezionabili. `src` è il nome del gruppo su CelesTrak,
 * `big` segna le megacostellazioni (niente traiettorie né etichette).
 */
export const GROUPS = [
  { id: 'stations', chart: { light: '#eb6834', dark: '#d95926' }, src: 'stations', name: 'Stazioni spaziali', kind: 'Con equipaggio', owner: 'ISS e Tiangong', color: { dark: '#ffb13b', light: '#b85c00' }, size: 5, on: true, tracks: true },
  { id: 'starlink', chart: { light: '#6250d6', dark: '#9085e9' }, src: 'starlink', name: 'Starlink', kind: 'Internet', owner: 'SpaceX, USA', color: { dark: '#a99bff', light: '#5b4bc4' }, size: 1.25, big: true },
  { id: 'gps', chart: { light: '#2a78d6', dark: '#3987e5' }, src: 'gps-ops', name: 'GPS', kind: 'Navigazione', owner: 'Stati Uniti', color: { dark: '#4cc2ff', light: '#0067c0' }, size: 3, on: true, tracks: true },
  { id: 'glonass', chart: { light: '#e34948', dark: '#e66767' }, src: 'glo-ops', name: 'GLONASS', kind: 'Navigazione', owner: 'Russia', color: { dark: '#ff6b7a', light: '#c42b3c' }, size: 3, on: true, tracks: true },
  { id: 'galileo', chart: { light: '#eda100', dark: '#c98500' }, src: 'galileo', name: 'Galileo', kind: 'Navigazione', owner: 'Unione Europea', color: { dark: '#ffd84d', light: '#946c00' }, size: 3, on: true, tracks: true },
  { id: 'beidou', chart: { light: '#008300', dark: '#008300' }, src: 'beidou', name: 'BeiDou', kind: 'Navigazione', owner: 'Cina', color: { dark: '#5fe08b', light: '#0f7b38' }, size: 3 },
  { id: 'oneweb', chart: { light: '#1baf7a', dark: '#199e70' }, src: 'oneweb', name: 'OneWeb', kind: 'Internet', owner: 'Eutelsat, UE e UK', color: { dark: '#3dd6d0', light: '#00777d' }, size: 1.6, big: true },
  { id: 'kuiper', chart: { light: '#e87ba4', dark: '#d55181' }, src: 'kuiper', name: 'Amazon Leo (Kuiper)', kind: 'Internet', owner: 'Amazon, USA', color: { dark: '#ff9bd2', light: '#b0308a' }, size: 1.6, big: true },
  { id: 'iridium', chart: { light: '#898781', dark: '#898781' }, src: 'iridium-NEXT', name: 'Iridium NEXT', kind: 'Telefonia', owner: 'Stati Uniti', color: { dark: '#c9c9c9', light: '#5c5c5c' }, size: 2.4 },
];

// ---------- Impostazioni salvate nel browser ----------
const CHIAVE = 'echo-constellation.impostazioni';
const PREDEFINITE = {
  tema: 'system',
  casa: { nome: "Rive d'Arcano", lat: 46.127, lon: 13.03 },
  gruppi: {},
  lunghezzaTracce: 0.08,
  etichette: 'auto',
  notte: true,
  menuAperto: null,
};

function leggiImpostazioni() {
  let salvate = {};
  try { salvate = JSON.parse(localStorage.getItem(CHIAVE) || '{}') || {}; } catch (e) { /* archivio non disponibile */ }
  return { ...PREDEFINITE, ...salvate, casa: { ...PREDEFINITE.casa, ...(salvate.casa || {}) }, gruppi: { ...(salvate.gruppi || {}) } };
}
export const settings = leggiImpostazioni();

export function saveSettings() {
  settings.gruppi = {};
  for (const g of GROUPS) settings.gruppi[g.id] = { on: g.state.on, tracks: g.state.tracks };
  try { localStorage.setItem(CHIAVE, JSON.stringify(settings)); } catch (e) { /* archivio non disponibile */ }
}

for (const g of GROUPS) {
  const s = settings.gruppi[g.id] || {};
  g.state = {
    on: s.on ?? !!g.on,
    tracks: g.big ? false : (s.tracks ?? !!g.tracks),
    loaded: false, loading: false, error: null,
    sats: [], lon: null, lat: null, alt: null,
    fetchedAt: 0, stale: false, avgAlt: 0,
  };
}

export const themeColor = (o) => o.color[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];

// ---------- Scaricamento e lettura dei dati TLE ----------
const pausa = () => new Promise((r) => setTimeout(r));

/** Nome breve da mostrare sulla mappa (es. "PRN 13" per i GPS). */
function nomeBreve(nome) {
  const m = nome.match(/\(([^)]+)\)\s*$/);
  return (m ? m[1] : nome).trim();
}

/** Scarica un gruppo dal server locale e prepara i satelliti per il calcolo SGP4. */
export async function loadGroup(g) {
  const st = g.state;
  if (st.loading) return;
  st.loading = true; st.error = null;
  try {
    const risposta = await fetch(`api/gp?group=${encodeURIComponent(g.src)}`);
    if (!risposta.ok) throw new Error((await risposta.text()).trim() || `il server ha risposto ${risposta.status}`);
    st.fetchedAt = Number(risposta.headers.get('X-Echo-Scaricato') || 0) * 1000 || Date.now();
    st.stale = risposta.headers.get('X-Echo-Scaduto') === '1';
    const righe = (await risposta.text()).split(/[\r\n]+/);
    const sats = [];
    for (let i = 0; i < righe.length - 1; i++) {
      const l1 = righe[i], l2 = righe[i + 1];
      if (!(l1.startsWith('1 ') && l2.startsWith('2 ') && l1.length >= 68 && l2.length >= 68)) continue;
      const rec = satellite.twoline2satrec(l1, l2);
      if (!rec || rec.error) continue;
      const id = Number(rec.satnum);
      if (g.id === 'stations' && !STATIONS[id]) continue;   // solo ISS e Tiangong, non i singoli moduli
      const grezzo = i > 0 ? righe[i - 1].trim() : '';
      const nome = STATIONS[id] ? STATIONS[id].name : (grezzo || `NORAD ${id}`);
      sats.push({
        id, name: nome, short: STATIONS[id] ? STATIONS[id].short : nomeBreve(nome),
        lname: (nome + ' ' + grezzo).toLowerCase(), rec, periodMin: 2 * Math.PI / rec.no,
        group: g, idx: sats.length, trk: null,
      });
      i++;
      if (sats.length % 1500 === 0) await pausa();   // lascia respirare l'interfaccia
    }
    if (!sats.length) throw new Error('nessun satellite nei dati ricevuti');
    st.sats = sats;
    st.lon = new Float32Array(sats.length);
    st.lat = new Float32Array(sats.length).fill(NaN);
    st.alt = new Float32Array(sats.length);
    st.loaded = true;
    propagateAll(g, Date.now());
  } catch (errore) {
    st.error = errore.message || String(errore);
    throw errore;
  } finally {
    st.loading = false;
  }
}

// ---------- Calcolo delle posizioni ----------
/** Posizione e velocità inerziali (km, km/s) in un istante, oppure null se il calcolo fallisce. */
export function sgp4At(rec, ms) {
  const pv = satellite.sgp4(rec, (jdFromMs(ms) - rec.jdsatepoch) * 1440);
  return pv && pv.position ? pv : null;
}

/** Punto a terra sotto il satellite: { lon, lat, alt }. */
export function subpoint(rec, ms) {
  const pv = sgp4At(rec, ms);
  if (!pv) return null;
  const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(jdFromMs(ms)));
  return { lon: wrap180(gd.longitude * RAD), lat: gd.latitude * RAD, alt: gd.height };
}

function calcola(st, i, ms, gmst) {
  const pv = sgp4At(st.sats[i].rec, ms);
  if (!pv) { st.lat[i] = NaN; return; }
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  st.lon[i] = wrap180(gd.longitude * RAD);
  st.lat[i] = gd.latitude * RAD;
  st.alt[i] = gd.height;
}

function propagateAll(g, ms) {
  const st = g.state, gmst = satellite.gstime(jdFromMs(ms));
  let somma = 0, validi = 0;
  for (let i = 0; i < st.sats.length; i++) {
    calcola(st, i, ms, gmst);
    if (!Number.isNaN(st.lat[i])) { somma += st.alt[i]; validi++; }
  }
  st.avgAlt = validi ? somma / validi : 0;
}

let cursore = { id: null, i: 0 };
/**
 * Aggiorna le posizioni dei gruppi attivi a rotazione, senza superare `budget`
 * millisecondi per fotogramma: così anche 10.000 Starlink non bloccano la pagina.
 */
export function tick(ms, budget = 6) {
  const attivi = GROUPS.filter((g) => g.state.on && g.state.loaded);
  if (!attivi.length) return;
  const inizio = performance.now();
  const gmst = satellite.gstime(jdFromMs(ms));
  const totale = attivi.reduce((n, g) => n + g.state.sats.length, 0);
  let gi = Math.max(0, attivi.findIndex((g) => g.id === cursore.id));
  if (attivi[gi].id !== cursore.id) cursore.i = 0;
  let fatti = 0;
  while (fatti < totale) {
    const st = attivi[gi].state;
    const fine = Math.min(st.sats.length, cursore.i + 250);
    for (let i = cursore.i; i < fine; i++) calcola(st, i, ms, gmst);
    fatti += fine - cursore.i;
    cursore.i = fine;
    if (cursore.i >= st.sats.length) { gi = (gi + 1) % attivi.length; cursore.i = 0; }
    cursore.id = attivi[gi].id;
    if (performance.now() - inizio > budget) break;
  }
}

/** Stato completo e preciso di un satellite in un istante. */
export function satState(sat, ms) {
  const pv = sgp4At(sat.rec, ms);
  if (!pv) return null;
  const gmst = satellite.gstime(jdFromMs(ms));
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  const v = pv.velocity;
  return {
    lon: wrap180(gd.longitude * RAD), lat: gd.latitude * RAD, alt: gd.height,
    speed: Math.hypot(v.x, v.y, v.z), pos: pv.position, gmst,
  };
}

const osservatore = (casa) => ({ longitude: casa.lon * DEG, latitude: casa.lat * DEG, height: 0.15 });

/** Azimut, elevazione (gradi) e distanza (km) del satellite visto da casa. */
export function lookFrom(casa, stato) {
  const la = satellite.ecfToLookAngles(osservatore(casa), satellite.eciToEcf(stato.pos, stato.gmst));
  return { az: (la.azimuth * RAD + 360) % 360, el: la.elevation * RAD, range: la.rangeSat };
}

/** Parametri orbitali ricavati dagli elementi TLE. */
export function orbitInfo(sat) {
  const rec = sat.rec;
  const n = rec.no / 60;                       // moto medio in rad/s
  const a = Math.cbrt(398600.4418 / (n * n));  // semiasse maggiore, km
  return {
    incl: rec.inclo * RAD, ecc: rec.ecco, periodMin: sat.periodMin, revDay: 1440 / sat.periodMin,
    apogee: a * (1 + rec.ecco) - RE, perigee: a * (1 - rec.ecco) - RE,
    epochMs: (rec.jdsatepoch - 2440587.5) * 86400000,
  };
}

/**
 * Passaggi sopra casa nelle prossime `ore`: inizio, culmine e fine con elevazione
 * massima di almeno 10 gradi. `vis` dice se il passaggio è osservabile a occhio nudo.
 */
export function computePasses(sat, casa, daMs, ore = 72) {
  const oss = osservatore(casa);
  const passo = 20000;
  const elenco = [];
  let p = null;
  for (let t = daMs; t < daMs + ore * 3600000; t += passo) {
    const pv = sgp4At(sat.rec, t);
    if (!pv) continue;
    const la = satellite.ecfToLookAngles(oss, satellite.eciToEcf(pv.position, satellite.gstime(jdFromMs(t))));
    const el = la.elevation * RAD, az = (la.azimuth * RAD + 360) % 360;
    if (el > 0) {
      if (!p) p = { start: t, azStart: az, maxEl: -1 };
      if (el > p.maxEl) { p.maxEl = el; p.tMax = t; p.azMax = az; p.pos = pv.position; }
      p.end = t; p.azEnd = az;
    } else if (p) {
      if (p.maxEl >= 10) {
        const sole = sunAt(p.tMax);
        const illuminato = isSunlit(p.pos, sole);
        const buio = sunAltitude(casa.lat, casa.lon, sole) < -6;
        p.vis = illuminato && buio ? 'visibile' : (illuminato ? 'giorno' : 'ombra');
        delete p.pos;
        elenco.push(p);
      }
      p = null;
    }
  }
  return elenco;
}
