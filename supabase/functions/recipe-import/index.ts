// FamOS: Rezept von einer Webseite übernehmen – ohne KI.
// Liest die strukturierten Rezeptdaten (schema.org/Recipe als JSON-LD), die fast alle Rezeptseiten mitliefern.
// Speichert nichts. Aufruf nur mit gültiger Anmeldung (Supabase prüft das JWT, "Verify JWT" bleibt an).
// Einrichtung: Supabase → Edge Functions → Deploy a new function → Via Editor → Name "recipe-import" → diesen Code einfügen.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 8000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Nur normale öffentliche Webadressen: kein localhost, keine IP-Adressen, keine Sonderports, keine Zugangsdaten in der URL
export function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost|lan|home|corp)$/.test(h)) return null;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;
  return u;
}

export function findRecipe(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const t = node['@type'];
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return node;
  if (node['@graph']) return findRecipe(node['@graph']);
  if (node.mainEntity) return findRecipe(node.mainEntity);
  return null;
}

function clean(v) {
  return String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

function steps(v) {
  const out = [];
  const walk = x => {
    if (!x) return;
    if (typeof x === 'string') { x.split(/\n+/).forEach(l => { const c = clean(l); if (c) out.push(c); }); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.itemListElement) walk(x.itemListElement);
    else if (x.text) walk(String(x.text));
    else if (x.name) walk(String(x.name));
  };
  walk(v);
  return out;
}

function portions(v) {
  const m = String(Array.isArray(v) ? v[0] : (v ?? '')).match(/\d+/);
  return m ? Math.min(20, Math.max(1, Number(m[0]))) : 4;
}

export function extract(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const r = findRecipe(data);
    if (!r) continue;
    const name = clean(r.name).slice(0, 60);
    if (!name) continue;
    return {
      name,
      ingredients: (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : []).map(clean).filter(Boolean).slice(0, 60).map(s => s.slice(0, 80)),
      steps: steps(r.recipeInstructions).slice(0, 30).map(s => s.slice(0, 300)),
      portions: portions(r.recipeYield),
    };
  }
  return null;
}

async function readLimited(res) {
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { try { await reader.cancel(); } catch { /* egal */ } break; }
    parts.push(value);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return new TextDecoder().decode(all);
}

export async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt.' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Ungültige Anfrage.' }, 400); }
  const u = checkUrl(body?.url);
  if (!u) return json({ error: 'Bitte einen normalen Link angeben (https://…).' }, 400);
  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FamOS-Rezeptimport)', Accept: 'text/html' },
    });
  } catch { return json({ error: 'Die Seite war nicht erreichbar.' }, 502); }
  if (res.url && !checkUrl(res.url)) return json({ error: 'Die Seite leitet auf eine unzulässige Adresse um.' }, 400);
  if (!res.ok) return json({ error: `Die Seite antwortet mit Fehler ${res.status}.` }, 502);
  const recipe = extract(await readLimited(res));
  if (!recipe) return json({ error: 'Auf dieser Seite wurde kein Rezept gefunden.' }, 422);
  return json({ ok: true, recipe, source: u.hostname });
}

Deno.serve(handle);
