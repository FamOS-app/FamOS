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
// eigener Build ohne Sync (nicht dist/: das baut famos.test.js parallel neu)
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'famos-plain-'));
execFileSync('python3', [path.join(ROOT, 'tools', 'build.py'), path.join(ROOT, 'app', 'famos.html'), PLAIN], {
  env: { ...process.env, SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '' }, stdio: 'pipe',
});

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
async function founder(server, opts, email = 'a@example.org') {
  const a = device(server, opts);
  a.run(`openKidModal(null);UI.form.name='Emma';saveKid();openKidModal(null);UI.form.name='Ben';saveKid();ob().name='Familie Test';obFinish()`);
  a.flush();
  await login(a, server, email);
  assert.equal(a.get('UI.form.step'), 'household');
  await a.run('createHousehold()');
  return a;
}
async function partner(server, a, opts) {
  const b = device(server, opts);
  await login(b, server, 'b@example.org');
  b.run(`UI.form.joinCode=${JSON.stringify(a.get('SYNC.invite').toLowerCase().replace(/^(....)/, '$1 '))}`);
  await b.run('joinHousehold()');
  return b;
}
const sync = d => d.run('syncNow(true)');

test('Sync: ohne Konfiguration keine Konto-Funktionen, mit Konfiguration CSP nur zur Projektadresse', () => {
  const plain = load(path.join(PLAIN, 'index.html'));
  assert.equal(plain.get('SYNC_ON'), false);
  assert.doesNotMatch(plain.app(), /Anmelden/);
  const html = fs.readFileSync(APP, 'utf8');
  assert.match(html, /connect-src https:\/\/testprojekt\.supabase\.co wss:\/\/testprojekt\.supabase\.co;/);
  const a = device(new FakeSupabase());
  assert.equal(a.get('SYNC_ON'), true);
  assert.match(a.app(), /Eingeladen\?[\s\S]*onclick="openLogin\(\)">☁️ Anmelden und beitreten[\s\S]*Oder neu starten[\s\S]*Name des Haushalts/); // Beitreten steht vor dem Neuanlegen
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
  assert.equal(cfg.einkauf.items, undefined); // Einkauf läuft zeilenweise
  assert.deepEqual(cfg.einkauf.std, []);
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
  assert.match(a.els.mc.innerHTML, /E-Mail bestätigen[\s\S]*Link in der Mail antippen[\s\S]*id="lgLink"[\s\S]*id="lgCode"/); // Link ist der Normalfall, Code nur Zusatz
  assert.doesNotMatch(a.els.mc.innerHTML, /Code schicken|Code eingeben/);
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

test('Sync: Haushalt aus den Einstellungen anlegen zeigt danach sofort den Einladungscode', async () => {
  const server = new FakeSupabase();
  const a = device(server);
  a.run(`openKidModal(null);UI.form.name='Emma';saveKid();obFinish()`); a.flush();
  a.run(`closeModal();openAdmin();setATab('konto')`);
  assert.match(a.adm(), /Noch nicht angemeldet/);
  await login(a, server, 'a@example.org');
  assert.match(a.adm(), /noch mit keinem Haushalt verbunden/);
  await a.run('createHousehold()');
  assert.doesNotMatch(a.adm(), /noch mit keinem Haushalt verbunden/);
  assert.match(a.adm(), new RegExp(a.get('SYNC.invite').slice(0, 4) + ' ' + a.get('SYNC.invite').slice(4)));
  // zweimal tippen legt keinen zweiten Haushalt an
  await a.run('createHousehold()');
  assert.equal(server.households.length, 1);
});

// ─── Sofort-Übertragung ───────────────────────────────────────
const live = server => ({ globals: { WebSocket: server.WebSocket } });
async function settle(...ds) { for (let i = 0; i < 6; i++) { await new Promise(r => setImmediate(r)); ds.forEach(d => d.flush()); } }

test('Live: Änderung erscheint auf dem anderen Handy ohne Abfrage', async () => {
  const server = new FakeSupabase();
  const a = await founder(server, live(server));
  const b = await partner(server, a, live(server));
  await settle(a, b);
  assert.equal(a.get('RT.joined'), true);
  assert.equal(b.get('RT.joined'), true);
  const sock = server.sockets.find(x => x.hid === a.get('SYNC.hid'));
  assert.match(sock.url, /^wss:\/\/testprojekt\.supabase\.co\/realtime\/v1\/websocket\?apikey=sb_publishable_test&vsn=1\.0\.0$/);
  const fetchesB = () => server.log.length;
  a.run(`UI.ekNew='Milch';ekAddInput()`);
  await settle(a, b); // A lädt hoch, Server meldet, B holt ab
  assert.deepEqual(b.get('S.einkauf.items.map(x=>x.name)'), ['Milch']);
  a.run(`openKidModal(null);UI.form.name='Mia';saveKid()`);
  await settle(a, b);
  assert.deepEqual(b.get('S.kids.map(k=>k.name)'), ['Emma', 'Ben', 'Mia']);
  b.run(`openAdmin();setATab('konto')`);
  assert.match(b.adm(), /Sofort-Übertragung aktiv/);
  assert.ok(fetchesB() > 0);
});

test('Live: fremder Haushalt wird beim Verbinden abgelehnt', async () => {
  const server = new FakeSupabase();
  const a = await founder(server, live(server));
  const fremd = await founder(server, live(server), 'fremd@example.org');
  await settle(a, fremd);
  fremd.run(`rtStop();SYNC.hid=${JSON.stringify(a.get('SYNC.hid'))};rtStart()`);
  await settle(fremd);
  assert.equal(fremd.get('RT.joined'), false);
});

test('Live: abgerissene Verbindung baut sich neu auf, ohne Realtime bleibt die Abfrage', async () => {
  const server = new FakeSupabase();
  const a = await founder(server, live(server));
  await settle(a);
  server.sockets[0].drop();
  await settle(a);
  assert.equal(a.get('RT.joined'), true);
  assert.equal(server.sockets.length, 1);
  // Realtime gesperrt: App bleibt bedienbar und gleicht per Abfrage ab
  server.realtimeDown = true;
  server.sockets[0].drop();
  await settle(a);
  assert.equal(a.get('RT.joined'), false);
  a.run(`UI.ekNew='Brot';ekAddInput()`);
  await a.run('syncNow(true)');
  assert.deepEqual(server.items.map(x => x.name), ['Brot']);
});

test('Live: Abmelden schließt die Verbindung, erneuerte Sitzung geht an die Verbindung', async () => {
  const server = new FakeSupabase();
  const a = await founder(server, live(server));
  await settle(a);
  server.expireTokens();
  await a.run('refreshToken()');
  assert.ok(server.sockets[0].sent.some(m => m.event === 'access_token'));
  await a.run('logout()');
  await settle(a);
  assert.equal(server.sockets.length, 0);
  assert.equal(a.get('RT.ws'), null);
});

test('Sync: Standardliste und Bereichs-Zuordnungen gelten auf beiden Handys', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const b = await partner(server, a);
  a.run(`UI.ekStd='5 l Milch\\n10 Eier';saveEkStd();S.einkauf.cats.geschenkpapier='haushalt';ekMoveCat(8,-1);saveCfg()`);
  await sync(a); await sync(b);
  assert.deepEqual(b.get('S.einkauf.std'), ['5 l Milch', '10 Eier']);
  assert.equal(b.get(`ekCat('Geschenkpapier')`), 'haushalt');
  assert.deepEqual(b.get('S.einkauf.order'), a.get('S.einkauf.order'));
});

test('Link-Import: Rezept über die Server-Funktion, verständliche Fehler', async () => {
  const server = new FakeSupabase();
  const a = device(server);
  a.run(`openLinkImport()`);
  assert.match(a.els.mc.innerHTML, /braucht es die Anmeldung/);
  const b = await founder(server);
  b.run(`closeModal();openLinkImport();UI.form.url='kein link'`);
  await b.run('runLinkImport()');
  assert.match(b.get('UI.form.err'), /vollständigen Link/);
  b.run(`UI.form.url='https://www.beispiel.de/rezept'`);
  await b.run('runLinkImport()');
  assert.match(b.get('UI.form.err'), /noch nicht eingerichtet/);
  server.recipeFn = url => url.endsWith('/rezept') ? { name: 'Pfannkuchen', ingredients: ['250 g Mehl', '3 Eier'], steps: ['Rühren', 'Ausbacken'], portions: 2 } : null;
  await b.run('runLinkImport()');
  const f = b.get('UI.form');
  assert.equal(f.mode, 'dish');
  assert.deepEqual([f.name, f.ingr, f.steps, f.portions], ['Pfannkuchen', '250 g Mehl\n3 Eier', 'Rühren\nAusbacken', 2]);
  b.run(`openLinkImport();UI.form.url='https://www.beispiel.de/kein'`);
  await b.run('runLinkImport()');
  assert.match(b.get('UI.form.err'), /kein Rezept gefunden/);
});

test('Sync: Aufgaben live auf beiden Handys, Abhaken und Wiederholung kommen an', async () => {
  const server = new FakeSupabase();
  const a = await founder(server, live(server));
  const b = await partner(server, a, live(server));
  await settle(a, b);
  a.run(`setView('aufgaben');UI.todoNew='Müll rausbringen';addTodoInput()`);
  const id = a.get('S.aufgaben.items[0].id');
  a.run(`openTodo('${id}');UI.form.rep='w';UI.form.who=[S.kids[0].id];saveTodo()`);
  await settle(a, b);
  assert.equal(server.tasks.length, 1);
  assert.deepEqual(server.tasks[0].who, [a.get('S.kids[0].id')]);
  assert.equal(b.get('S.aufgaben.items[0].title'), 'Müll rausbringen');
  assert.equal(b.get('S.aufgaben.items[0].rep'), 'w');
  const due0 = b.get('S.aufgaben.items[0].due');
  b.run(`toggleTodo('${id}')`);
  await settle(a, b);
  assert.notEqual(a.get('S.aufgaben.items[0].due'), due0);
  b.run(`openTodo('${id}');delTodo()`);
  await settle(a, b);
  assert.deepEqual(a.get('S.aufgaben.items'), []);
  assert.equal(server.tasks.length, 0);
});

test('Sync: ohne Aufgaben-Tabelle (003 noch nicht eingespielt) läuft der Rest weiter', async () => {
  const server = new FakeSupabase();
  server.noTasks = true;
  const a = await founder(server);
  a.run(`setView('aufgaben');UI.todoNew='Steuer';addTodoInput();UI.ekNew='Milch';ekAddInput()`);
  await sync(a);
  assert.equal(a.get('SYNC.status'), 'ok');
  assert.deepEqual(server.items.map(x => x.name), ['Milch']); // Einkauf läuft trotzdem
  assert.deepEqual(a.get('S.aufgaben.items.map(t=>t.title)'), ['Steuer']); // Aufgabe bleibt lokal
  server.noTasks = false; // 003 eingespielt
  await sync(a);
  assert.deepEqual(server.tasks.map(t => t.title), ['Steuer']); // wird nachgeliefert
  assert.deepEqual(a.get('S.aufgaben.items.map(t=>t.title)'), ['Steuer']);
});

test('Sync: Wunschliste kommt auf dem anderen Handy an', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const b = await partner(server, a);
  a.run(`setView('wuensche');UI.wishNew='Fahrrad';addWishInput(S.kids[0].id)`);
  await sync(a); await sync(b);
  assert.deepEqual(b.get('S.wuensche.items.map(w=>w.title)'), ['Fahrrad']);
});

test('Sync: Registrierung gesperrt – Unbekannte bekommen eine verständliche Meldung, Bekannte kommen rein', async () => {
  const server = new FakeSupabase();
  const a = await founder(server); // bereits registriert
  server.signupsDisabled = true;
  const x = device(server);
  x.run(`openLogin();UI.form.email='fremd@example.org'`);
  await x.run('loginSend()');
  assert.match(x.get('UI.form.err'), /nicht freigeschaltet/);
  assert.match(x.get('UI.form.err'), /vollständig auf diesem Gerät/);
  assert.equal(x.get('UI.form.step'), 'email');
  const a2 = device(server);
  await login(a2, server, 'a@example.org');
  assert.equal(a2.get('SYNC.hid'), a.get('SYNC.hid'));
});

test('Sync: ohne Konto steht vorab, dass FamOS lokal voll funktioniert und wie man an Sync kommt', () => {
  const server = new FakeSupabase();
  const window = { location: { protocol: 'https:', hostname: 'beispiel-familie.github.io', pathname: '/FamOS/', hash: '', search: '' }, addEventListener() {}, matchMedia: () => ({ matches: false }), navigator: {} };
  const x = device(server, { globals: { window, navigator: { serviceWorker: { register: () => Promise.resolve() } } } });
  x.run(`openKidModal(null);UI.form.name='Emma';saveKid();obFinish();closeModal();openAdmin();setATab('konto')`); x.flush();
  assert.match(x.adm(), /Nur für freigeschaltete Haushalte[\s\S]*vollständig auf diesem Gerät/);
  assert.match(x.adm(), /href="https:\/\/github\.com\/beispiel-familie\/FamOS#eigene-instanz-einrichten" target="_blank" rel="noopener noreferrer"/);
  const y = device(server); // lokal geöffnet: kein Link, nur Text
  y.run(`openLogin()`);
  assert.match(y.els.mc.innerHTML, /oder eine eigene Instanz einrichten\./);
  x.run('openLogin()');
  assert.match(x.els.mc.innerHTML, /Nur für freigeschaltete Haushalte/);
});

test('Sync: Termine live auf beiden Handys, Ändern und Löschen kommen an', async () => {
  const server = new FakeSupabase();
  const a = await founder(server, live(server));
  const b = await partner(server, a, live(server));
  await settle(a, b);
  const td = a.get('today()');
  a.run(`setView('kalender');openCal();Object.assign(UI.form,{title:'Kinderarzt',day:'${td}',from:'15:30',to:'16:00',place:'Praxis',who:[S.kids[0].id]});saveCal()`);
  b.run(`setView('kalender');openCal();Object.assign(UI.form,{title:'Urlaub',day:'${td}',end:addDays('${td}',7)});saveCal()`);
  await settle(a, b);
  assert.equal(server.events.length, 2);
  const row = server.events.find(e => e.title === 'Kinderarzt');
  assert.deepEqual([row.day, row.end_day, row.t_from, row.t_to, row.place, row.rep, row.who], [td, null, '15:30', '16:00', 'Praxis', '', [a.get('S.kids[0].id')]]);
  // gleichzeitig angelegt: beide Termine bleiben (zeilenweise, kein „Cloud gewinnt“)
  for (const d of [a, b]) assert.deepEqual(d.get('S.kalender.items.map(e=>e.title).sort()'), ['Kinderarzt', 'Urlaub']);
  assert.match(a.app(), /Urlaub/);
  const id = row.id;
  b.run(`openCal('${id}');UI.form.rep='w';UI.form.from='16:00';UI.form.to='';saveCal()`);
  await settle(a, b);
  assert.deepEqual(a.get(`(e=>[e.rep,e.from,e.to])(S.kalender.items.find(e=>e.id==='${id}'))`), ['w', '16:00', '']);
  a.run(`openCal('${id}');delCal()`);
  await settle(a, b);
  assert.deepEqual(b.get('S.kalender.items.map(e=>e.title)'), ['Urlaub']);
  assert.equal(server.events.length, 1);
  // Termine stecken nicht im Einstellungs-Dokument
  assert.equal(server.docs.find(d => d.key === 'cfg').data.kalender, undefined);
});

test('Sync: ohne Termin-Tabelle (004 noch nicht eingespielt) läuft der Rest weiter, auch die Sofort-Übertragung', async () => {
  const server = new FakeSupabase();
  server.noEvents = true;
  const a = await founder(server, live(server));
  const b = await partner(server, a, live(server));
  await settle(a, b);
  assert.equal(a.get('RT.joined'), true); // events wird noch nicht abonniert, sonst scheitert die Verbindung
  const td = a.get('today()');
  a.run(`openCal();Object.assign(UI.form,{title:'Elternabend',day:'${td}'});saveCal();UI.todoNew='Steuer';addTodoInput();UI.ekNew='Milch';ekAddInput()`);
  await settle(a, b);
  assert.equal(a.get('SYNC.status'), 'ok');
  assert.deepEqual(server.items.map(x => x.name), ['Milch']);
  assert.deepEqual(server.tasks.map(x => x.title), ['Steuer']);
  assert.deepEqual(b.get('S.aufgaben.items.map(t=>t.title)'), ['Steuer']); // live angekommen
  assert.deepEqual(a.get('S.kalender.items.map(e=>e.title)'), ['Elternabend']); // Termin bleibt lokal
  assert.deepEqual(b.get('S.kalender.items'), []);
  server.noEvents = false; // 004 eingespielt
  await sync(a); await settle(a, b);
  assert.deepEqual(server.events.map(e => e.title), ['Elternabend']); // wird nachgeliefert
  await sync(b); await settle(a, b);
  assert.deepEqual(b.get('S.kalender.items.map(e=>e.title)'), ['Elternabend']);
  // danach ist events im Abo beider Geräte und Änderungen kommen sofort
  for (const d of [a, b]) assert.equal(d.get('RT.joined'), true);
  assert.ok(server.sockets.every(s => s.sent.find(m => m.event === 'phx_join').payload.config.postgres_changes.some(c => c.table === 'events')));
  b.run(`openCal();Object.assign(UI.form,{title:'Laternenfest',day:'${td}'});saveCal()`);
  await settle(a, b);
  assert.deepEqual(a.get('S.kalender.items.map(e=>e.title).sort()'), ['Elternabend', 'Laternenfest']);
});

test('Sync: Beitritt übernimmt die Termine des Haushalts, Kalender aus heißt kein Abruf', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  const td = a.get('today()');
  a.run(`openCal();Object.assign(UI.form,{title:'Geburtstag',day:'${td}',rep:'y'});saveCal()`);
  await sync(a);
  const b = await partner(server, a);
  await sync(b);
  assert.deepEqual(b.get('S.kalender.items.map(e=>[e.title,e.rep])'), [['Geburtstag', 'y']]);
  b.run(`togModule('kalender')`);
  await sync(b);
  server.log.length = 0;
  await sync(b);
  assert.ok(!server.log.some(l => l.includes('/rest/v1/events')));
  assert.ok(server.log.some(l => l.includes('/rest/v1/tasks')));
});

test('Sync: Anmelden mit Passwort ganz ohne Mail, Beitritt per Einladungscode', async () => {
  const server = new FakeSupabase();
  const a = await founder(server);
  server.rateLimited = true; // Mailversand am Limit: Code-Anmeldung geht nicht
  server.signupsDisabled = true;
  server.addUser('b@example.org', 'geheim-Passwort-1'); // im Supabase-Dashboard angelegt
  const b = device(server);
  b.run(`openLogin();UI.form.email='b@example.org'`);
  await b.run('loginSend()');
  assert.match(b.get('UI.form.err'), /zu viele Anmelde-Mails/i);
  b.run(`UI.form.step='pw';UI.form.err='';openModal()`);
  assert.match(b.els.mc.innerHTML, /type="password" autocomplete="current-password"/);
  // falsche Eingaben
  await b.run('loginPassword()');
  assert.match(b.get('UI.form.err'), /Passwort eingeben/);
  b.run(`UI.form.pw='falsch'`);
  await b.run('loginPassword()');
  assert.match(b.get('UI.form.err'), /E-Mail-Adresse oder Passwort stimmt nicht/);
  assert.equal(b.get('UI.form.pw'), ''); // nach dem Versuch geleert
  b.run(`UI.form.email='unbekannt@example.org';UI.form.pw='geheim-Passwort-1'`);
  await b.run('loginPassword()');
  assert.match(b.get('UI.form.err'), /E-Mail-Adresse oder Passwort stimmt nicht/); // verrät nicht, ob es die Adresse gibt
  assert.equal(b.get('AUTH'), null);
  // richtig
  b.run(`UI.form.email=' b@example.org ';UI.form.pw='geheim-Passwort-1'`);
  await b.run('loginPassword()');
  assert.equal(b.get('AUTH.user.email'), 'b@example.org');
  assert.equal(b.get('UI.form.step'), 'household');
  b.run(`UI.form.joinCode=${JSON.stringify(a.get('SYNC.invite'))}`);
  await b.run('joinHousehold()');
  await sync(b);
  assert.deepEqual(b.get('S.kids.map(k=>k.name)'), ['Emma', 'Ben']);
  // das Passwort liegt nirgends auf dem Gerät
  assert.doesNotMatch(JSON.stringify(b.store), /geheim-Passwort-1/);
  assert.doesNotMatch(JSON.stringify(b.get('UI.form')), /geheim-Passwort-1/);
  // unbestätigtes Konto
  server.addUser('c@example.org', 'geheim-Passwort-2', { unconfirmed: true });
  const c = device(server);
  c.run(`openLogin();UI.form.step='pw';UI.form.email='c@example.org';UI.form.pw='geheim-Passwort-2'`);
  await c.run('loginPassword()');
  assert.match(c.get('UI.form.err'), /noch nicht bestätigt/);
});

test('Sync: Passwort festlegen und ändern, danach Anmeldung mit dem neuen Passwort', async () => {
  const server = new FakeSupabase();
  const a = await founder(server); // per Mail-Code angemeldet, noch ohne Passwort
  a.run(`UI.aTab='konto';renderAdmin()`);
  assert.match(a.adm(), /onclick="openPwChange\(\)"/);
  a.run('openPwChange()');
  const tryPw = async (p1, p2) => { a.run(`UI.form.p1=${JSON.stringify(p1)};UI.form.p2=${JSON.stringify(p2)}`); await a.run('savePwChange()'); };
  await tryPw('kurz', 'kurz');
  assert.match(a.get('UI.form.err'), /mindestens 8 Zeichen/);
  await tryPw('lang-genug-1', 'lang-genug-2');
  assert.match(a.get('UI.form.err'), /stimmen nicht überein/);
  assert.equal(server.users['a@example.org'].password, undefined);
  await tryPw('lang-genug-1', 'lang-genug-1');
  assert.equal(server.users['a@example.org'].password, 'lang-genug-1');
  assert.match(a.toast(), /Passwort gespeichert/);
  assert.doesNotMatch(JSON.stringify(a.store), /lang-genug-1/);
  // ändern: gleiches Passwort wird abgelehnt, neues gilt
  a.run('openPwChange()');
  await tryPw('lang-genug-1', 'lang-genug-1');
  assert.match(a.get('UI.form.err'), /dasselbe wie das alte/);
  await tryPw('ganz-anders-22', 'ganz-anders-22');
  assert.equal(server.users['a@example.org'].password, 'ganz-anders-22');
  const d = device(server);
  d.run(`openLogin();UI.form.step='pw';UI.form.email='a@example.org';UI.form.pw='lang-genug-1'`);
  await d.run('loginPassword()');
  assert.match(d.get('UI.form.err'), /stimmt nicht/); // altes Passwort gilt nicht mehr
  d.run(`UI.form.pw='ganz-anders-22'`);
  await d.run('loginPassword()');
  assert.equal(d.get('SYNC.hid'), a.get('SYNC.hid')); // bestehender Haushalt wird sofort verbunden
  // ohne Anmeldung kein Passwort-Dialog und kein Aufruf
  const e = device(server);
  e.run('openPwChange()');
  assert.notEqual(e.get('UI.form?.mode'), 'pwChange');
  server.expireTokens(); server.revokeRefresh();
  a.run('openPwChange()');
  await tryPw('noch-ein-neues-3', 'noch-ein-neues-3');
  assert.equal(server.users['a@example.org'].password, 'ganz-anders-22'); // abgelaufene Sitzung ändert nichts
});

// ─── Gericht-Fotos ───
const { fakeIndexedDB } = require('./fake-idb');
const JPG = n => 'data:image/jpeg;base64,' + 'A'.repeat(n);
const withIdb = (server, extra = {}) => { const idb = fakeIndexedDB(); return { idb, opts: { globals: { indexedDB: idb, ...extra } } }; };
const setImg = (d, id, n) => d.run(`dishImgSet('${id}',{t:${JSON.stringify(JPG(n))},f:${JSON.stringify(JPG(n * 10))}})`);

test('Sync: Foto kommt auf dem anderen Handy an, Ersetzen und Entfernen auch; Bilddaten werden nur bei Änderung geladen', async () => {
  const server = new FakeSupabase();
  const A = withIdb(server, { WebSocket: server.WebSocket }), B = withIdb(server, { WebSocket: server.WebSocket });
  const a = await founder(server, A.opts);
  const b = await partner(server, a, B.opts);
  await settle(a, b);
  const id = a.get('S.essen.dishes[0].id');
  setImg(a, id, 60);
  await settle(a, b); await settle(a, b);
  assert.equal(server.images.length, 1);
  assert.deepEqual([server.images[0].dish_id, server.images[0].thumb, server.images[0].photo], [id, JPG(60), JPG(600)]);
  assert.equal(b.get(`IMG.t['${id}']`), JPG(60));
  assert.equal(B.idb.data[id].f, JPG(600));
  assert.equal(b.els.dishCss.textContent, `.di-${id}{background-image:url(${JPG(60)})}`);
  b.run(`setView('essen');setEssTab('buch')`);
  assert.match(b.app(), new RegExp(`dimg dimg-56 di-${id}`));
  // nichts geändert: nur die schlanke Liste, keine Bilddaten
  server.calls.length = 0;
  await sync(b); await settle(a, b);
  const calls = server.calls.filter(u => u.includes('/dish_images'));
  assert.ok(calls.length >= 1);
  assert.ok(calls.every(u => /select=dish_id(%2C|,)rev$/.test(u)), calls.join('\n'));
  // Fotos stecken nicht im Einstellungs-Dokument und nicht in der Warteschlange auf dem Gerät
  assert.doesNotMatch(JSON.stringify(server.docs), /base64/);
  assert.doesNotMatch(JSON.stringify(a.store), /base64/);
  // ersetzen (auf B), entfernen (auf A)
  setImg(b, id, 70);
  await settle(a, b); await settle(a, b);
  assert.equal(a.get(`IMG.t['${id}']`), JPG(70));
  assert.equal(A.idb.data[id].f, JPG(700));
  a.run(`openDishModal('${id}');dishDropImg();saveDish()`);
  await settle(a, b); await settle(a, b);
  assert.equal(server.images.length, 0);
  assert.deepEqual(b.get('IMG.t'), {});
  assert.equal(B.idb.data[id], undefined);
});

test('Sync: ohne Foto-Tabelle (005 noch nicht eingespielt) läuft der Rest weiter, Fotos werden nachgeliefert', async () => {
  const server = new FakeSupabase();
  server.noImages = true;
  const A = withIdb(server, { WebSocket: server.WebSocket }), B = withIdb(server, { WebSocket: server.WebSocket });
  const a = await founder(server, A.opts);
  const b = await partner(server, a, B.opts);
  await settle(a, b);
  assert.equal(a.get('RT.joined'), true);
  const id = a.get('S.essen.dishes[0].id');
  setImg(a, id, 60);
  a.run(`UI.ekNew='Milch';ekAddInput()`);
  await settle(a, b); await settle(a, b);
  assert.equal(a.get('SYNC.status'), 'ok');
  assert.deepEqual(b.get('S.einkauf.items.map(x=>x.name)'), ['Milch']);
  assert.equal(a.get(`IMG.t['${id}']`), JPG(60)); // bleibt lokal
  assert.deepEqual(b.get('IMG.t'), {});
  server.noImages = false; // 005 eingespielt
  await sync(a); await settle(a, b);
  assert.equal(server.images.length, 1);
  await sync(b); await settle(a, b); await settle(a, b);
  assert.equal(b.get(`IMG.t['${id}']`), JPG(60));
  for (const d of [a, b]) assert.equal(d.get('RT.joined'), true);
  assert.ok(server.sockets.every(s => s.sent.find(m => m.event === 'phx_join').payload.config.postgres_changes.some(c => c.table === 'dish_images')));
});

test('Sync: Haushalt anlegen lädt vorhandene Fotos hoch, Beitritt ersetzt lokale Fotos durch die des Haushalts', async () => {
  const server = new FakeSupabase();
  const A = withIdb(server), B = withIdb(server);
  const a = device(server, A.opts);
  a.run(`openKidModal(null);UI.form.name='Emma';saveKid();ob().name='Familie Test';obFinish()`);
  a.flush(); await settle(a);
  const id = a.get('S.essen.dishes[0].id');
  setImg(a, id, 60); // Foto schon vor dem Konto
  await settle(a);
  await login(a, server, 'a@example.org');
  await a.run('createHousehold()');
  await settle(a); await sync(a); await settle(a);
  assert.deepEqual(server.images.map(r => r.dish_id), [id]);
  // B hat lokal ein eigenes Foto und tritt bei
  const b = device(server, B.opts);
  b.run(`openKidModal(null);UI.form.name='Ben';saveKid();ob().name='Lokal';obFinish()`);
  b.flush(); await settle(b);
  setImg(b, 'lokal1', 50);
  await settle(b);
  await login(b, server, 'b@example.org');
  b.run(`UI.form.joinCode=${JSON.stringify(a.get('SYNC.invite'))}`);
  await b.run('joinHousehold()');
  await settle(b); await sync(b); await settle(b);
  assert.deepEqual(b.get('Object.keys(IMG.t)'), [id]);
  assert.deepEqual(Object.keys(B.idb.data), [id]);
  assert.deepEqual(server.images.map(r => r.dish_id), [id]); // das lokale Foto von B wurde nicht hochgeladen
  // Fremde sehen nichts
  const c = device(server, withIdb(server).opts);
  await login(c, server, 'c@example.org');
  c.run(`SYNC.hid='${a.get('SYNC.hid')}'`);
  await sync(c); await settle(c);
  assert.deepEqual(c.get('IMG.t'), {});
});
