// Server-Funktion supabase/functions/recipe-import/index.ts: echte Ausführung mit nachgebauten Webseiten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'recipe-import', 'index.ts'), 'utf8');

/** Lädt die Funktion; pages: URL → {status, body, url?} oder Fehler */
function fn(pages = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const p = pages[url];
    if (!p || p instanceof Error) throw p || new TypeError('fetch failed');
    const res = new Response(p.body, { status: p.status || 200, headers: { 'Content-Type': 'text/html' } });
    Object.defineProperty(res, 'url', { value: p.url || url });
    return res;
  };
  const ctx = vm.createContext({ fetch, Response, Request, URL, AbortSignal, TextDecoder, Uint8Array, JSON, String, Number, Math, Array, console, Deno: { serve() {} } });
  vm.runInContext(SRC.replace(/^export /gm, ''), ctx);
  const call = async (body, method = 'POST') => {
    const res = await ctx.handle(new Request('https://x.supabase.co/functions/v1/recipe-import', { method, body: method === 'POST' ? JSON.stringify(body) : undefined }));
    return { status: res.status, body: res.status === 200 && method === 'OPTIONS' ? null : await res.json().catch(() => null), headers: res.headers };
  };
  return { call, calls, ctx };
}
const page = ld => `<html><head><title>x</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>…</body></html>`;

test('Rezept-Import: liest schema.org/Recipe aus @graph, Abschnitte, Portionen, HTML-Reste', async () => {
  const url = 'https://www.beispiel-rezepte.de/rezept/123';
  const { call } = fn({
    [url]: { body: page({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebPage', name: 'Seite' },
      { '@type': ['Recipe'], name: 'Omas Linsensuppe &amp; Würstchen', recipeYield: ['4 Portionen'],
        recipeIngredient: ['250 g Linsen', ' 2  Karotten ', '<b>1</b> Zwiebel', ''],
        recipeInstructions: [
          { '@type': 'HowToSection', name: 'Vorbereiten', itemListElement: [{ '@type': 'HowToStep', text: 'Linsen waschen.' }, { '@type': 'HowToStep', text: 'Gemüse würfeln.' }] },
          { '@type': 'HowToStep', text: 'Alles 30 Minuten köcheln.' },
        ] },
    ] }) },
  });
  const r = await call({ url });
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'www.beispiel-rezepte.de');
  assert.deepEqual(r.body.recipe, {
    name: 'Omas Linsensuppe & Würstchen', portions: 4,
    ingredients: ['250 g Linsen', '2 Karotten', '1 Zwiebel'],
    steps: ['Linsen waschen.', 'Gemüse würfeln.', 'Alles 30 Minuten köcheln.'],
  });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('Rezept-Import: Schritte als Fließtext, mehrere JSON-LD-Blöcke, kaputter Block wird übersprungen', async () => {
  const url = 'https://rezepte.example.org/a';
  const html = `<script type="application/ld+json">{kaputt</script>${page({ '@type': 'Organization' })}${page({ '@type': 'Recipe', name: 'Pfannkuchen', recipeYield: '2', recipeIngredient: ['250 g Mehl'], recipeInstructions: 'Teig rühren.\nAusbacken.' })}`;
  const { call } = fn({ [url]: { body: html } });
  const r = await call({ url });
  assert.deepEqual(r.body.recipe.steps, ['Teig rühren.', 'Ausbacken.']);
  assert.equal(r.body.recipe.portions, 2);
});

test('Rezept-Import: nur öffentliche Webadressen, keine internen Ziele', async () => {
  const { call, calls } = fn({});
  for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.5/', 'http://[::1]/', 'ftp://example.org/x', 'https://user:pw@example.org/',
    'https://example.org:8080/', 'http://intranet/', 'http://drucker.local/', 'javascript:alert(1)', '', 42]) {
    const r = await call({ url });
    assert.equal(r.status, 400, String(url));
  }
  assert.equal(calls.length, 0); // nichts davon wurde abgerufen
  const r = await call(null);
  assert.equal(r.status, 400);
});

test('Rezept-Import: Weiterleitung auf interne Adresse, Fehlerseite, nicht erreichbar, kein Rezept', async () => {
  const { call } = fn({
    'https://a.example.org/': { body: '', url: 'http://192.168.0.1/admin' },
    'https://b.example.org/': { status: 404, body: 'weg' },
    'https://c.example.org/': new TypeError('timeout'),
    'https://d.example.org/': { body: '<html>kein Rezept hier</html>' },
  });
  assert.equal((await call({ url: 'https://a.example.org/' })).status, 400);
  assert.match((await call({ url: 'https://b.example.org/' })).body.error, /Fehler 404/);
  assert.match((await call({ url: 'https://c.example.org/' })).body.error, /nicht erreichbar/);
  const d = await call({ url: 'https://d.example.org/' });
  assert.equal(d.status, 422);
  assert.match(d.body.error, /kein Rezept/);
});

test('Rezept-Import: große Seiten werden nach 2 MB abgeschnitten, Zeitlimit gesetzt, nur POST', async () => {
  const big = 'x'.repeat(3_000_000) + page({ '@type': 'Recipe', name: 'Zu spät' });
  const { call, calls } = fn({ 'https://e.example.org/': { body: big } });
  const r = await call({ url: 'https://e.example.org/' });
  assert.equal(r.status, 422); // Rezept stand erst hinter der Grenze
  assert.ok(calls[0].opts.signal);
  assert.equal((await call(null, 'GET')).status, 405);
  assert.equal((await call(null, 'OPTIONS')).status, 200);
});
