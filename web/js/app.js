// ECHO Constellation - collegamento fra interfaccia, dati e mappa
import {
  GROUPS, STATIONS, settings, saveSettings, loadGroup, tick,
  satState, lookFrom, orbitInfo, computePasses, themeColor,
} from './store.js';
import { MapView } from './map.js';
import { initCharts, updateCharts, drawStationChart } from './charts.js';
import { sunAt, sunAltitude, isSunlit, groundDistance } from './astro.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ora = (ms, sec = false) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) });
const fLat = (v) => `${nf2.format(Math.abs(v))}° ${v >= 0 ? 'N' : 'S'}`;
const fLon = (v) => `${nf2.format(Math.abs(v))}° ${v >= 0 ? 'E' : 'O'}`;
const bussola = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(az / 45) % 8];

function giorno(ms) {
  const d = new Date(ms), oggi = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate())) / 86400000);
  if (diff === 0) return 'oggi';
  if (diff === 1) return 'domani';
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
}
function eta(ms) {
  const oreFa = (Date.now() - ms) / 3600000;
  if (oreFa < 1) return `${nf0.format(Math.max(0, oreFa * 60))} minuti`;
  return oreFa < 48 ? `${nf1.format(oreFa)} ore` : `${nf1.format(oreFa / 24)} giorni`;
}

const groupById = (id) => GROUPS.find((g) => g.id === id);
const stazione = (id) => GROUPS[0].state.sats.find((s) => s.id === id) || null;
const ISS = 25544;

// ---------- Tema ----------
const temaSistema = matchMedia('(prefers-color-scheme: light)');
function applicaTema() {
  const tema = settings.tema === 'system' ? (temaSistema.matches ? 'light' : 'dark') : settings.tema;
  document.documentElement.dataset.theme = tema;
  map?.setTheme(tema);
  for (const g of GROUPS) document.querySelector(`.group-row[data-id="${g.id}"] .swatch`)?.style.setProperty('--c', themeColor(g));
}
temaSistema.addEventListener('change', applicaTema);

// ---------- Mappa ----------
const tooltip = $('tooltip');
let map = null;
map = new MapView($('mapCard'), {
  hover(sat, cx, cy) {
    if (!sat) { tooltip.hidden = true; return; }
    const st = sat.group.state;
    tooltip.innerHTML = `<b>${esc(sat.name)}</b>${esc(sat.group.name)} · quota ${nf0.format(st.alt[sat.idx])} km`;
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(cx + 14, innerWidth - r.width - 8)}px`;
    tooltip.style.top = `${Math.min(cy + 16, innerHeight - r.height - 8)}px`;
  },
  select(sat) { seleziona(sat); },
  followChanged() { aggiornaSegui(); },
});

function aggiornaSegui() {
  $('issFollow').setAttribute('aria-pressed', String(!!map.follow && map.follow.id === ISS));
  $('selFollow').setAttribute('aria-pressed', String(!!map.follow && map.follow === map.selected));
}

function seleziona(sat) {
  map.selected = sat || null;
  if (map.follow && map.follow !== sat && map.follow.id !== ISS) map.setFollow(null);
  $('selCard').hidden = !sat;
  if (sat) {
    const info = orbitInfo(sat);
    $('selName').textContent = sat.name;
    $('selSub').textContent = `${sat.group.name} · NORAD ${sat.id}`;
    $('selInc').textContent = `${nf2.format(info.incl)}°`;
    $('selPer').textContent = info.periodMin >= 180 ? `${nf2.format(info.periodMin / 60)} ore` : `${nf1.format(info.periodMin)} min`;
    $('selAge').textContent = eta(info.epochMs);
    aggiornaSelezionato(Date.now());
  }
  aggiornaSegui();
}

function aggiornaSelezionato(ms) {
  const sat = map.selected;
  if (!sat) return;
  const st = satState(sat, ms);
  if (!st) return;
  $('selLat').textContent = fLat(st.lat);
  $('selLon').textContent = fLon(st.lon);
  $('selAlt').textContent = `${nf0.format(st.alt)} km`;
  $('selVel').textContent = `${nf0.format(st.speed * 3600)} km/h`;
  const vista = lookFrom(settings.casa, st);
  $('selEl').textContent = vista.el > 0 ? `${nf1.format(vista.el)}° verso ${bussola(vista.az)}` : `sotto l'orizzonte`;
}

// ---------- Elenco delle costellazioni ----------
const ICONA_TRACCIA = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 13c3-9 7-9 9-4" stroke-dasharray="2.2 2.6"/><circle cx="13.5" cy="11" r="2" fill="currentColor" stroke="none"/></svg>';

function costruisciElenco() {
  const lista = $('groupList');
  lista.innerHTML = GROUPS.map((g, i) => `
    ${i === 1 || i === 2 || i === 6 ? '<div class="group-sep"></div>' : ''}
    <div class="group-row" data-id="${g.id}" title="${esc(g.kind)} · ${esc(g.owner)}">
      <span class="swatch" style="--c:${themeColor(g)}"></span>
      <div class="grow"><div class="body-strong">${esc(g.name)}</div><div class="caption info"></div></div>
      ${g.big ? '' : `<button class="icon-btn small track-btn" title="Mostra o nascondi le traiettorie" aria-label="Traiettorie di ${esc(g.name)}">${ICONA_TRACCIA}</button>`}
      <label class="switch" title="Mostra sulla mappa"><input type="checkbox" aria-label="Mostra ${esc(g.name)}"><span class="switch-track"><span class="switch-knob"></span></span></label>
    </div>`).join('');
  for (const g of GROUPS) {
    const riga = lista.querySelector(`[data-id="${g.id}"]`);
    riga.querySelector('input').addEventListener('change', (e) => attivaGruppo(g, e.target.checked));
    riga.querySelector('.track-btn')?.addEventListener('click', () => {
      g.state.tracks = !g.state.tracks; saveSettings(); aggiornaRiga(g);
    });
    aggiornaRiga(g);
  }
}

function aggiornaRiga(g) {
  const riga = document.querySelector(`.group-row[data-id="${g.id}"]`);
  if (!riga) return;
  const st = g.state, info = riga.querySelector('.info');
  riga.classList.toggle('off', !st.on);
  riga.querySelector('input').checked = st.on;
  const btn = riga.querySelector('.track-btn');
  if (btn) { btn.setAttribute('aria-pressed', String(st.tracks && st.on)); btn.disabled = !st.on; }
  info.classList.toggle('err', !!st.error && !st.loaded);
  if (st.loading) info.innerHTML = '<span class="ring"></span> Scaricamento dei dati…';
  else if (st.error && !st.loaded) info.textContent = 'Dati non disponibili';
  else if (st.loaded) info.textContent = `${g.owner} · ${nf0.format(st.sats.length)} satelliti${g.id === 'stations' ? '' : ` · ${nf0.format(st.avgAlt)} km`}`;
  else info.textContent = `${g.owner} · ${g.kind}`;
}

async function attivaGruppo(g, on) {
  g.state.on = on;
  saveSettings();
  if (on && !g.state.loaded) await carica(g);
  aggiornaRiga(g);
  if (!on && map.selected && map.selected.group === g) seleziona(null);
  aggiornaRiepilogo();
}

async function carica(g) {
  aggiornaRiga(g);
  togliInfo(g.id);
  const attesa = loadGroup(g);
  aggiornaRiga(g);
  try {
    await attesa;
    if (g.state.stale) mostraInfo(g.id, 'warning', `${g.name}: CelesTrak non risponde, uso l'ultima copia salvata (${giorno(g.state.fetchedAt)} alle ${ora(g.state.fetchedAt)}).`);
    if (g.id === 'stations') passaggi.clear();
  } catch (errore) {
    mostraInfo(g.id, 'error', `${g.name}: ${errore.message}.`, 'Riprova', () => carica(g).then(aggiornaRiepilogo));
  }
  aggiornaRiga(g);
  aggiornaDati();
}

// ---------- InfoBar ----------
function mostraInfo(chiave, tipo, testo, etichetta, azione) {
  togliInfo(chiave);
  const barra = document.createElement('div');
  barra.className = `infobar ${tipo}`; barra.dataset.key = chiave;
  barra.innerHTML = `<span class="ico">!</span><span class="grow">${esc(testo)}</span>${etichetta ? `<button class="btn">${esc(etichetta)}</button>` : ''}<button class="icon-btn small" aria-label="Chiudi"><span class="fi" style="font-size:12px">&#xE711;</span></button>`;
  if (etichetta) barra.querySelector('.btn').addEventListener('click', azione);
  barra.querySelector('.icon-btn').addEventListener('click', () => barra.remove());
  $('infobars').append(barra);
}
const togliInfo = (chiave) => document.querySelector(`.infobar[data-key="${chiave}"]`)?.remove();

// ---------- Riepilogo e striscia della ISS ----------
function aggiornaRiepilogo() {
  const attivi = GROUPS.filter((g) => g.state.on && g.state.loaded);
  const n = attivi.reduce((t, g) => t + g.state.sats.length, 0);
  if (!attivi.length) {
    $('mapSummary').textContent = GROUPS.some((g) => g.state.loading) ? 'Caricamento dei dati orbitali…' : 'Nessuna costellazione attiva: scegline una dall\'elenco a destra';
    return;
  }
  const piuVecchio = Math.min(...attivi.map((g) => g.state.fetchedAt));
  $('mapSummary').textContent = `${nf0.format(n)} satelliti sulla mappa · ${attivi.length} ${attivi.length === 1 ? 'costellazione attiva' : 'costellazioni attive'} · dati CelesTrak delle ${ora(piuVecchio)}`;
}

const passaggi = new Map();   // numero NORAD -> { at, casa, elenco }
function leggiPassaggi(sat) {
  const casa = `${settings.casa.lat},${settings.casa.lon}`;
  let p = passaggi.get(sat.id);
  if (!p || p.casa !== casa || Date.now() - p.at > 600000) {
    p = { at: Date.now(), casa, elenco: computePasses(sat, settings.casa, Date.now() - 600000, 72) };
    passaggi.set(sat.id, p);
  }
  return p.elenco;
}

function testoLuce(st, sole) {
  const luce = isSunlit(st.pos, sole);
  return { luce, testo: luce ? 'Illuminata dal Sole' : 'Nell\'ombra della Terra' };
}
function suolo(st, sole) {
  const alt = sunAltitude(st.lat, st.lon, sole);
  return alt > 0 ? 'a terra è giorno' : alt > -12 ? 'a terra è il crepuscolo' : 'a terra è notte';
}

function aggiornaStriscia(ms) {
  const iss = stazione(ISS);
  if (!iss) return;
  const st = satState(iss, ms);
  if (!st) return;
  const sole = sunAt(ms), casa = settings.casa;
  $('issLat').textContent = fLat(st.lat);
  $('issLatSub').textContent = st.lat >= 0 ? 'emisfero nord' : 'emisfero sud';
  $('issLon').textContent = fLon(st.lon);
  $('issLonSub').textContent = suolo(st, sole);
  $('issAlt').innerHTML = `${nf1.format(st.alt)}<small>km</small>`;
  $('issVel').innerHTML = `${nf0.format(st.speed * 3600)}<small>km/h</small>`;
  $('issVelSub').textContent = `${nf2.format(st.speed)} km al secondo`;
  const vista = lookFrom(casa, st);
  $('issHomeCap').textContent = `Da ${casa.nome}`;
  $('issDist').innerHTML = `${nf0.format(groundDistance(casa.lat, casa.lon, st.lat, st.lon))}<small>km</small>`;
  $('issDistSub').textContent = vista.el > 0 ? `in cielo: ${nf0.format(vista.el)}° verso ${bussola(vista.az)}` : 'sotto l\'orizzonte';
  const { luce, testo } = testoLuce(st, sole);
  $('issLight').textContent = testo;
  $('issLight').className = `badge ${luce ? 'success' : ''}`;
  $('issEpoch').textContent = `· elementi orbitali di ${eta(orbitInfo(iss).epochMs)} fa`;

  const prossimo = leggiPassaggi(iss).find((p) => p.end > ms);
  if (!prossimo) { $('issNext').textContent = '—'; $('issNextSub').textContent = 'nessuno nelle prossime 72 ore'; return; }
  const inCorso = prossimo.start <= ms;
  $('issNext').textContent = inCorso ? 'adesso' : ora(prossimo.start);
  $('issNextSub').textContent = `${inCorso ? `fino alle ${ora(prossimo.end)}` : giorno(prossimo.start)} · max ${nf0.format(prossimo.maxEl)}°${prossimo.vis === 'visibile' ? ' · visibile' : ''}`;
}

// ---------- Pagina delle stazioni ----------
let stazioneCorrente = ISS;
const STAT = [
  ['lat', 'Latitudine'], ['lon', 'Longitudine'], ['alt', 'Quota'], ['vel', 'Velocità'],
  ['dist', 'Distanza al suolo da casa'], ['el', 'Posizione in cielo da casa'], ['giri', 'Orbite al giorno'], ['per', 'Durata di un\'orbita'],
];

function costruisciStazioni() {
  $('stStats').innerHTML = STAT.map(([k, nome]) => `<div class="card stat"><div class="caption">${nome}</div><div class="val" id="st-${k}">—</div><div class="sub" id="st-${k}-sub"></div></div>`).join('');
  $('stSelector').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    stazioneCorrente = Number(b.dataset.id);
    mostraStazione();
  });
  $('stShow').addEventListener('click', () => {
    const sat = stazione(stazioneCorrente);
    vaiA('mappa');
    if (sat) { seleziona(sat); map.animateTo({ lon: map.stateOf(sat, Date.now())?.lon ?? 0, lat: 0, zoom: 1 }); }
  });
}

function mostraStazione() {
  const sats = GROUPS[0].state.sats;
  $('stSelector').innerHTML = Object.keys(STATIONS).map((id) => `<button role="tab" data-id="${id}" class="${Number(id) === stazioneCorrente ? 'selected' : ''}">${esc(STATIONS[id].short)}</button>`).join('');
  const sat = stazione(stazioneCorrente);
  if (!sat) {
    $('stSummary').textContent = sats.length ? 'Dati di questa stazione non disponibili' : 'Attiva «Stazioni spaziali» nella mappa per scaricare i dati';
    $('stPasses').innerHTML = ''; $('stElements').innerHTML = '';
    return;
  }
  const info = orbitInfo(sat), casa = settings.casa;
  $('stSummary').textContent = `${sat.name} · posizione calcolata dagli elementi orbitali CelesTrak`;
  $('stEpoch').textContent = `Epoca: ${new Date(info.epochMs).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })} (${eta(info.epochMs)} fa)`;
  $('st-giri').textContent = nf2.format(info.revDay);
  $('st-per').innerHTML = `${nf1.format(info.periodMin)}<small>min</small>`;
  const voci = [
    ['Numero NORAD', sat.id], ['Inclinazione', `${nf2.format(info.incl)}°`],
    ['Perigeo', `${nf0.format(info.perigee)} km`], ['Apogeo', `${nf0.format(info.apogee)} km`],
    ['Eccentricità', info.ecc.toFixed(5).replace('.', ',')], ['Orbite al giorno', nf2.format(info.revDay)],
  ];
  $('stElements').innerHTML = voci.map(([k, v]) => `<div><div class="caption">${k}</div><div class="v">${v}</div></div>`).join('');

  $('stPassTitle').textContent = `Prossimi passaggi su ${casa.nome}`;
  const elenco = leggiPassaggi(sat).filter((p) => p.end > Date.now());
  const etichetta = { visibile: ['success', 'Visibile'], giorno: ['', 'Di giorno'], ombra: ['', 'In ombra'] };
  $('stPasses').innerHTML = elenco.length ? `<table class="table"><thead><tr><th>Giorno</th><th>Inizio</th><th>Culmine</th><th>Fine</th><th>Elev. max</th><th>Direzione</th><th>Osservabilità</th></tr></thead><tbody>${
    elenco.map((p) => `<tr><td>${giorno(p.start)}</td><td>${ora(p.start)}</td><td>${ora(p.tMax)}</td><td>${ora(p.end)}</td><td>${nf0.format(p.maxEl)}°</td><td>${bussola(p.azStart)} → ${bussola(p.azEnd)}</td><td><span class="badge ${etichetta[p.vis][0]}">${etichetta[p.vis][1]}</span></td></tr>`).join('')
  }</tbody></table>` : '<div class="empty">Nessun passaggio sopra i 10° nelle prossime 72 ore.</div>';
  aggiornaStazione(Date.now());
  drawStationChart(sat, true);
}

function aggiornaStazione(ms) {
  const sat = stazione(stazioneCorrente);
  const st = sat && satState(sat, ms);
  if (!st) return;
  const sole = sunAt(ms), casa = settings.casa, vista = lookFrom(casa, st);
  $('st-lat').textContent = fLat(st.lat);
  $('st-lat-sub').textContent = suolo(st, sole);
  $('st-lon').textContent = fLon(st.lon);
  $('st-alt').innerHTML = `${nf1.format(st.alt)}<small>km</small>`;
  $('st-vel').innerHTML = `${nf0.format(st.speed * 3600)}<small>km/h</small>`;
  $('st-vel-sub').textContent = `${nf2.format(st.speed)} km al secondo`;
  $('st-dist').innerHTML = `${nf0.format(groundDistance(casa.lat, casa.lon, st.lat, st.lon))}<small>km</small>`;
  $('st-dist-sub').textContent = `in linea d'aria ${nf0.format(vista.range)} km`;
  $('st-el').innerHTML = vista.el > 0 ? `${nf1.format(vista.el)}°<small>verso ${bussola(vista.az)}</small>` : '<small style="margin:0">sotto l\'orizzonte</small>';
  $('st-el-sub').textContent = vista.el > 0 ? 'sopra l\'orizzonte adesso' : `${nf0.format(-vista.el)}° sotto l'orizzonte`;
  const { luce, testo } = testoLuce(st, sole);
  $('stLight').textContent = testo;
  $('stLight').className = `badge ${luce ? 'success' : ''}`;
}

// ---------- Navigazione ----------
let pagina = 'mappa';
function vaiA(nome) {
  pagina = nome;
  for (const s of document.querySelectorAll('.page')) s.hidden = s.id !== `page-${nome}`;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('selected', b.dataset.page === nome);
  $('content').scrollTop = 0;
  tooltip.hidden = true;
  if (nome === 'mappa') map.resize();
  if (nome === 'stazioni') mostraStazione();
  if (nome === 'grafici') updateCharts(true);
  if (nome === 'impostazioni') aggiornaDati();
}

function impostaMenu(aperto) {
  $('app').classList.toggle('nav-open', aperto);
  settings.menuAperto = aperto;
}

// ---------- Impostazioni ----------
function aggiornaDati() {
  $('dataList').innerHTML = GROUPS.map((g) => {
    const st = g.state;
    const stato = st.loaded ? `${giorno(st.fetchedAt)} alle ${ora(st.fetchedAt)}${st.stale ? ' (copia vecchia)' : ''}` : st.error ? 'errore' : 'non ancora scaricato';
    return `<div><span>${esc(g.name)}</span><span>${stato}</span></div>`;
  }).join('');
}

function collegaImpostazioni() {
  $('setTheme').value = settings.tema;
  $('setTheme').addEventListener('change', (e) => { settings.tema = e.target.value; saveSettings(); applicaTema(); });
  $('setTrackLen').value = String(settings.lunghezzaTracce);
  $('setTrackLen').addEventListener('change', (e) => { settings.lunghezzaTracce = Number(e.target.value); saveSettings(); });
  $('setLabels').value = settings.etichette;
  $('setLabels').addEventListener('change', (e) => { settings.etichette = e.target.value; saveSettings(); });
  $('setNight').checked = settings.notte;
  $('setNight').addEventListener('change', (e) => { settings.notte = e.target.checked; saveSettings(); map.baseDirty = true; });
  const casa = settings.casa;
  $('setHomeName').value = casa.nome; $('setHomeLat').value = String(casa.lat).replace('.', ','); $('setHomeLon').value = String(casa.lon).replace('.', ',');
  $('setHomeSave').addEventListener('click', () => {
    const lat = Number($('setHomeLat').value.replace(',', '.')), lon = Number($('setHomeLon').value.replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      $('setHomeSave').textContent = 'Valori non validi';
      setTimeout(() => { $('setHomeSave').textContent = 'Salva'; }, 1800);
      return;
    }
    settings.casa = { nome: $('setHomeName').value.trim() || 'Casa', lat, lon };
    saveSettings(); passaggi.clear();
    $('setHomeSave').textContent = 'Salvato';
    setTimeout(() => { $('setHomeSave').textContent = 'Salva'; }, 1500);
  });
}

// ---------- Ricerca ----------
function collegaRicerca() {
  const campo = $('searchInput'), lista = $('suggest');
  let risultati = [], attivo = 0;
  const chiudi = () => { lista.hidden = true; };
  const disegna = () => {
    lista.innerHTML = risultati.length
      ? risultati.map((s, i) => `<div class="suggest-item ${i === attivo ? 'active' : ''}" data-i="${i}"><span class="swatch" style="--c:${themeColor(STATIONS[s.id] || s.group)}"></span><span>${esc(s.name)}</span><span class="caption">${esc(s.group.name)} · ${s.id}</span></div>`).join('')
      : '<div class="suggest-empty">Nessun satellite trovato fra le costellazioni già scaricate</div>';
    lista.hidden = false;
  };
  const scegli = (sat) => {
    if (!sat) return;
    chiudi(); campo.value = ''; campo.blur();
    vaiA('mappa');
    if (!sat.group.state.on) attivaGruppo(sat.group, true);
    seleziona(sat);
    const st = satState(sat, Date.now());
    if (st) map.animateTo({ lon: st.lon, lat: st.lat, zoom: Math.max(map.zoom, 2.5) });
  };
  campo.addEventListener('input', () => {
    const q = campo.value.trim().toLowerCase();
    if (q.length < 2) { chiudi(); return; }
    risultati = []; attivo = 0;
    for (const g of GROUPS) {
      if (!g.state.loaded) continue;
      for (const s of g.state.sats) {
        if (s.lname.includes(q) || s.short.toLowerCase().includes(q) || String(s.id).startsWith(q)) { risultati.push(s); if (risultati.length >= 8) break; }
      }
      if (risultati.length >= 8) break;
    }
    disegna();
  });
  campo.addEventListener('keydown', (e) => {
    if (lista.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      attivo = (attivo + (e.key === 'ArrowDown' ? 1 : -1) + risultati.length) % Math.max(1, risultati.length);
      disegna();
    } else if (e.key === 'Enter') scegli(risultati[attivo]);
    else if (e.key === 'Escape') chiudi();
  });
  lista.addEventListener('pointerdown', (e) => {
    const voce = e.target.closest('.suggest-item');
    if (voce) { e.preventDefault(); scegli(risultati[Number(voce.dataset.i)]); }
  });
  campo.addEventListener('blur', () => setTimeout(chiudi, 120));
}

// ---------- Avvio ----------
function collegaComandi() {
  for (const b of document.querySelectorAll('.nav-item')) b.addEventListener('click', () => vaiA(b.dataset.page));
  $('navToggle').addEventListener('click', () => { impostaMenu(!$('app').classList.contains('nav-open')); saveSettings(); });
  $('btnHome').addEventListener('click', () => { map.setFollow(null); map.animateTo({ lon: settings.casa.lon, lat: settings.casa.lat, zoom: Math.max(map.zoom, 4) }); });
  $('btnWorld').addEventListener('click', () => { map.setFollow(null); map.animateTo({ lon: 0, lat: 0, zoom: 1 }); });
  $('zoomIn').addEventListener('click', () => map.animateTo({ zoom: map.zoom * 1.6 }, 250));
  $('zoomOut').addEventListener('click', () => map.animateTo({ zoom: map.zoom / 1.6 }, 250));
  $('issFollow').addEventListener('click', async () => {
    if (map.follow && map.follow.id === ISS) { map.setFollow(null); return; }
    if (!GROUPS[0].state.on) await attivaGruppo(GROUPS[0], true);
    const iss = stazione(ISS);
    if (iss) { map.zoom = Math.max(map.zoom, 2); map.setFollow(iss); }
  });
  $('issDetails').addEventListener('click', () => { stazioneCorrente = ISS; vaiA('stazioni'); });
  $('selClose').addEventListener('click', () => seleziona(null));
  $('selCenter').addEventListener('click', () => {
    const st = map.selected && satState(map.selected, Date.now());
    if (st) map.animateTo({ lon: st.lon, lat: st.lat, zoom: Math.max(map.zoom, 2.5) });
  });
  $('selFollow').addEventListener('click', () => {
    if (!map.selected) return;
    map.setFollow(map.follow === map.selected ? null : map.selected);
  });
}

function orologio(ms) {
  $('clockLocal').textContent = ora(ms, true);
  $('clockUtc').textContent = `${new Date(ms).toISOString().slice(11, 19)} UTC`;
  $('mapChipText').textContent = `in tempo reale · ${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

let ultimoLento = 0, ultimoRiepilogo = 0;
function ciclo() {
  const ms = Date.now();
  if (pagina === 'mappa') { tick(ms); map.frame(ms); }
  if (pagina === 'grafici') { tick(ms); updateCharts(); }
  if (ms - ultimoLento > 250) {
    ultimoLento = ms;
    orologio(ms);
    if (pagina === 'mappa') { aggiornaStriscia(ms); aggiornaSelezionato(ms); }
    if (pagina === 'stazioni') { aggiornaStazione(ms); drawStationChart(stazione(stazioneCorrente)); }
  }
  if (ms - ultimoRiepilogo > 5000) {
    ultimoRiepilogo = ms;
    if (pagina === 'mappa') for (const g of GROUPS) if (g.state.loaded && g.state.on) aggiornaRiga(g);
  }
  requestAnimationFrame(ciclo);
}

async function avvia() {
  impostaMenu(settings.menuAperto ?? innerWidth >= 1500);
  $('btnHomeText').textContent = `Centra su ${settings.casa.nome}`;
  costruisciElenco();
  costruisciStazioni();
  collegaComandi();
  collegaImpostazioni();
  collegaRicerca();
  initCharts();
  applicaTema();
  requestAnimationFrame(ciclo);
  map.loadWorld().catch(() => mostraInfo('mondo', 'error', 'Non riesco a caricare la cartografia della mappa.'));
  // prima le stazioni, poi le altre costellazioni attive (una alla volta per non affollare la rete)
  for (const g of GROUPS.filter((x) => x.state.on)) {
    await carica(g);
    aggiornaRiepilogo();
  }
  aggiornaRiepilogo();
}

window.echo = { map, GROUPS, settings };   // utile per le prove dalla console
avvia();
