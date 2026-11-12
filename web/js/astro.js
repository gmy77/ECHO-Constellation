// ECHO Constellation - funzioni astronomiche di base (Sole, angoli, ombra della Terra)
/* global satellite */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const RE = 6378.137; // raggio equatoriale terrestre, km

/** Riporta un angolo in gradi nell'intervallo [-180, 180). */
export const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;

/** Data giuliana a partire dai millisecondi Unix. */
export const jdFromMs = (ms) => ms / 86400000 + 2440587.5;

/**
 * Posizione del Sole (formule a bassa precisione dell'Astronomical Almanac,
 * errore di circa 0,01 gradi: più che sufficiente per terminatore ed eclissi).
 * Restituisce il versore in coordinate inerziali e il punto subsolare.
 */
export function sunAt(ms) {
  const jd = jdFromMs(ms);
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const x = Math.cos(lam);
  const y = Math.cos(eps) * Math.sin(lam);
  const z = Math.sin(eps) * Math.sin(lam);
  const ra = Math.atan2(y, x);
  const dec = Math.asin(z);
  return { x, y, z, lat: dec * RAD, lon: wrap180((ra - satellite.gstime(jd)) * RAD) };
}

/** Altezza del Sole sull'orizzonte (gradi) in un punto della Terra. */
export function sunAltitude(lat, lon, sun) {
  const s = Math.sin(lat * DEG) * Math.sin(sun.lat * DEG)
    + Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((lon - sun.lon) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, s))) * RAD;
}

/** Vero se un satellite (posizione inerziale in km) è illuminato dal Sole (ombra cilindrica). */
export function isSunlit(p, sun) {
  const d = p.x * sun.x + p.y * sun.y + p.z * sun.z;
  if (d >= 0) return true;
  const px = p.x - d * sun.x, py = p.y - d * sun.y, pz = p.z - d * sun.z;
  return px * px + py * py + pz * pz > RE * RE;
}

/** Distanza al suolo (km) fra due punti, formula dell'emisenoverso. */
export function groundDistance(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * DEG / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin((lon2 - lon1) * DEG / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}
