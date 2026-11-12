// ECHO Constellation - mappa piatta (proiezione equirettangolare) disegnata su due canvas:
// uno per lo sfondo (terre, reticolo, notte) e uno per i satelliti, ridisegnato a ogni fotogramma.
/* global topojson */
import { GROUPS, STATIONS, settings, satState, subpoint, themeColor } from './store.js';
import { DEG, RAD, RE, wrap180, sunAt } from './astro.js';

const TAU = Math.PI * 2;
const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

const PAL = {
  dark: {
    oceanTop: '#17232f', oceanBot: '#101922', land: '#2c3540', coast: 'rgba(255,255,255,0.28)',
    border: 'rgba(255,255,255,0.085)', grat: 'rgba(255,255,255,0.05)', gratStrong: 'rgba(255,255,255,0.11)',
    label: 'rgba(255,255,255,0.4)', night: [0, 0, 0], nightMax: 0.5, halo: 'rgba(0,0,0,0.65)',
    text: '#ffffff', pill: 'rgba(36,36,36,0.82)', home: '#60cdff', ring: '#ffffff', sun: '#ffd75e',
  },
  light: {
    oceanTop: '#cde0f3', oceanBot: '#dbe8f5', land: '#f8f6f0', coast: 'rgba(0,0,0,0.32)',
    border: 'rgba(0,0,0,0.11)', grat: 'rgba(0,0,0,0.05)', gratStrong: 'rgba(0,0,0,0.11)',
    label: 'rgba(0,0,0,0.45)', night: [20, 30, 62], nightMax: 0.36, halo: 'rgba(255,255,255,0.8)',
    text: '#1b1b1b', pill: 'rgba(255,255,255,0.88)', home: '#005fb8', ring: '#1b1b1b', sun: '#e8a400',
  },
};

const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Traiettoria a terra: punti passati e futuri con longitudine "srotolata" (senza salti a ±180°). */
function buildTrack(sat, ms, pastFrac, futFrac) {
  const periodo = sat.periodMin * 60000, dt = periodo / 180;
  const qui = subpoint(sat.rec, ms);
  if (!qui) return null;
  const ramo = (frac, verso) => {
    const n = Math.max(0, Math.round(frac * 180));
    const lon = new Float32Array(n + 1), lat = new Float32Array(n + 1);
    lon[0] = qui.lon; lat[0] = qui.lat;
    let m = 1;
    for (; m <= n; m++) {
      const p = subpoint(sat.rec, ms + verso * m * dt);
      if (!p) break;
      lon[m] = lon[m - 1] + wrap180(p.lon - lon[m - 1]);
      lat[m] = p.lat;
    }
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < m; i++) { if (lon[i] < min) min = lon[i]; if (lon[i] > max) max = lon[i]; }
    return { lon, lat, n: m, min, max };
  };
  return { ms, key: `${pastFrac}|${futFrac}`, past: ramo(pastFrac, -1), fut: ramo(futFrac, 1) };
}

export class MapView {
  constructor(card, hooks) {
    this.card = card;
    this.hooks = hooks;
    this.base = card.querySelector('#mapBase');
    this.live = card.querySelector('#mapLive');
    this.bctx = this.base.getContext('2d');
    this.lctx = this.live.getContext('2d');
    this.theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    this.w = 0; this.h = 0; this.dpr = 1; this.minScale = 1;
    this.zoom = 1; this.cLon = 0; this.cLat = 0;
    this.land = null; this.coast = null; this.borders = null;
    this.baseDirty = true;
    this.night = document.createElement('canvas');
    this.night.width = 360; this.night.height = 180;
    this.nightAt = 0; this.sun = null;
    this.selected = null; this.follow = null; this.hover = null;
    this.anim = null; this.drag = null;
    this.memo = new Map(); this.memoAt = -1;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(card);
    this.resize();
  }

  get scale() { return this.minScale * this.zoom; }

  /** Carica i contorni di terre e confini (Natural Earth 1:50m). */
  async loadWorld() {
    const mondo = await (await fetch('vendor/countries-50m.json')).json();
    const terre = topojson.feature(mondo, mondo.objects.land);
    const confini = topojson.mesh(mondo, mondo.objects.countries, (a, b) => a !== b);
    const land = new Path2D(), coast = new Path2D(), borders = new Path2D();
    const poligoni = terre.features ? terre.features.flatMap((f) => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
      : (terre.geometry.type === 'Polygon' ? [terre.geometry.coordinates] : terre.geometry.coordinates);
    // tratti artificiali (taglio a ±180° e bordo del Polo Sud) da non disegnare come costa
    const artificiale = (a, b) => (Math.abs(a[0]) > 179.99 && Math.abs(b[0]) > 179.99) || (a[1] < -89.9 && b[1] < -89.9);
    for (const poligono of poligoni) {
      for (const anello of poligono) {
        for (let i = 0; i < anello.length; i++) {
          const p = anello[i];
          if (i === 0) { land.moveTo(p[0], -p[1]); coast.moveTo(p[0], -p[1]); continue; }
          land.lineTo(p[0], -p[1]);
          if (artificiale(anello[i - 1], p)) coast.moveTo(p[0], -p[1]); else coast.lineTo(p[0], -p[1]);
        }
        land.closePath();
      }
    }
    for (const linea of confini.coordinates) {
      linea.forEach((p, i) => (i ? borders.lineTo(p[0], -p[1]) : borders.moveTo(p[0], -p[1])));
    }
    this.land = land; this.coast = coast; this.borders = borders;
    this.baseDirty = true;
  }

  resize() {
    const r = this.card.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    this.w = r.width; this.h = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.base, this.live]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    this.minScale = Math.max(this.h / 180, this.w / 720);
    this.clamp();
    this.baseDirty = true;
  }

  setTheme(tema) { this.theme = tema === 'light' ? 'light' : 'dark'; this.nightAt = 0; this.baseDirty = true; }

  clamp() {
    this.zoom = Math.max(1, Math.min(14, this.zoom));
    const mezza = this.h / (2 * this.scale);
    const limite = Math.max(0, 90 - mezza);
    this.cLat = Math.max(-limite, Math.min(limite, this.cLat));
  }

  y(lat) { return this.h / 2 - (lat - this.cLat) * this.scale; }

  /** Ascisse a schermo di una longitudine (la mappa si ripete in orizzontale). */
  xs(lon, margine = 24) {
    const s = this.scale, giro = 360 * s;
    const x = this.w / 2 + wrap180(lon - this.cLon) * s;
    const out = [x];
    if (x - giro > -margine) out.push(x - giro);
    if (x + giro < this.w + margine) out.push(x + giro);
    return out;
  }

  zoomAt(px, py, fattore) {
    const s1 = this.scale;
    const lon = this.cLon + (px - this.w / 2) / s1, lat = this.cLat - (py - this.h / 2) / s1;
    this.zoom *= fattore; this.clamp();
    const s2 = this.scale;
    this.cLon = lon - (px - this.w / 2) / s2;
    this.cLat = lat + (py - this.h / 2) / s2;
    this.clamp();
    this.baseDirty = true;
  }

  /** Sposta la vista con un'animazione morbida. */
  animateTo({ lon = this.cLon, lat = this.cLat, zoom = this.zoom }, durata = 500) {
    this.anim = {
      t0: performance.now(), durata,
      da: { lon: this.cLon, lat: this.cLat, z: Math.log(this.zoom) },
      a: { lon: this.cLon + wrap180(lon - this.cLon), lat, z: Math.log(Math.max(1, Math.min(14, zoom))) },
    };
  }

  setFollow(sat) {
    this.follow = sat || null;
    this.hooks.followChanged?.();
  }

  stateOf(sat, ms) {
    if (this.memoAt !== ms) { this.memo.clear(); this.memoAt = ms; }
    let st = this.memo.get(sat);
    if (st === undefined) { st = satState(sat, ms); this.memo.set(sat, st); }
    return st;
  }

  // ---------- interazione ----------
  bind() {
    const card = this.card;
    const pos = (e) => { const r = card.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.map-zoom')) return;
      const [x, y] = pos(e);
      this.drag = { x, y, lon: this.cLon, lat: this.cLat, moved: false };
      card.setPointerCapture(e.pointerId);
    });
    card.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (this.drag) {
        const dx = x - this.drag.x, dy = y - this.drag.y;
        if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!this.drag.moved) { this.drag.moved = true; card.classList.add('dragging'); this.anim = null; if (this.follow) this.setFollow(null); this.setHover(null); }
        this.cLon = this.drag.lon - dx / this.scale;
        this.cLat = this.drag.lat + dy / this.scale;
        this.clamp(); this.baseDirty = true;
        return;
      }
      if (e.target.closest('.map-zoom')) { this.setHover(null); return; }
      this.setHover(this.pick(x, y), e.clientX, e.clientY);
    });
    const rilascia = (e) => {
      if (!this.drag) return;
      const trascinato = this.drag.moved;
      this.drag = null; card.classList.remove('dragging');
      if (!trascinato && e.type === 'pointerup') {
        const [x, y] = pos(e);
        this.hooks.select?.(this.pick(x, y));
      }
    };
    card.addEventListener('pointerup', rilascia);
    card.addEventListener('pointercancel', rilascia);
    card.addEventListener('pointerleave', () => { if (!this.drag) this.setHover(null); });
    card.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      this.anim = null;
      this.zoomAt(x, y, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('.map-zoom')) return;
      const [x, y] = pos(e);
      const s = this.scale;
      this.animateTo({ lon: this.cLon + (x - this.w / 2) / s, lat: this.cLat - (y - this.h / 2) / s, zoom: this.zoom * 2 }, 350);
    });
  }

  setHover(sat, cx, cy) {
    if (sat !== this.hover) this.card.classList.toggle('pointing', !!sat);
    this.hover = sat;
    this.hooks.hover?.(sat, cx, cy);
  }

  /** Satellite più vicino al punto indicato (entro pochi pixel), fra i gruppi visibili. */
  pick(px, py) {
    const s = this.scale;
    const lon0 = this.cLon + (px - this.w / 2) / s, lat0 = this.cLat - (py - this.h / 2) / s;
    let migliore = null, dMin = Infinity;
    for (const g of GROUPS) {
      const st = g.state;
      if (!st.on || !st.loaded) continue;
      const raggio = g.id === 'stations' ? 14 : 8;
      const soglia = (raggio / s) ** 2;
      for (let i = 0; i < st.sats.length; i++) {
        const lat = st.lat[i];
        if (lat !== lat) continue;
        const dy = lat - lat0;
        if (dy > 20 || dy < -20) continue;
        const dx = wrap180(st.lon[i] - lon0);
        const d = dx * dx + dy * dy;
        if (d < soglia && d < dMin) { dMin = d; migliore = st.sats[i]; }
      }
    }
    return migliore;
  }

  // ---------- fotogramma ----------
  frame(ms) {
    if (this.w < 10) return;
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / this.anim.durata);
      const e = 1 - (1 - k) ** 3;
      const { da, a } = this.anim;
      this.cLon = da.lon + (a.lon - da.lon) * e;
      this.cLat = da.lat + (a.lat - da.lat) * e;
      this.zoom = Math.exp(da.z + (a.z - da.z) * e);
      this.clamp(); this.baseDirty = true;
      if (k >= 1) this.anim = null;
    } else if (this.follow && !this.drag) {
      const st = this.stateOf(this.follow, ms);
      if (st) {
        const lon = this.cLon + wrap180(st.lon - this.cLon);
        if (Math.abs(lon - this.cLon) * this.scale > 0.5 || Math.abs(st.lat - this.cLat) * this.scale > 0.5) {
          this.cLon = lon; this.cLat = st.lat; this.clamp(); this.baseDirty = true;
        }
      }
    }
    if (ms - this.nightAt > 60000) { this.updateNight(ms); this.baseDirty = true; }
    if (this.baseDirty && this.land) { this.drawBase(); this.baseDirty = false; }
    this.drawLive(ms);
  }

  /** Ricalcola l'ombra della notte su una griglia di 1 grado (crepuscolo sfumato). */
  updateNight(ms) {
    this.nightAt = ms;
    const sole = this.sun = sunAt(ms);
    const pal = PAL[this.theme];
    const ctx = this.night.getContext('2d');
    const img = ctx.createImageData(360, 180), d = img.data;
    const sd = Math.sin(sole.lat * DEG), cd = Math.cos(sole.lat * DEG);
    const cosLon = new Float32Array(360);
    for (let i = 0; i < 360; i++) cosLon[i] = Math.cos((-179.5 + i - sole.lon) * DEG);
    const [r, g, b] = pal.night;
    for (let j = 0, k = 0; j < 180; j++) {
      const lat = (89.5 - j) * DEG, sl = Math.sin(lat) * sd, cl = Math.cos(lat) * cd;
      for (let i = 0; i < 360; i++, k += 4) {
        const alt = Math.asin(sl + cl * cosLon[i]) * RAD;         // altezza del Sole
        let t = (1 - alt) / 13; t = t < 0 ? 0 : t > 1 ? 1 : t;    // da +1° (giorno) a -12° (notte)
        d[k] = r; d[k + 1] = g; d[k + 2] = b;
        d[k + 3] = Math.round(255 * pal.nightMax * t * t * (3 - 2 * t));
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  drawBase() {
    const ctx = this.bctx, { w, h, dpr } = this, s = this.scale, pal = PAL[this.theme];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mare = ctx.createLinearGradient(0, 0, 0, h);
    mare.addColorStop(0, pal.oceanTop); mare.addColorStop(1, pal.oceanBot);
    ctx.fillStyle = mare; ctx.fillRect(0, 0, w, h);

    const vL = this.cLon - w / 2 / s, vR = this.cLon + w / 2 / s;
    const k0 = Math.floor((vL + 180) / 360), k1 = Math.floor((vR + 180) / 360);
    const oy = h / 2 + this.cLat * s;
    ctx.lineJoin = 'round';
    for (let k = k0; k <= k1; k++) {
      const ox = w / 2 + (360 * k - this.cLon) * s;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      ctx.fillStyle = pal.land; ctx.fill(this.land, 'evenodd');
      ctx.lineWidth = 0.6 / s; ctx.strokeStyle = pal.border; ctx.stroke(this.borders);
      ctx.lineWidth = 0.8 / s; ctx.strokeStyle = pal.coast; ctx.stroke(this.coast);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // reticolo ogni 30 gradi (15 quando si ingrandisce)
    const passo = this.zoom >= 3 ? 15 : 30;
    ctx.lineWidth = 1;
    ctx.font = `10px ${FONT}`; ctx.textBaseline = 'middle';
    for (let lon = Math.ceil(vL / passo) * passo; lon <= vR; lon += passo) {
      const x = Math.round(w / 2 + (lon - this.cLon) * s) + 0.5;
      ctx.strokeStyle = wrap180(lon) === 0 ? pal.gratStrong : pal.grat;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      const l = Math.round(wrap180(lon));
      ctx.fillStyle = pal.label; ctx.textAlign = 'center';
      if (lon % 30 === 0) ctx.fillText(l === 0 ? '0°' : l === -180 ? '180°' : `${Math.abs(l)}°${l > 0 ? 'E' : 'O'}`, x, h - 9);
    }
    for (let lat = -90 + passo; lat < 90; lat += passo) {
      const yy = Math.round(this.y(lat)) + 0.5;
      if (yy < 0 || yy > h) continue;
      ctx.strokeStyle = lat === 0 ? pal.gratStrong : pal.grat;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
      ctx.fillStyle = pal.label; ctx.textAlign = 'left';
      if (lat % 30 === 0 && yy > 44 && yy < h - 20) ctx.fillText(lat === 0 ? '0°' : `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}`, 6, yy - 7);
    }

    // notte e punto subsolare
    if (settings.notte && this.sun) {
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      for (let k = k0; k <= k1; k++) {
        ctx.drawImage(this.night, w / 2 + (-180 + 360 * k - this.cLon) * s, h / 2 - (90 - this.cLat) * s, 360 * s, 180 * s);
      }
      const ys = this.y(this.sun.lat);
      for (const x of this.xs(this.sun.lon)) {
        const alone = ctx.createRadialGradient(x, ys, 0, x, ys, 22);
        alone.addColorStop(0, alpha(pal.sun, 0.45)); alone.addColorStop(1, alpha(pal.sun, 0));
        ctx.fillStyle = alone; ctx.beginPath(); ctx.arc(x, ys, 22, 0, TAU); ctx.fill();
        ctx.fillStyle = pal.sun; ctx.beginPath(); ctx.arc(x, ys, 4.5, 0, TAU); ctx.fill();
      }
    }
  }

  /** Disegna una spezzata in coordinate geografiche su tutte le copie visibili della mappa. */
  strokeTrack(ctx, t, da = 0, a = t.n - 1) {
    if (a - da < 1) return;
    const { w, h } = this, s = this.scale;
    const vL = this.cLon - w / 2 / s, vR = this.cLon + w / 2 / s;
    for (let k = Math.ceil((vL - t.max) / 360); k <= Math.floor((vR - t.min) / 360); k++) {
      ctx.beginPath();
      for (let i = da; i <= a; i++) {
        const x = w / 2 + (t.lon[i] + 360 * k - this.cLon) * s, y = h / 2 - (t.lat[i] - this.cLat) * s;
        if (i === da) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  /** Traiettoria completa di un satellite in evidenza: scia sfumata + futuro tratteggiato in movimento. */
  drawFullTrack(ctx, sat, ms, colore, dash) {
    if (!sat.trk || sat.trk.key !== '0.5|1' || ms - sat.trk.ms > 1000) sat.trk = buildTrack(sat, ms, 0.5, 1) || sat.trk;
    const t = sat.trk;
    if (!t) return;
    ctx.setLineDash([]); ctx.lineWidth = 1.6;
    const n = t.past.n - 1, pezzi = 5;
    for (let j = 0; j < pezzi; j++) {
      ctx.strokeStyle = alpha(colore, 0.6 * (1 - j / pezzi));
      this.strokeTrack(ctx, t.past, Math.floor(j * n / pezzi), Math.floor((j + 1) * n / pezzi));
    }
    ctx.setLineDash([7, 6]); ctx.lineDashOffset = dash; ctx.lineWidth = 1.8;
    ctx.strokeStyle = alpha(colore, 0.95);
    this.strokeTrack(ctx, t.fut);
    ctx.setLineDash([]);
  }

  /** Area da cui il satellite è sopra l'orizzonte. */
  drawFootprint(ctx, st, colore) {
    const lam = Math.acos(RE / (RE + st.alt));
    const f = st.lat * DEG;
    if (lam * RAD + Math.abs(st.lat) > 88) return;
    const pts = [];
    for (let a = 0; a <= 360; a += 5) {
      const th = a * DEG;
      const lat2 = Math.asin(Math.sin(f) * Math.cos(lam) + Math.cos(f) * Math.sin(lam) * Math.cos(th));
      const dl = Math.atan2(Math.sin(th) * Math.sin(lam) * Math.cos(f), Math.cos(lam) - Math.sin(f) * Math.sin(lat2));
      pts.push([dl * RAD, lat2 * RAD]);
    }
    for (const x0 of this.xs(st.lon, lam * RAD * this.scale + 4)) {
      ctx.beginPath();
      pts.forEach(([dl, la], i) => {
        const x = x0 + dl * this.scale, y = this.y(la);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = alpha(colore, 0.07); ctx.fill();
      ctx.strokeStyle = alpha(colore, 0.5); ctx.lineWidth = 1; ctx.stroke();
    }
  }

  drawPill(ctx, x, y, testo, bordo) {
    const pal = PAL[this.theme];
    ctx.font = `600 12px ${FONT}`;
    const larg = ctx.measureText(testo).width + 16;
    ctx.beginPath(); ctx.roundRect(x, y - 10, larg, 20, 10);
    ctx.fillStyle = pal.pill; ctx.fill();
    ctx.strokeStyle = alpha(bordo, 0.7); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = pal.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(testo, x + 8, y + 0.5);
  }

  drawStationIcon(ctx, x, y, colore) {
    const alone = ctx.createRadialGradient(x, y, 0, x, y, 18);
    alone.addColorStop(0, alpha(colore, 0.5)); alone.addColorStop(1, alpha(colore, 0));
    ctx.fillStyle = alone; ctx.beginPath(); ctx.arc(x, y, 18, 0, TAU); ctx.fill();
    ctx.fillStyle = colore;                       // pannelli solari
    ctx.fillRect(x - 11, y - 3.5, 6.5, 7); ctx.fillRect(x + 4.5, y - 3.5, 6.5, 7);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x - 4.5, y); ctx.lineTo(x + 4.5, y); ctx.stroke();
    ctx.fillStyle = '#ffffff';                    // modulo centrale
    ctx.beginPath(); ctx.roundRect(x - 2.5, y - 5.5, 5, 11, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.8; ctx.stroke();
  }

  drawLive(ms) {
    const ctx = this.lctx, { w, h, dpr } = this, s = this.scale, pal = PAL[this.theme];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    const dash = -((ms / 1000) * 16) % 13;        // fa scorrere il tratteggio nel verso del moto
    const giro = 360 * s;
    const ingr = 1 + 0.22 * Math.log2(this.zoom);
    const futuro = Number(settings.lunghezzaTracce) || 0.08;
    const chiave = `0|${futuro}`;
    let daRifare = 8;                              // traiettorie ricalcolate al massimo per fotogramma

    // 1. traiettorie tratteggiate delle costellazioni
    for (const g of GROUPS) {
      const st = g.state;
      if (!st.on || !st.loaded || !st.tracks || g.big || g.id === 'stations') continue;
      const colore = themeColor(g);
      ctx.setLineDash([5, 6]); ctx.lineDashOffset = dash; ctx.lineWidth = 1.2;
      ctx.strokeStyle = alpha(colore, 0.62);
      for (const sat of st.sats) {
        if (sat === this.selected) continue;
        if (daRifare > 0 && (!sat.trk || sat.trk.key !== chiave || ms - sat.trk.ms > 20000)) {
          sat.trk = buildTrack(sat, ms, 0, futuro) || sat.trk; daRifare--;
        }
        if (sat.trk && sat.trk.key === chiave) this.strokeTrack(ctx, sat.trk.fut);
      }
    }
    ctx.setLineDash([]);

    // 2. satelliti (un solo tracciato per costellazione)
    const etichette = settings.etichette === 'always' || (settings.etichette === 'auto' && this.zoom >= 2.2);
    for (const g of GROUPS) {
      const st = g.state;
      if (!st.on || !st.loaded || g.id === 'stations') continue;
      // le megacostellazioni si rimpiccioliscono sulle mappe piccole, per non coprire tutto
      const colore = themeColor(g), n = st.sats.length;
      const r = g.size * ingr * (g.big ? Math.max(0.6, Math.min(1, s / 3.2)) : 1);
      const punti = (raggio) => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const lat = st.lat[i];
          if (lat !== lat) continue;
          const y = h / 2 - (lat - this.cLat) * s;
          if (y < -8 || y > h + 8) continue;
          let x = w / 2 + wrap180(st.lon[i] - this.cLon) * s;
          for (let c = x - giro > -8 ? x - giro : x; c < w + 8; c += giro) {
            if (c < -8) continue;
            if (raggio < 2.2) ctx.rect(c - raggio, y - raggio, raggio * 2, raggio * 2);
            else { ctx.moveTo(c + raggio, y); ctx.arc(c, y, raggio, 0, TAU); }
          }
        }
      };
      if (!g.big) { ctx.fillStyle = alpha(colore, 0.22); punti(r + 3); ctx.fill(); }
      ctx.fillStyle = colore; punti(r); ctx.fill();
      if (!g.big) { ctx.strokeStyle = pal.halo; ctx.lineWidth = 0.8; ctx.stroke(); }

      if (etichette && !g.big) {
        ctx.font = `11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = pal.halo; ctx.fillStyle = pal.text;
        for (let i = 0; i < n; i++) {
          const lat = st.lat[i];
          if (lat !== lat) continue;
          const y = this.y(lat);
          if (y < 0 || y > h) continue;
          for (const x of this.xs(st.lon[i], 0)) {
            ctx.strokeText(st.sats[i].short, x + r + 5, y); ctx.fillText(st.sats[i].short, x + r + 5, y);
          }
        }
      }
    }

    // 3. casa
    const casa = settings.casa, yc = this.y(casa.lat);
    for (const x of this.xs(casa.lon)) {
      ctx.fillStyle = alpha(pal.home, 0.22); ctx.beginPath(); ctx.arc(x, yc, 9, 0, TAU); ctx.fill();
      ctx.fillStyle = pal.home; ctx.beginPath(); ctx.arc(x, yc, 3.6, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4; ctx.stroke();
      if (this.zoom >= 1.8) {
        ctx.font = `600 11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = pal.halo; ctx.strokeText(casa.nome, x + 9, yc + 10);
        ctx.fillStyle = pal.text; ctx.fillText(casa.nome, x + 9, yc + 10);
      }
    }

    // 4. stazioni spaziali: scia, orbita futura, area di visibilità, icona
    const stazioni = GROUPS[0].state;
    if (stazioni.on && stazioni.loaded) {
      for (const sat of stazioni.sats) {
        const st = this.stateOf(sat, ms);
        if (!st) continue;
        const colore = themeColor(STATIONS[sat.id]);
        if (stazioni.tracks || sat === this.selected) this.drawFullTrack(ctx, sat, ms, colore, dash);
        this.drawFootprint(ctx, st, colore);
        const y = this.y(st.lat);
        for (const x of this.xs(st.lon)) {
          this.drawStationIcon(ctx, x, y, colore);
          this.drawPill(ctx, x + 16, y - 16, sat.short, colore);
        }
      }
    }

    // 5. satellite selezionato
    const sel = this.selected;
    if (sel && sel.group.state.on) {
      const st = this.stateOf(sel, ms);
      if (st) {
        const colore = themeColor(STATIONS[sel.id] || sel.group);
        const y = this.y(st.lat);
        if (sel.group.id !== 'stations') {
          this.drawFullTrack(ctx, sel, ms, colore, dash);
          if (st.alt < 2500) this.drawFootprint(ctx, st, colore);
          for (const x of this.xs(st.lon)) {
            ctx.fillStyle = colore; ctx.beginPath(); ctx.arc(x, y, Math.max(3.5, sel.group.size * ingr + 1), 0, TAU); ctx.fill();
            this.drawPill(ctx, x + 14, y - 14, sel.short, colore);
          }
        }
        for (const x of this.xs(st.lon)) {
          ctx.strokeStyle = pal.ring; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(x, y, sel.group.id === 'stations' ? 15 : 9, 0, TAU); ctx.stroke();
        }
      }
    }

    // 6. satellite sotto il puntatore
    const hov = this.hover;
    if (hov && hov !== sel && hov.group.state.on) {
      const st = hov.group.state, lat = st.lat[hov.idx];
      if (lat === lat) {
        ctx.strokeStyle = alpha(pal.ring === '#ffffff' ? '#ffffff' : '#1b1b1b', 0.85); ctx.lineWidth = 1.4;
        for (const x of this.xs(st.lon[hov.idx])) {
          ctx.beginPath(); ctx.arc(x, this.y(lat), hov.group.id === 'stations' ? 15 : 7.5, 0, TAU); ctx.stroke();
        }
      }
    }
  }
}
