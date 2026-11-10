// Konto & Sync: zwei Geräte gegen einen nachgebauten Supabase-Server (tests/fake-supabase.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { load } = require('./harness');
const { FakeSupabase, KEY } = require('./fake-supabase');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'famos-sync-'));
execFileSync('python3', [path.join(ROOT, 'tools', 'build.py'), path.join(ROOT, 'app', 'famos.html'), OUT], {
  // so wie Supabase die Adresse auf der Data-API-Seite anzeigt; der Build kürzt den Pfad
  env: { ...process.env, SUPABASE_URL: 'https://testprojekt.supabase.co/rest/v1/', SUPABASE_PUBLISHABLE_KEY: KEY }, stdio: 'pipe',
});
const APP = path.join(OUT, 'index.html');

/** Ein Gerät; confirm() beantwortet Rückfragen mit Ja */
function device(server, opts = {}) {
  return load(APP, { ...opts, globals: { fetch: server.fetch, ...(opts.globals || {}) } });
}
async function login(a, server, email) {
  a.run(`openLogin();UI.form.email=${JSON.stringify(email)}`);
  await a.run('loginSend()');
  assert.equal(a.get('UI.form.step'), 'code');
  a.run(`UI.form.code=${JSON.stringify(server.code(email))}`);
  await a.run('loginVerify()');
}
/** Gerät A: Haushalt lokal einrichten, anmelden, in der Cloud anlegen */
async function founder(server) {
  const a = device(server);
  a.run(`openKidModal(null);UI.form.name='Emma';saveKid();openKidModal(null);UI.form.name='Ben';saveKid();ob().name='Familie Test';obFinish()`);
  a.flush();
  await login(a, server, 'a@example.org');
  assert.equal(a.get('UI.form.step'), 'household');
  await a.run('createHousehold()');
  return a;
}
async function partner(server, a) {
  const b = device(server);
  await login(b, server, 'b@example.org');
  b.run(`UI.form.joinCode=${JSON.stringify(a.get('SYNC.invite').toLowerCase().replace(/^(....)/, '$1 '))}`);
  await b.run('joinHousehold()');
  return b;
}
const sync = d => d.run('syncNow(true)');

test('Sync: ohne Konfiguration keine Konto-Funktionen, mit Konfiguration CSP nur zur Projektadresse', () => {
  const plain = load(path.join(ROOT, 'dist', 'index.html'));
  assert.equal(plain.get('SYNC_ON'), false);
  assert.doesNotMatch(plain.app(), /Anmelden/);
  const html = fs.readFileSync(APP, 'utf8');
  assert.match(html, /connect-src https:\/\/testprojekt\.supabase\.co;/);
  const a = device(new FakeSupabase());
  assert.equal(a.get('SYNC_ON'), true);
  assert.match(a.app(), /Schon ein FamOS-Konto\? Anmelden/);
});

test('Sync: Anmelden per Code, falsche Eingaben verständlich abgefangen', async () => {
  const server = new FakeSupabase();
  const a = device(server);
  a.run(`openLogin();UI.form.email='keine-mail'`);
  await a.run('loginSend()');
  assert.match(a.get('UI.form.err'), /gültige E-Mail/);
  server.rateLimited = true;
  a.run(`UI.form.email='a@example.org'`);
  await a.run('loginSend()');
  assert.match(a.get('UI.form.err'), /zu viele Anmelde-Mails/);
  server.rateLimited = false;
  await a.run('loginSend()');
  assert.equal(a.get('UI.form.step'), 'code');
  a.run(`UI.form.code='999999'`);
  await a.run('loginVerify()');
  assert.match(a.get('UI.form.err'), /stimmt nicht oder ist abgelaufen/);
  a.run(`UI.form.code='12'`);
  await a.run('loginVerify()');
  assert.match(a.get('UI.form.err'), /mindestens 6 Ziffern/);
  a.run(`UI.form.code=${JSON.stringify(server.code('a@example.org'))}`);
  await a.run('loginVerify()');
  assert.equal(a.get('AUTH.user.email'), 'a@example.org');
  assert.ok(a.saved('famos_auth').refresh_token);
  assert.equal(a.get('UI.form.step'), 'household'); // noch kein Haushalt
  assert.doesNotMatch(a.els.mc.innerHTML, /Neuen Haushalt in der Cloud/); // ohne lokalen Haushalt erst einrichten
});

test('Sync: Haushalt anlegen lädt alle Daten hoch, Einladungscode erscheint', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  assert.equal(a.get('SYNC.role'), 'owner');
  assert.match(a.get('SYNC.invite'), /^[A-Z0-9]{8}$/);
  assert.deepEqual(server.docs.map(d => d.key).sort(), ['cfg', 'day', 'savings', 'tgd', 'tx']);
  const cfg = server.docs.find(d => d.key === 'cfg').data;
  assert.deepEqual(cfg.kids.map(k => k.name), ['Emma', 'Ben']);
  assert.equal(cfg.installHintDone, undefined); // gerätebezogen, bleibt lokal
  assert.deepEqual(cfg.einkauf, { recent: [] }); // Einkauf läuft zeilenweise
  assert.match(a.app(), /☁️ synchron/);
  a.run(`openAdmin();setATab('konto')`);
  assert.match(a.adm(), /Familie Test/);
  assert.match(a.adm(), new RegExp(a.get('SYNC.invite').slice(0, 4) + ' '));
});

test('Sync: zweites Gerät tritt mit Code bei und bekommt alle Daten', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  a.run(`togTgAktiv(S.kids[0].id);bookSavings(S.kids[0].id,5,'Oma')`);
  await sync(a);
  const b = await partner(server, a);
  assert.equal(b.get('SYNC.role'), 'adult');
  assert.deepEqual(b.get('S.kids'), a.get('S.kids'));
  assert.deepEqual(b.get('SAVINGS'), a.get('SAVINGS'));
  assert.deepEqual(b.get('TX'), a.get('TX'));
  assert.equal(b.get('S.household.name'), 'Familie Test');
  assert.match(b.app(), /Emma/);
});

test('Sync: Änderungen kommen auf dem anderen Gerät an, Haken des Tages werden zusammengeführt', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const b = await partner(server, a);
  a.run(`openKidModal(null);UI.form.name='Mia';saveKid()`);
  await sync(a); await sync(b);
  assert.deepEqual(b.get('S.kids.map(k=>k.name)'), ['Emma', 'Ben', 'Mia']);
  // Beide haken gleichzeitig unterschiedliche Aufgaben ab
  const kid = a.get('S.kids[0].id'), [t1, t2] = a.get(`kidTasks('morgen','${kid}')`).map(t => t.id);
  a.run(`toggleTask('morgen','${kid}','${t1}')`);
  b.run(`toggleTask('morgen','${kid}','${t2}')`);
  await sync(a); await sync(b); await sync(a);
  for (const d of [a, b]) assert.equal(d.get(`doneCount('morgen','${kid}')`), 2);
});

test('Sync: Einkaufsliste live auf beiden Handys, gleichzeitige Einträge gehen nicht verloren', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const b = await partner(server, a);
  server.offline = true; // beide tippen im Funkloch
  a.run(`UI.ekNew='Milch';ekAddInput()`);
  b.run(`UI.ekNew='Brot';ekAddInput()`);
  await sync(a);
  assert.equal(a.get('SYNC.status'), 'offline');
  assert.match(a.app(), /📴 offline/);
  server.offline = false;
  await sync(a); await sync(b); await sync(a);
  for (const d of [a, b]) assert.deepEqual(d.get('S.einkauf.items.map(x=>x.name)').sort(), ['Brot', 'Milch']);
  b.run(`ekToggle(S.einkauf.items.find(x=>x.name==='Milch').id)`);
  await sync(b); await sync(a);
  assert.equal(a.get(`S.einkauf.items.find(x=>x.name==='Milch').done`), true);
  a.run('ekClearDone()');
  await sync(a); await sync(b);
  assert.deepEqual(b.get('S.einkauf.items.map(x=>x.name)'), ['Brot']);
  assert.equal(server.items.length, 1);
});

test('Sync: Buchungen von zwei Geräten werden zusammengeführt, Einstellungen-Konflikt nimmt den Cloud-Stand', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const b = await partner(server, a);
  const kid = a.get('S.kids[0].id');
  a.run(`bookSavings('${kid}',3,'von A')`);
  b.run(`bookSavings('${kid}',4,'von B')`);
  await sync(a); await sync(b); await sync(a);
  for (const d of [a, b]) assert.deepEqual(d.get('TX.map(x=>x.note)').sort(), ['von A', 'von B']);
  // gleichzeitige Änderung an den Einstellungen: der zweite bekommt einen Hinweis und den Cloud-Stand
  a.run(`S.household.name='Name A';saveCfg()`);
  b.run(`S.household.name='Name B';saveCfg()`);
  await sync(a); await sync(b);
  assert.equal(b.get('S.household.name'), 'Name A');
  assert.match(b.toast(), /anderen Gerät/);
});

test('Sync: abgelaufene Sitzung wird still erneuert, ungültige führt zur Abmeldung ohne Datenverlust', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  server.expireTokens();
  a.run(`openKidModal(null);UI.form.name='Mia';saveKid()`);
  await sync(a);
  assert.equal(a.get('SYNC.status'), 'ok');
  assert.ok(server.docs.find(d => d.key === 'cfg').data.kids.some(k => k.name === 'Mia'));
  server.expireTokens(); server.revokeRefresh();
  await sync(a);
  assert.equal(a.get('AUTH'), null);
  assert.match(a.toast(), /neu anmelden/);
  assert.equal(a.get('S.kids.length'), 3); // lokal alles da
});

test('Sync: Abmelden behält die Daten, Besitzer löscht den Haushalt, Mitglied verliert den Zugriff', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const b = await partner(server, a);
  await b.run('logout()');
  assert.equal(b.get('AUTH'), null);
  assert.equal(b.get('SYNC.hid'), null);
  assert.equal(b.get('S.kids.length'), 2);
  const c = await partner(server, a);
  await a.run('leaveHousehold()');
  assert.equal(server.households.length, 0);
  assert.equal(server.docs.length, 0);
  c.run(`S.household.name='Noch da';saveCfg()`);
  await sync(c);
  assert.equal(c.get('SYNC.hid'), null);
  assert.match(c.toast(), /Kein Zugriff mehr/);
  assert.equal(c.get('S.household.name'), 'Noch da');
});

test('Sync: Einladungscode erneuern und falschen Code abfangen', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const old = a.get('SYNC.invite');
  await a.run('rotateInvite()');
  assert.notEqual(a.get('SYNC.invite'), old);
  const b = device(server);
  await login(b, server, 'b@example.org');
  b.run(`UI.form.joinCode=${JSON.stringify(old)}`);
  await b.run('joinHousehold()');
  assert.match(b.get('UI.form.err'), /gibt es nicht/);
  b.run(`UI.form.joinCode='ABC'`);
  await b.run('joinHousehold()');
  assert.match(b.get('UI.form.err'), /8 Zeichen/);
});

test('Sync: Anmeldung auf einem Gerät mit bestehendem Cloud-Haushalt verbindet sofort', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const a2 = device(server); // A auf neuem Handy
  await login(a2, server, 'a@example.org');
  assert.equal(a2.get('SYNC.hid'), a.get('SYNC.hid'));
  assert.deepEqual(a2.get('S.kids.map(k=>k.name)'), ['Emma', 'Ben']);
  assert.match(a2.toast(), /Angemeldet und verbunden/);
});

test('Sync: Anmelden mit kopiertem Link aus der Mail (ohne Code), fremde Links werden abgelehnt', async () => {
  const server = new FakeSupabase();
  const a = device(server);
  a.run(`openLogin();UI.form.email='a@example.org'`);
  await a.run('loginSend()');
  assert.match(a.els.mc.innerHTML, /Kein Code, nur ein Link/);
  for (const bad of ['https://evil.example/auth/v1/verify?token=abcdefghijkl&type=signup', 'kein link', 'https://testprojekt.supabase.co/auth/v1/verify?token=<x>&type=signup']) {
    a.run(`UI.form.code='';UI.form.link=${JSON.stringify(bad)}`);
    await a.run('loginVerify()');
    assert.match(a.get('UI.form.err'), /kein FamOS-Anmeldelink/, bad);
  }
  a.run(`UI.form.link=${JSON.stringify(server.link('a@example.org'))}`);
  await a.run('loginVerify()');
  assert.equal(a.get('AUTH.user.email'), 'a@example.org');
  assert.equal(a.get('UI.form.step'), 'household');
  // derselbe Link ein zweites Mal: verbraucht
  const b = device(server);
  b.run(`openLogin();UI.form.email='a@example.org';UI.form.step='code';UI.form.link='https://testprojekt.supabase.co/auth/v1/verify?token=pkhverbraucht123&type=magiclink'`);
  await b.run('loginVerify()');
  assert.match(b.get('UI.form.err'), /abgelaufen oder wurde schon benutzt/);
});
