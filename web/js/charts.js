// ECHO Constellation - grafici (disegnati su canvas, senza librerie esterne).
// Ogni grafico ha una legenda, un riquadro al passaggio del puntatore e una vista a tabella.
/* global satellite */
import { GROUPS, settings, sgp4At, subpoint } from './store.js';
import { DEG, RAD, RE, jdFromMs, sunAt, isSunlit } from './astro.js';

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const nf0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ora = (ms) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const giornoOra = (ms) => new Date(ms).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const bussola = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(az / 45) % 8];
const pausa = () => new Promise((r) => setTimeout(r));
const tema = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const colore = (g) => g.chart[tema()];
const attivi = () => GROUPS.filter((g) => g.state.on && g.state.loaded);

/** Colori del "telaio" dei grafici: testo dai token dell'interfaccia, griglia a un passo dalla superficie. */
function tok() {
  const cs = getComputedStyle(document.documentElement), chiaro = tema() === 'light';
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    text: v('--text'), text2: v('--text-2'), text3: v('--text-3'),
    grid: chiaro ? '#e6e6e6' : '#3a3a3a', axis: chiaro ? '#c2c2c2' : '#565656',
    surface: chiaro ? '#fbfbfb' : '#2b2b2b', band: chiaro ? 'rgba(0,0,0,0.055)' : 'rgba(255,255,255,0.06)',
  };
}

function prep(canvas) {
  const r = canvas.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}

function passoTondo(grezzo) {
  const p = 10 ** Math.floor(Math.log10(Math.max(grezzo, 1e-9)));
  const f = grezzo / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// ---------- riquadro informativo (il testo entra sempre come textContent) ----------
const tipEl = $('tooltip');
function tip(cx, cy, titolo, righe) {
  tipEl.replaceChildren();
  const b = document.createElement('b'); b.textContent = titolo; tipEl.append(b);
  for (const r of righe) {
    const d = document.createElement('div'); d.className = 'tip-row';
    if (r.c) { const k = document.createElement('span'); k.className = 'tip-key'; k.style.background = r.c; d.append(k); }
    const val = document.createElement('strong'); val.textContent = r.v; d.append(val);
    if (r.n) { const n = document.createElement('span'); n.textContent = r.n; d.append(n); }
    tipEl.append(d);
  }
  tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.max(8, Math.min(cx + 14, innerWidth - r.width - 8))}px`;
  tipEl.style.top = `${Math.max(8, Math.min(cy + 16, innerHeight - r.height - 8))}px`;
}
const untip = () => { tipEl.hidden = true; };

function suPuntatore(canvas, muovi, esci) {
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    muovi(e.clientX - r.left, e.clientY - r.top, e);
  });
  canvas.addEventListener('pointerleave', () => { esci(); untip(); });
}

function tabella(box, testa, righe, nota) {
  const t = document.createElement('table'); t.className = 'table';
  const th = t.createTHead().insertRow();
  for (const c of testa) { const el = document.createElement('th'); el.textContent = c; th.append(el); }
  const corpo = t.createTBody();
  for (const riga of righe) { const tr = corpo.insertRow(); for (const c of riga) tr.insertCell().textContent = c; }
  box.replaceChildren(t);
  if (nota) { const p = document.createElement('div'); p.className = 'empty'; p.textContent = nota; box.append(p); }
}

function legenda(box, voci) {
  box.replaceChildren(...voci.map((v) => {
    const el = document.createElement('span'); el.className = 'legend-item';
    const k = document.createElement('span'); k.className = v.linea ? 'legend-line' : 'legend-dot'; k.style.background = v.c;
    const n = document.createElement('span'); n.textContent = v.n;
    el.append(k, n);
    if (v.v !== undefined) { const s = document.createElement('strong'); s.textContent = v.v; el.append(s); }
    return el;
  }));
}

// ---------- grafico a linee generico ----------
/**
 * cfg: { t0, step, n, series:[{name,color,values}], lo, hi, hover, bands:[[i0,i1]], tick }
 * Restituisce la funzione che converte l'ascissa del puntatore nell'indice del campione.
 */
function linee(canvas, cfg) {
  const c = prep(canvas);
  if (!c) return null;
  const { ctx, w, h } = c, t = tok();
  const piu = cfg.series.length > 1;
  const m = { l: 44, r: piu ? 96 : 18, t: 12, b: 26 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const passo = passoTondo((cfg.hi - cfg.lo) / 4);
  const lo = Math.floor(cfg.lo / passo) * passo, hi = Math.max(lo + passo, Math.ceil(cfg.hi / passo) * passo);
  const X = (i) => m.l + pw * i / (cfg.n - 1), Y = (val) => m.t + ph * (1 - (val - lo) / (hi - lo));

  if (cfg.bands) { ctx.fillStyle = t.band; for (const [a, b] of cfg.bands) ctx.fillRect(X(a), m.t, X(b) - X(a), ph); }

  ctx.font = `11px ${FONT}`; ctx.lineWidth = 1; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (let val = lo; val <= hi + passo / 2; val += passo) {
    const y = Math.round(Y(val)) + 0.5;
    ctx.strokeStyle = val === lo ? t.axis : t.grid;
    ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
    ctx.fillStyle = t.text3; ctx.fillText(nf0.format(val), m.l - 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const fine = cfg.t0 + (cfg.n - 1) * cfg.step;
  for (let tt = Math.ceil(cfg.t0 / cfg.tick) * cfg.tick; tt <= fine; tt += cfg.tick) {
    const x = Math.round(X((tt - cfg.t0) / cfg.step)) + 0.5;
    ctx.strokeStyle = t.axis; ctx.beginPath(); ctx.moveTo(x, m.t + ph); ctx.lineTo(x, m.t + ph + 4); ctx.stroke();
    ctx.fillStyle = t.text3; ctx.fillText(ora(tt), x, m.t + ph + 8);
  }

  ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const s of cfg.series) {
    ctx.strokeStyle = s.color; ctx.beginPath();
    for (let i = 0; i < cfg.n; i++) { if (i) ctx.lineTo(X(i), Y(s.values[i])); else ctx.moveTo(X(i), Y(s.values[i])); }
    ctx.stroke();
  }

  const punto = (x, y, col) => {
    ctx.fillStyle = t.surface; ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
  };
  if (piu) {   // etichette a fine linea, distanziate e collegate da un filo se spostate
    const xe = X(cfg.n - 1);
    const et = cfg.series.map((s) => ({ s, y: Y(s.values[cfg.n - 1]) })).sort((a, b) => a.y - b.y);
    et.forEach((e, i) => { e.ly = i ? Math.max(e.y, et[i - 1].ly + 15) : e.y; });
    for (let i = et.length - 1, max = m.t + ph - 4; i >= 0; i--) { et[i].ly = Math.min(et[i].ly, max); max = et[i].ly - 15; }
    ctx.font = `12px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const e of et) {
      if (Math.abs(e.ly - e.y) > 3) { ctx.strokeStyle = t.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xe + 6, e.y); ctx.lineTo(xe + 11, e.ly); ctx.stroke(); }
      punto(xe, e.y, e.s.color);
      ctx.fillStyle = t.text2; ctx.fillText(e.s.name, xe + 13, e.ly);
    }
  }
  if (cfg.hover >= 0 && cfg.hover < cfg.n) {
    const x = Math.round(X(cfg.hover)) + 0.5;
    ctx.strokeStyle = t.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, m.t + ph); ctx.stroke();
    for (const s of cfg.series) punto(X(cfg.hover), Y(s.values[cfg.hover]), s.color);
  }
  return (px) => Math.max(0, Math.min(cfg.n - 1, Math.round((px - m.l) / pw * (cfg.n - 1))));
}

// ---------- 1. cielo sopra casa ----------
const cielo = { punti: [], hover: null };

/** Satelliti delle costellazioni attive che in questo momento sono sopra l'orizzonte di casa. */
function sopraOrizzonte() {
  const casa = settings.casa;
  const oss = { longitude: casa.lon * DEG, latitude: casa.lat * DEG, height: 0.15 };
  const sinC = Math.sin(casa.lat * DEG), cosC = Math.cos(casa.lat * DEG);
  const out = [];
  for (const g of attivi()) {
    const st = g.state;
    for (let i = 0; i < st.sats.length; i++) {
      const lat = st.lat[i];
      if (lat !== lat) continue;
      // filtro rapido: il satellite è oltre l'orizzonte geometrico?
      const cosd = sinC * Math.sin(lat * DEG) + cosC * Math.cos(lat * DEG) * Math.cos((st.lon[i] - casa.lon) * DEG);
      if (cosd < RE / (RE + st.alt[i])) continue;
      const ecf = satellite.geodeticToEcf({ longitude: st.lon[i] * DEG, latitude: lat * DEG, height: st.alt[i] });
      const la = satellite.ecfToLookAngles(oss, ecf);
      if (la.elevation > 0) out.push({ sat: st.sats[i], g, el: la.elevation * RAD, az: (la.azimuth * RAD + 360) % 360 });
    }
  }
  return out;
}

function disegnaCielo() {
  const elenco = sopraOrizzonte();
  cielo.elenco = elenco;
  const perGruppo = new Map();
  for (const p of elenco) perGruppo.set(p.g, (perGruppo.get(p.g) || 0) + 1);
  legenda($('skyLegend'), attivi().map((g) => ({ c: colore(g), n: g.name, v: nf0.format(perGruppo.get(g) || 0) })));
  $('skyTitle').textContent = `Il cielo sopra ${settings.casa.nome}, adesso`;

  const c = prep($('chSky'));
  if (!c) return;
  const { ctx, w, h } = c, t = tok();
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 24;
  ctx.lineWidth = 1;
  for (const el of [60, 30, 0]) {
    ctx.strokeStyle = el === 0 ? t.axis : t.grid;
    ctx.beginPath(); ctx.arc(cx, cy, R * (90 - el) / 90, 0, TAU); ctx.stroke();
  }
  ctx.strokeStyle = t.grid;
  ctx.beginPath(); ctx.moveTo(cx - R, cy + 0.5); ctx.lineTo(cx + R, cy + 0.5); ctx.moveTo(cx + 0.5, cy - R); ctx.lineTo(cx + 0.5, cy + R); ctx.stroke();
  ctx.font = `600 12px ${FONT}`; ctx.fillStyle = t.text2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - R - 12); ctx.fillText('S', cx, cy + R + 12);
  ctx.fillText('E', cx + R + 12, cy); ctx.fillText('O', cx - R - 12, cy);
  ctx.font = `10px ${FONT}`; ctx.fillStyle = t.text3; ctx.textAlign = 'left';
  ctx.fillText('60°', cx + 4, cy - R / 3 - 7); ctx.fillText('30°', cx + 4, cy - R * 2 / 3 - 7);

  const raggio = (g) => (g.id === 'stations' ? 6 : g.big ? 3 : 4.5);
  const ordine = (g) => (g.id === 'stations' ? 2 : g.big ? 0 : 1);
  cielo.punti = elenco.map((p) => {
    const r = R * (90 - p.el) / 90;
    return { ...p, x: cx + r * Math.sin(p.az * DEG), y: cy - r * Math.cos(p.az * DEG) };
  }).sort((a, b) => ordine(a.g) - ordine(b.g));
  for (const p of cielo.punti) {
    const r = raggio(p.g);
    ctx.fillStyle = t.surface; ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, TAU); ctx.fill();   // anello di superficie
    ctx.fillStyle = colore(p.g); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
  }
  const hv = cielo.hover && cielo.punti.find((p) => p.sat === cielo.hover);
  if (hv) { ctx.strokeStyle = t.text; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(hv.x, hv.y, raggio(hv.g) + 4, 0, TAU); ctx.stroke(); }
}

function tabellaCielo() {
  const righe = [...(cielo.elenco || [])].sort((a, b) => b.el - a.el);
  tabella($('skyTable'), ['Satellite', 'Costellazione', 'Elevazione', 'Direzione'],
    righe.slice(0, 80).map((p) => [p.sat.name, p.g.name, `${nf0.format(p.el)}°`, `${bussola(p.az)} (${nf0.format(p.az)}°)`]),
    righe.length > 80 ? `Mostrati gli 80 più alti su ${nf0.format(righe.length)}.` : (righe.length ? '' : 'Nessun satellite sopra l\'orizzonte fra le costellazioni attive.'));
}

// ---------- 2. satelliti di navigazione visibili nelle prossime 24 ore ----------
const NAV = ['gps', 'galileo', 'beidou', 'glonass'];   // ordine fisso: mantiene distinguibili i colori vicini
const nav = { dati: null, chiave: '', at: 0, occupato: false, hover: -1, indice: null };

async function calcolaNav() {
  const gruppi = NAV.map((id) => GROUPS.find((g) => g.id === id)).filter((g) => g.state.on && g.state.loaded);
  const chiave = `${gruppi.map((g) => g.id).join()}|${settings.casa.lat},${settings.casa.lon}`;
  if (nav.occupato || (nav.dati && nav.chiave === chiave && Date.now() - nav.at < 600000)) return;
  nav.occupato = true;
  const passo = 600000, n = 145, t0 = Math.floor(Date.now() / passo) * passo;
  const oss = { longitude: settings.casa.lon * DEG, latitude: settings.casa.lat * DEG, height: 0.15 };
  const gmst = Array.from({ length: n }, (_, k) => satellite.gstime(jdFromMs(t0 + k * passo)));
  const serie = [];
  for (const g of gruppi) {
    const valori = new Uint8Array(n);
    for (const sat of g.state.sats) {
      for (let k = 0; k < n; k++) {
        const pv = sgp4At(sat.rec, t0 + k * passo);
        if (pv && satellite.ecfToLookAngles(oss, satellite.eciToEcf(pv.position, gmst[k])).elevation * RAD >= 10) valori[k]++;
      }
    }
    serie.push({ g, valori });
    await pausa();
  }
  nav.dati = { t0, passo, n, serie }; nav.chiave = chiave; nav.at = Date.now(); nav.occupato = false;
  disegnaNav();
}

function disegnaNav() {
  const d = nav.dati, vuoto = $('navEmpty'), tela = $('chNav');
  const nessuna = !d || !d.serie.length;
  vuoto.hidden = !nessuna; tela.hidden = nessuna; $('navLegend').hidden = nessuna;
  if (nessuna) { vuoto.textContent = nav.occupato ? 'Calcolo in corso…' : 'Attiva sulla mappa almeno una costellazione di navigazione (GPS, Galileo, BeiDou o GLONASS).'; return; }
  const series = d.serie.map((s) => ({ name: s.g.name, color: colore(s.g), values: s.valori }));
  legenda($('navLegend'), series.map((s) => ({ c: s.color, n: s.name, linea: true })));
  const max = Math.max(4, ...series.map((s) => Math.max(...s.values)));
  nav.indice = linee(tela, { t0: d.t0, step: d.passo, n: d.n, series, lo: 0, hi: max, hover: nav.hover, tick: 3 * 3600000 });
}

function tabellaNav() {
  const d = nav.dati;
  if (!d || !d.serie.length) { tabella($('navTable'), ['Ora'], [], 'Nessuna costellazione di navigazione attiva.'); return; }
  const righe = [];
  for (let k = 0; k < d.n; k += 6) righe.push([giornoOra(d.t0 + k * d.passo), ...d.serie.map((s) => String(s.valori[k]))]);
  tabella($('navTable'), ['Ora', ...d.serie.map((s) => s.g.name)], righe);
}

// ---------- 3. quote delle costellazioni (un rigo per costellazione, scala logaritmica) ----------
const QMIN = 300, QMAX = 40000, QTICK = [300, 500, 1000, 2000, 5000, 10000, 20000, 36000];
const quote = { righe: [], hover: -1 };

function statistiche(g) {
  const st = g.state, v = [];
  for (let i = 0; i < st.sats.length; i++) if (st.lat[i] === st.lat[i]) v.push(st.alt[i]);
  v.sort((a, b) => a - b);
  return { g, v, n: v.length, min: v[0], med: v[Math.floor(v.length / 2)], max: v[v.length - 1] };
}

function disegnaQuote() {
  const righe = quote.righe = attivi().map(statistiche).filter((s) => s.n);
  const tela = $('chAlt');
  tela.style.height = `${Math.max(1, righe.length) * 32 + 34}px`;
  const c = prep(tela);
  if (!c) return;
  const { ctx, w } = c, t = tok();
  const stretto = w < 520;
  const m = { l: stretto ? 104 : 168, r: stretto ? 12 : 92, t: 4, b: 30 };
  const pw = w - m.l - m.r, ph = righe.length * 32;
  const X = (q) => m.l + pw * (Math.log(Math.max(QMIN, Math.min(QMAX, q)) / QMIN) / Math.log(QMAX / QMIN));
  quote.geo = { m, alt: 32 };
  ctx.font = `11px ${FONT}`; ctx.lineWidth = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  QTICK.forEach((q, i) => {
    const x = Math.round(X(q)) + 0.5;
    ctx.strokeStyle = t.grid; ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, m.t + ph); ctx.stroke();
    if (stretto && i % 2) return;
    ctx.fillStyle = t.text3; ctx.fillText(nf0.format(q) + (i === QTICK.length - 1 ? ' km' : ''), x, m.t + ph + 8);
  });
  righe.forEach((s, i) => {
    const y = m.t + i * 32 + 16;
    if (i === quote.hover) { ctx.fillStyle = t.band; ctx.fillRect(0, y - 16, w, 32); }
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = `12px ${FONT}`;
    ctx.fillStyle = colore(s.g); ctx.beginPath(); ctx.arc(8, y, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = t.text; ctx.fillText(s.g.name, 20, y, m.l - 28);
    ctx.fillStyle = colore(s.g);
    ctx.globalAlpha = s.n > 500 ? 0.22 : s.n > 60 ? 0.5 : 0.8;
    for (const q of s.v) ctx.fillRect(Math.round(X(q)) - (s.n > 60 ? 0.5 : 1), y - 9, s.n > 60 ? 1 : 2, 18);
    ctx.globalAlpha = 1;
    if (!stretto) { ctx.fillStyle = t.text2; ctx.textAlign = 'right'; ctx.fillText(`${nf0.format(s.med)} km`, w - 4, y); }
  });
}

function tabellaQuote() {
  tabella($('altTable'), ['Costellazione', 'Satelliti', 'Più basso', 'Quota mediana', 'Più alto'],
    quote.righe.map((s) => [s.g.name, nf0.format(s.n), `${nf0.format(s.min)} km`, `${nf0.format(s.med)} km`, `${nf0.format(s.max)} km`]),
    quote.righe.length ? '' : 'Nessuna costellazione attiva.');
}

// ---------- 4. dettaglio di una costellazione: indicatori e istogramma delle quote ----------
const det = { id: null, bin: [], hover: -1, geo: null };

function gruppoDettaglio() {
  const scelta = $('detGroup');
  const disponibili = GROUPS.filter((g) => g.state.loaded && g.id !== 'stations');
  const firma = disponibili.map((g) => g.id).join();
  if (scelta.dataset.firma !== firma) {
    scelta.dataset.firma = firma;
    scelta.replaceChildren(...disponibili.map((g) => { const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; return o; }));
    if (!disponibili.some((g) => g.id === det.id)) det.id = (disponibili.find((g) => g.id === 'starlink') || disponibili[0])?.id || null;
    if (det.id) scelta.value = det.id;
  }
  return disponibili.find((g) => g.id === det.id) || null;
}

function disegnaDettaglio() {
  const g = gruppoDettaglio(), tela = $('chHist');
  $('detEmpty').hidden = !!g; $('detBody').hidden = !g;
  if (!g) return;
  const s = statistiche(g);
  if (!s.n) return;
  // inclinazione più diffusa (arrotondata al grado)
  const conta = new Map();
  for (const sat of g.state.sats) { const k = Math.round(sat.rec.inclo * RAD); conta.set(k, (conta.get(k) || 0) + 1); }
  const [incl, quanti] = [...conta.entries()].sort((a, b) => b[1] - a[1])[0];
  $('kpiN').textContent = nf0.format(s.n);
  $('kpiMed').textContent = nf0.format(s.med); $('kpiMin').textContent = nf0.format(s.min); $('kpiMax').textContent = nf0.format(s.max);
  $('kpiInc').textContent = `${incl}°`; $('kpiIncSub').textContent = `${nf0.format(100 * quanti / g.state.sats.length)}% dei satelliti`;

  // fasce di quota fra il 1° e il 99° percentile, per non farsi schiacciare dai pochi fuori scala
  const p1 = s.v[Math.floor(0.01 * (s.n - 1))], p99 = s.v[Math.ceil(0.99 * (s.n - 1))];
  const passo = Math.max(1, passoTondo((p99 - p1) / 22));
  const lo = Math.floor(p1 / passo) * passo, hi = Math.max(lo + passo, Math.ceil((p99 + 1e-6) / passo) * passo);
  const nb = Math.round((hi - lo) / passo), bin = new Array(nb).fill(0);
  let fuori = 0;
  for (const q of s.v) { const k = Math.floor((q - lo) / passo); if (k >= 0 && k < nb) bin[k]++; else fuori++; }
  det.bin = bin.map((n, k) => ({ da: lo + k * passo, a: lo + (k + 1) * passo, n }));
  $('histTitle').textContent = `${g.name}: satelliti per fascia di quota`;
  $('histSub').textContent = `Fasce di ${nf0.format(passo)} km${fuori ? ` · ${nf0.format(fuori)} satelliti fuori scala non mostrati` : ''}`;

  const c = prep(tela);
  if (!c) return;
  const { ctx, w, h } = c, t = tok();
  const m = { l: 48, r: 14, t: 10, b: 28 }, pw = w - m.l - m.r, ph = h - m.t - m.b;
  const top = Math.max(...bin), py = passoTondo(top / 4), ymax = Math.max(py, Math.ceil(top / py) * py);
  const slot = pw / nb, bw = Math.max(2, Math.min(24, slot - 2));
  det.geo = { m, slot, nb };
  ctx.font = `11px ${FONT}`; ctx.lineWidth = 1; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let val = 0; val <= ymax + py / 2; val += py) {
    const y = Math.round(m.t + ph * (1 - val / ymax)) + 0.5;
    ctx.strokeStyle = val === 0 ? t.axis : t.grid; ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
    ctx.fillStyle = t.text3; ctx.fillText(nf0.format(val), m.l - 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const ogni = Math.max(1, Math.ceil(64 / slot));
  for (let k = 0; k <= nb; k += ogni) {
    ctx.fillStyle = t.text3;
    ctx.fillText(nf0.format(lo + k * passo) + (k + ogni > nb ? ' km' : ''), m.l + k * slot, m.t + ph + 8);
  }
  bin.forEach((n, k) => {
    if (!n) return;
    const hh = Math.max(1.5, ph * n / ymax), x = m.l + k * slot + (slot - bw) / 2;
    ctx.globalAlpha = det.hover >= 0 && det.hover !== k ? 0.5 : 1;
    ctx.fillStyle = colore(g);
    ctx.beginPath(); ctx.roundRect(x, m.t + ph - hh, bw, hh, [Math.min(4, bw / 2), Math.min(4, bw / 2), 0, 0]); ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function tabellaDettaglio() {
  tabella($('histTable'), ['Fascia di quota', 'Satelliti'], det.bin.filter((b) => b.n).map((b) => [`${nf0.format(b.da)}–${nf0.format(b.a)} km`, nf0.format(b.n)]));
}

// ---------- 5. quota e luce di una stazione nelle prossime tre orbite ----------
const quotaSt = { sat: null, dati: null, at: 0, hover: -1, indice: null };

export function drawStationChart(sat, forza = false) {
  const tela = $('chStation');
  if (!sat) return;
  if (forza || quotaSt.sat !== sat || Date.now() - quotaSt.at > 60000) {
    const n = 271, passo = 3 * sat.periodMin * 60000 / (n - 1), t0 = Date.now();
    const valori = new Float32Array(n), luce = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const ms = t0 + k * passo, pv = sgp4At(sat.rec, ms), p = subpoint(sat.rec, ms);
      valori[k] = p ? p.alt : (k ? valori[k - 1] : 0);
      luce[k] = pv && isSunlit(pv.position, sunAt(ms)) ? 1 : 0;
    }
    quotaSt.sat = sat; quotaSt.at = t0; quotaSt.dati = { t0, passo, n, valori, luce };
  }
  const d = quotaSt.dati, bande = [];
  for (let k = 0, da = -1; k <= d.n; k++) {
    const ombra = k < d.n && !d.luce[k];
    if (ombra && da < 0) da = k;
    if (!ombra && da >= 0) { bande.push([da, k - 1]); da = -1; }
  }
  let lo = Infinity, hi = -Infinity;
  for (const q of d.valori) { if (q < lo) lo = q; if (q > hi) hi = q; }
  const tick = d.passo * (d.n - 1) > 5 * 3600000 ? 3600000 : 1800000;
  quotaSt.indice = linee(tela, {
    t0: d.t0, step: d.passo, n: d.n, lo: lo - 1, hi: hi + 1, hover: quotaSt.hover, bands: bande, tick,
    series: [{ name: sat.short, color: colore(GROUPS[0]), values: d.valori }],
  });
  $('stChartTitle').textContent = `Quota di ${sat.short} nelle prossime tre orbite`;
}

function tabellaStazione() {
  const d = quotaSt.dati;
  if (!d) return;
  const righe = [];
  for (let k = 0; k < d.n; k += 9) righe.push([ora(d.t0 + k * d.passo), `${nf1.format(d.valori[k])} km`, d.luce[k] ? 'Al sole' : 'In ombra']);
  tabella($('stChartTable'), ['Ora', 'Quota', 'Luce'], righe);
}

// ---------- collegamenti ----------
const TABELLE = { cardSky: tabellaCielo, cardNav: tabellaNav, cardAlt: tabellaQuote, cardHist: tabellaDettaglio, cardStation: tabellaStazione };

function aggiornaTabelle() {
  for (const [id, fn] of Object.entries(TABELLE)) if ($(id)?.classList.contains('as-table')) fn();
}

export function initCharts() {
  for (const card of document.querySelectorAll('.chart-card')) {
    const btn = card.querySelector('.tbl-toggle');
    btn?.addEventListener('click', () => {
      const tab = card.classList.toggle('as-table');
      btn.textContent = tab ? 'Grafico' : 'Tabella';
      if (tab) TABELLE[card.id]?.(); else ridisegna(true);
    });
  }
  suPuntatore($('chSky'), (x, y, e) => {
    let vicino = null, dmin = 24 * 24;
    for (const p of cielo.punti) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < dmin) { dmin = d; vicino = p; } }
    cielo.hover = vicino ? vicino.sat : null;
    if (vicino) tip(e.clientX, e.clientY, vicino.sat.name, [{ c: colore(vicino.g), v: `${nf0.format(vicino.el)}°`, n: 'di elevazione' }, { v: bussola(vicino.az), n: `direzione (${nf0.format(vicino.az)}°)` }, { v: vicino.g.name }]);
    else untip();
    disegnaCielo();
  }, () => { cielo.hover = null; disegnaCielo(); });

  suPuntatore($('chNav'), (x, y, e) => {
    if (!nav.indice || !nav.dati) return;
    nav.hover = nav.indice(x);
    tip(e.clientX, e.clientY, giornoOra(nav.dati.t0 + nav.hover * nav.dati.passo), nav.dati.serie.map((s) => ({ c: colore(s.g), v: String(s.valori[nav.hover]), n: s.g.name })));
    disegnaNav();
  }, () => { nav.hover = -1; disegnaNav(); });

  suPuntatore($('chAlt'), (x, y, e) => {
    const k = quote.geo ? Math.floor((y - quote.geo.m.t) / quote.geo.alt) : -1;
    quote.hover = k >= 0 && k < quote.righe.length ? k : -1;
    const s = quote.righe[quote.hover];
    if (s) tip(e.clientX, e.clientY, s.g.name, [{ c: colore(s.g), v: nf0.format(s.n), n: 'satelliti' }, { v: `${nf0.format(s.med)} km`, n: 'quota mediana' }, { v: `${nf0.format(s.min)}–${nf0.format(s.max)} km`, n: 'dal più basso al più alto' }]);
    else untip();
    disegnaQuote();
  }, () => { quote.hover = -1; disegnaQuote(); });

  suPuntatore($('chHist'), (x, y, e) => {
    const k = det.geo ? Math.floor((x - det.geo.m.l) / det.geo.slot) : -1;
    det.hover = k >= 0 && k < det.bin.length ? k : -1;
    const b = det.bin[det.hover];
    if (b) tip(e.clientX, e.clientY, `${nf0.format(b.da)}–${nf0.format(b.a)} km`, [{ v: nf0.format(b.n), n: 'satelliti' }]);
    else untip();
    disegnaDettaglio();
  }, () => { det.hover = -1; disegnaDettaglio(); });

  suPuntatore($('chStation'), (x, y, e) => {
    const d = quotaSt.dati;
    if (!quotaSt.indice || !d) return;
    quotaSt.hover = quotaSt.indice(x);
    tip(e.clientX, e.clientY, ora(d.t0 + quotaSt.hover * d.passo), [{ c: colore(GROUPS[0]), v: `${nf1.format(d.valori[quotaSt.hover])} km`, n: 'di quota' }, { v: d.luce[quotaSt.hover] ? 'Al sole' : 'In ombra' }]);
    drawStationChart(quotaSt.sat);
  }, () => { quotaSt.hover = -1; drawStationChart(quotaSt.sat); });

  $('detGroup').addEventListener('change', (e) => { det.id = e.target.value; det.hover = -1; disegnaDettaglio(); aggiornaTabelle(); });
  new ResizeObserver(() => { if (!$('page-grafici').hidden) ridisegna(true); }).observe($('page-grafici'));
}

let ultimo = 0;
/** Ridisegna i grafici della pagina (al massimo una volta al secondo, salvo `forza`). */
function ridisegna(forza = false) {
  const ms = Date.now();
  if (!forza && ms - ultimo < 1000) return;
  ultimo = ms;
  const n = attivi().reduce((t, g) => t + g.state.sats.length, 0);
  $('chSummary').textContent = attivi().length
    ? `Calcolati sulle ${attivi().length} costellazioni attive nella mappa (${nf0.format(n)} satelliti)`
    : 'Attiva almeno una costellazione nella mappa per vedere i grafici';
  disegnaCielo();
  disegnaQuote();
  disegnaDettaglio();
  disegnaNav();
  calcolaNav();
  aggiornaTabelle();
}
export const updateCharts = ridisegna;
