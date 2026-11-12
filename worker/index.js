// ECHO Constellation - Worker Cloudflare della versione online.
// La pagina è servita come file statici (cartella web/); questo Worker risponde solo a
// /api/gp e fa da cache per i dati orbitali di CelesTrak, come fa ECHO Constellation.exe in locale:
// ogni costellazione viene scaricata al massimo una volta ogni due ore per tutti i visitatori.
// (È in JavaScript e non in Rust perché i Worker eseguono JavaScript in modo nativo:
// con Rust servirebbe WebAssembly, più lento ad avviarsi nei 10 ms di CPU del piano gratuito.)

const DURATA_CACHE = 2 * 3600; // secondi
const GRUPPI = new Set([
  'stations', 'starlink', 'gps-ops', 'glo-ops', 'galileo', 'beidou', 'oneweb', 'kuiper', 'iridium-NEXT',
]);

const testo = (corpo, stato, extra = {}) => new Response(corpo, {
  status: stato,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', ...extra },
});

async function scarica(gruppo) {
  const risposta = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${gruppo}&FORMAT=tle`, {
    headers: { 'User-Agent': 'echo-constellation/1.0' },
  });
  if (risposta.status === 403) {
    throw new Error('CelesTrak permette un solo scaricamento ogni due ore per costellazione e questa è già stata scaricata di recente. Riprova più tardi');
  }
  if (!risposta.ok) throw new Error(`CelesTrak ha risposto ${risposta.status}`);
  const dati = await risposta.text();
  if (!/^1 /m.test(dati) || !/^2 /m.test(dati)) throw new Error('CelesTrak ha risposto senza dati orbitali');
  return dati;
}

export default {
  async fetch(richiesta, env, ctx) {
    const url = new URL(richiesta.url);
    if (url.pathname !== '/api/gp') return testo('Non trovato', 404);
    if (richiesta.method !== 'GET') return testo('Metodo non ammesso', 405);
    const gruppo = url.searchParams.get('group') || '';
    if (!GRUPPI.has(gruppo)) return testo('Gruppo sconosciuto', 400);

    const adesso = Math.floor(Date.now() / 1000);
    const copia = await env.CACHE.getWithMetadata(gruppo, { type: 'stream' });
    const scaricato = copia.metadata?.scaricato || 0;
    const intestazioni = (quando, scaduto) => ({ 'X-Echo-Scaricato': String(quando), 'X-Echo-Scaduto': scaduto ? '1' : '0' });

    if (copia.value && adesso - scaricato < DURATA_CACHE) return testo(copia.value, 200, intestazioni(scaricato, false));
    try {
      const dati = await scarica(gruppo);
      ctx.waitUntil(env.CACHE.put(gruppo, dati, { metadata: { scaricato: adesso } }));
      return testo(dati, 200, intestazioni(adesso, false));
    } catch (errore) {
      // meglio dati vecchi che niente
      if (copia.value) return testo(copia.value, 200, intestazioni(scaricato, true));
      return testo(errore.message, 502);
    }
  },
};
