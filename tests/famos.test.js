// Aufruf: node --test tests/famos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { load, extractScript } = require('./harness');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'famos.html');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'tools', 'build.py');
const VORLAGE = path.join(DIST, 'index.html'); // ausgelieferte Seite

// Immer frisch bauen (inkl. Personendaten-Check, falls eine Sperrliste vorhanden ist)
execFileSync('python3', [BUILD, APP, DIST], { stdio: 'pipe' });

/** App mit fertig angelegtem Haushalt (zwei Kinder, fiktive Namen) */
function household(opts) {
  const a = load(VORLAGE, opts);
  for (const name of ['Emma', 'Ben']) {
    a.run(`openKidModal(null);UI.form.name=${JSON.stringify(name)};saveKid();`);
  }
  a.run(`ob().name='Familie Test';obFinish();`);
  return a;
}

for (const file of [APP, VORLAGE]) {
  const name = path.relative(ROOT, file);

  test(`${name}: Script ist syntaktisch gültig`, () => {
    new vm.Script(extractScript(fs.readFileSync(file, 'utf8')), { filename: file });
  });

  test(`${name}: Sicherheits- und DSGVO-Grundlagen im HTML`, () => {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /user-scalable=no/);
    // Keine externe Quelle, auch keine Schrift: Manrope ist eingebettet
    const hosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1])
      .filter(h => h !== 'www.w3.org'); // SVG-Namespace in Data-URLs, kein Request
    assert.deepEqual([...new Set(hosts)].filter(h => h !== 'github.com'), []);
    // github.com nur als Link zur Anleitung, aus der eigenen Adresse gebaut – kein Konto-Name im Code
    assert.equal((html.match(/https?:\/\/github\.com/g) || []).length, 1);
    assert.match(html, /return m&&r\?`https:\/\/github\.com\/\$\{m\[1\]\}\/\$\{r\[1\]\}#eigene-instanz-einrichten`/);
    assert.equal((html.match(/@font-face\{font-family:'Manrope'/g) || []).length, 1);
    assert.match(html, /font-weight:200 800;font-display:swap;src:url\(data:font\/woff2;base64,/);
    assert.match(html, /font-src data:;/);
    assert.doesNotMatch(html, /<link[^>]+stylesheet/);
    assert.doesNotMatch(html, /googleapis|gstatic|google-analytics|gtag/i);
    const js = extractScript(html);
    assert.doesNotMatch(js, /\balert\(|\beval\(|document\.write|XMLHttpRequest/);
    // Dauerverbindung nur an einer Stelle, nur zur Projektadresse (wss)
    assert.equal((js.match(/new WebSocket\(/g) || []).length, 1);
    assert.match(js, /new WebSocket\(rtUrl\(\)\)/);
    assert.match(js, /function rtUrl\(\)\{return SB_URL\.replace\(\/\^https:\/,'wss:'\)/);
    // Netzwerk nur an einer Stelle und nur zur konfigurierten Supabase-Adresse
    assert.equal((js.match(/\bfetch\(/g) || []).length, 1);
    assert.match(js, /await fetch\(SB_URL\+path,/);
    assert.doesNotMatch(html, /connect-src/); // ohne Konfiguration: gar kein Netzwerk erlaubt
  });

  test(`${name}: startet ohne Fehler und rendert`, () => {
    const a = load(file);
    assert.ok(a.app().length > 100);
  });
}

// ─── Keine Familiendaten im Code ──────────────────────────────
test('App: Startdaten sind neutral (keine Kinder, kein Haushalt, kein Stundenplan)', () => {
  const a = load(APP);
  assert.equal(a.get('DEF.household'), null);
  assert.deepEqual(a.get('DEF.kids'), []);
  assert.deepEqual(a.get('DEF.stundenplan'), {});
  assert.deepEqual(a.get('DEF.taschengeld'), {});
  assert.equal(a.get('DEF.pin'), undefined);
  assert.doesNotMatch(a.html, /teacher:'/);
});

test('Build: Seite, Manifest, Service Worker und PNG-Icons, sonst nichts', () => {
  assert.deepEqual(fs.readdirSync(DIST).sort(), ['icons', 'index.html', 'manifest.webmanifest', 'sw.js']);
  assert.deepEqual(fs.readdirSync(path.join(DIST, 'icons')).sort(),
    ['apple-touch-icon.png', 'favicon-32.png', 'icon-192.png', 'icon-512.png', 'maskable-512.png']);
  for (const f of fs.readdirSync(path.join(DIST, 'icons'))) {
    assert.equal(fs.readFileSync(path.join(DIST, 'icons', f)).subarray(1, 4).toString(), 'PNG', f);
  }
  const m = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'FamOS');
  assert.equal(m.start_url, '.');
  assert.equal(m.display, 'standalone');
  // Android verlangt PNG-Icons in 192 und 512 für den Installations-Dialog, dazu ein maskierbares
  assert.deepEqual(m.icons.map(i => `${i.sizes}/${i.purpose}`), ['192x192/any', '512x512/any', '512x512/maskable']);
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(DIST, i.src)), i.src);
  const sw = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
  new vm.Script(sw);
  assert.match(sw, /const V='famos-[0-9a-f]{10}'/);
  for (const i of m.icons) assert.ok(sw.includes(`'./${i.src}'`));
  const html = fs.readFileSync(VORLAGE, 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  assert.match(html, /manifest-src 'self'/);
  assert.doesNotMatch(html, /createObjectURL\(new Blob\(\[JSON\.stringify\(m\)/);
});

function runBuild(env, src = APP) {
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'famos-'));
  try {
    const stdout = execFileSync('python3', [BUILD, src, out], { env: { ...process.env, ...env }, stdio: 'pipe' }).toString();
    return { code: 0, out: stdout, files: fs.readdirSync(out) };
  } catch (e) {
    return { code: e.status, out: e.stderr.toString() + e.stdout.toString(), files: fs.readdirSync(out) };
  }
}

test('Build: Personendaten-Check bricht ab und baut nichts, Namen erscheinen nicht im Log', () => {
  const tmp = path.join(require('node:os').tmpdir(), 'famos-leak.html');
  fs.writeFileSync(tmp, fs.readFileSync(APP, 'utf8').replace("lbl:'Anziehen'", "lbl:'Testkind Zorro'"));
  const r = runBuild({ PERSONAL_NAMES: 'Nobody, Zorro' }, tmp);
  assert.equal(r.code, 1);
  assert.match(r.out, /1 Personendaten-Treffer/);
  assert.doesNotMatch(r.out, /Zorro/);
  assert.deepEqual(r.files, []);
  assert.equal(runBuild({ PERSONAL_NAMES: 'Nobody,Zorro' }).code, 0);
});

test('Build: in CI ist eine fehlende Sperrliste ein Fehler', () => {
  const r = runBuild({ PERSONAL_NAMES: '', REQUIRE_PERSONAL_NAMES: '1' });
  // lokal kann .personal-names existieren, dann ist der Lauf ok
  if (!fs.existsSync(path.join(ROOT, '.personal-names'))) {
    assert.equal(r.code, 1);
    assert.match(r.out, /keine Sperrliste/);
  }
});

// ─── Erststart-Onboarding der Vorlage ─────────────────────────
test('Vorlage: Erststart zeigt Onboarding, kein Haushalt ohne Person', () => {
  const a = load(VORLAGE);
  assert.equal(a.get('S.household'), null);
  assert.match(a.app(), /Haushalt anlegen/);
  a.run('obFinish()');
  assert.equal(a.get('S.household'), null);
  assert.match(a.toast(), /mindestens eine Person/);
});

test('Vorlage: Haushalt mit Kindern und Erwachsenen anlegen', () => {
  const a = load(VORLAGE);
  a.run(`openKidModal(null);UI.form.name='Emma';UI.form.col='a';saveKid();`);
  a.run(`openAdultModal();adultQuick('Mama','👩');saveAdult();`);
  a.run(`openAdultModal();UI.form.name='  ';saveAdult();`); // leerer Name wird abgelehnt
  assert.equal(a.get('ob().adults').length, 1);
  a.run(`ob().name='Familie Test';obFinish();`);
  const cfg = a.saved('ra_cfg3');
  assert.equal(cfg.household.name, 'Familie Test');
  assert.equal(cfg.household.adults[0].name, 'Mama');
  assert.equal(cfg.kids.length, 1);
  assert.equal(cfg.kids[0].col, 'a');
  assert.deepEqual(Object.keys(cfg.stundenplan), [cfg.kids[0].id]);
  assert.match(a.app(), /Emma/);
  assert.doesNotMatch(a.app(), /Haushalt anlegen/);
});

test('Vorlage: Haushaltsname fällt auf Standard zurück', () => {
  const a = load(VORLAGE);
  a.run(`openKidModal(null);UI.form.name='Emma';saveKid();obFinish();`);
  assert.equal(a.get('S.household.name'), 'Unser Haushalt');
});

// ─── Module ───────────────────────────────────────────────────
test('Module: aus- und einschalten, mindestens eins bleibt an', () => {
  const a = household();
  assert.match(a.app(), /bot-nav/);
  a.run(`togModule('taschengeld')`);
  assert.equal(a.get('S.modules.taschengeld'), false);
  a.run('render()');
  assert.doesNotMatch(a.app(), /setView\('taschengeld'\)/);
  a.run(`togModule('stundenplan');togModule('essen');togModule('einkauf');togModule('aufgaben');togModule('kalender');togModule('wuensche');togModule('heute')`);
  a.run('render()');
  assert.doesNotMatch(a.app(), /bot-nav/); // nur ein Modul: keine Navigation
  a.run(`togModule('routine')`);
  assert.equal(a.get('S.modules.routine'), true);
  assert.match(a.toast(), /Mindestens ein Bereich/);
  a.run(`togModule('taschengeld')`);
  assert.equal(a.saved('ra_cfg3').modules.taschengeld, true);
});

test('Module: ausgeblendete Ansicht springt auf ein aktives Modul', () => {
  const a = household();
  a.run(`setView('taschengeld');togModule('taschengeld');render()`);
  assert.notEqual(a.get('UI.view'), 'taschengeld');
});

// ─── Routine ──────────────────────────────────────────────────
test('Routine: abhaken, Fortschritt, Fertig-Overlay, Neu starten', () => {
  const a = household();
  const kid = a.get('UI.kid');
  const tasks = a.get(`kidTasks('morgen','${kid}')`);
  assert.ok(tasks.length >= 2);
  a.run(`toggleTask('morgen','${kid}','${tasks[0].id}')`);
  assert.match(a.app(), new RegExp(`1 / ${tasks.length}`));
  assert.match(a.app(), /aria-pressed="true"/);
  tasks.slice(1).forEach(t => a.run(`toggleTask('morgen','${kid}','${t.id}')`));
  a.flush();
  assert.ok(a.els.doneOv.classList.contains('show'));
  assert.match(a.els.doneTitle.textContent, /Emma/);
  // "Neu starten" gibt es nur noch in den Einstellungen, Aufgaben anlegen dürfen Kinder weiterhin
  assert.doesNotMatch(a.app(), /resetDay/);
  assert.match(a.app(), /Aufgabe hinzufügen/);
  a.run(`setATab('routinen')`);
  assert.match(a.adm(), /resetDay/);
  a.run('resetDay()');
  assert.equal(a.get(`doneCount('morgen','${kid}')`), 0);
});

test('Routine: Wahl-Aufgabe lässt sich wechseln, bis sie abgehakt ist', () => {
  const a = household();
  const kid = a.get('UI.kid');
  const [w1, w2] = a.get('S.wahlPool').map(w => w.id);
  a.run(`togWahl('morgen');render();setWahl('morgen','${kid}','${w1}');setWahl('morgen','${kid}','${w2}')`);
  assert.equal(a.get(`kidWahl('morgen','${kid}')`), w2);
  assert.doesNotMatch(a.app(), /class="wi[^"]*"[^>]*disabled/);
  a.run(`toggleWahlDone('morgen','${kid}','${w2}');setWahl('morgen','${kid}','${w1}')`);
  assert.equal(a.get(`kidWahl('morgen','${kid}')`), w2); // abgehakt: fix
  assert.match(a.app(), /class="wi faded"[^>]*disabled/);
  a.run(`toggleWahlDone('morgen','${kid}','${w2}');setWahl('morgen','${kid}','${w1}')`);
  assert.equal(a.get(`kidWahl('morgen','${kid}')`), w1); // Haken weg: wieder wechselbar
});

// ─── Eltern-PIN ───────────────────────────────────────────────
function pinApp() {
  const { a, kid } = tgApp();
  a.run(`openPinSetModal();UI.form.p1='4711';UI.form.p2='4711';savePin();closeAdmin()`);
  a.flush();
  return { a, kid };
}
const admOpen = a => a.els.adm.classList.contains('open');
const enter = (a, pin) => a.run(`UI.form.pin='${pin}';pinSubmit()`);

test('PIN: festlegen prüft Format und Wiederholung, gespeichert wird nur ein Hash', () => {
  const a = household();
  for (const [p1, p2] of [['12', '12'], ['abcd', 'abcd'], ['1234', '1235'], ['1234567', '1234567']]) {
    a.run(`openPinSetModal();UI.form.p1='${p1}';UI.form.p2='${p2}';savePin()`);
    assert.equal(a.get('S.pin'), null);
  }
  a.run(`openPinSetModal();UI.form.p1='4711';UI.form.p2='4711';savePin()`);
  assert.match(a.saved('ra_cfg3').pin.h, /^[0-9a-f]{8}$/);
  assert.doesNotMatch(a.store.ra_cfg3, /4711/);
  const b = load(VORLAGE, { storage: a.store }); // übersteht Neustart
  assert.deepEqual(b.get('S.pin'), a.get('S.pin'));
});

test('PIN: Einstellungen öffnen erst nach richtiger PIN, Schließen sperrt wieder', () => {
  const { a } = pinApp();
  a.run('openAdmin()');
  assert.equal(admOpen(a), false);
  assert.match(a.els.mc.innerHTML, /PIN eingeben/);
  enter(a, '0000');
  assert.equal(admOpen(a), false);
  assert.match(a.toast(), /Falsche PIN/);
  enter(a, '4711');
  assert.equal(admOpen(a), true);
  a.run('closeAdmin()'); a.flush();
  a.run('openAdmin()');
  assert.match(a.els.mc.innerHTML, /PIN eingeben/);
});

test('PIN: drei Fehlversuche sperren kurzzeitig auch die richtige PIN', () => {
  const { a } = pinApp();
  a.run('openAdmin()');
  for (let i = 0; i < 3; i++) enter(a, '0000');
  enter(a, '4711');
  assert.equal(admOpen(a), false);
  assert.match(a.toast(), /Fehlversuche/);
  a.run('UI.pinBlockUntil=0');
  enter(a, '4711');
  assert.equal(admOpen(a), true);
});

test('PIN: Taschengeld-Buchungen sind geschützt, Ansehen nicht', () => {
  const { a, kid } = pinApp();
  assert.match(a.app(), /Sparschwein/);
  a.run(`setTgStatus('gespart')`);
  assert.equal(a.get(`SAVINGS['${kid}']`) || 0, 0);
  a.run('closeModal()');
  a.run(`setTgStatus('gespart')`);
  enter(a, '4711');
  assert.equal(a.get(`SAVINGS['${kid}']`), 2.5);
  a.run('UI.unlockUntil=0');
  a.run(`openTgMoveModal('ein')`);
  assert.equal(a.get('UI.form.mode'), 'pin');
  enter(a, '4711');
  assert.equal(a.get('UI.form.mode'), 'tgMove');
  // Abbrechen verwirft die wartende Aktion
  a.run(`UI.unlockUntil=0;openTgMoveModal('aus');closeModal();openAdmin()`);
  enter(a, '4711');
  assert.equal(a.get('UI.form.mode'), 'pin');
  assert.equal(admOpen(a), true);
});

test('PIN: vergessen lässt sich nur mit richtiger Rechenantwort zurücksetzen', () => {
  const { a } = pinApp();
  a.run('openAdmin();pinForgot()');
  a.run(`UI.form.answer='1';pinForgotCheck()`);
  assert.ok(a.get('S.pin'));
  a.run(`UI.form.answer=String(UI.form.forgot.a*UI.form.forgot.b);pinForgotCheck()`);
  assert.equal(a.get('S.pin'), null);
  assert.equal(a.saved('ra_cfg3').pin, null);
  assert.equal(admOpen(a), true);
});

test('PIN: kaputte PIN-Daten aus einem Import werden verworfen', () => {
  const a = load(VORLAGE);
  const cfg = pin => JSON.stringify({ cfg: { kids: [{ id: 'k1', name: 'Emma' }], pin } });
  for (const bad of [{ s: '<x>', h: 'deadbeef' }, { s: 'abc', h: 'xyz' }, 'x', { s: ['abc'], h: 'deadbeef' }]) {
    a.run(`applyImport(${cfg(bad)})`);
    assert.equal(a.get('S.pin'), null);
  }
  a.run(`applyImport(${cfg({ s: 'abc', h: 'deadbeef' })})`);
  assert.deepEqual(a.get('S.pin'), { s: 'abc', h: 'deadbeef' });
});

test('Routine: Aufgabe nur für ein Kind, Brot-Check und Wahl-Aufgabe', () => {
  const a = household();
  const [k1, k2] = a.get('S.kids').map(k => k.id);
  a.run(`openTaskModal('morgen',null);UI.form.lbl='Ranzen packen';UI.form.to='${k2}';saveTask();`);
  assert.equal(a.get(`kidTasks('morgen','${k1}')`).some(t => t.lbl === 'Ranzen packen'), false);
  assert.equal(a.get(`kidTasks('morgen','${k2}')`).some(t => t.lbl === 'Ranzen packen'), true);
  a.run(`togBrot('morgen');togWahl('morgen');render();setBrot('ja')`);
  assert.match(a.app(), /Bescheid sagen/);
  const before = a.get(`totalCount('morgen','${k1}')`);
  const w = a.get('S.wahlPool')[0].id;
  a.run(`setWahl('morgen','${k1}','${w}')`);
  assert.equal(a.get(`totalCount('morgen','${k1}')`), before + 1);
  a.run(`toggleWahlDone('morgen','${k1}','${w}')`);
  assert.equal(a.get(`doneCount('morgen','${k1}')`), 1);
});

test('Routine: Tageswechsel bei offener App verwirft den alten Stand', () => {
  const a = household();
  const kid = a.get('UI.kid');
  const t = a.get(`kidTasks('morgen','${kid}')`)[0].id;
  a.run(`toggleTask('morgen','${kid}','${t}')`);
  a.run(`D.date='2000-01-01';saveDay()`); // Stand von gestern, App blieb offen
  a.listeners.visibilitychange.forEach(fn => fn());
  assert.equal(a.get(`doneCount('morgen','${kid}')`), 0);
  assert.equal(a.get('D.date'), a.get('today()'));
});

// ─── Stundenplan ──────────────────────────────────────────────
test('Stundenplan: anlegen (mit Lehrkraft), bearbeiten, verschieben, löschen', () => {
  const a = household();
  const kid = a.get('UI.kid');
  const add = (lbl, time, teacher) =>
    a.run(`openSpModal('${kid}','mo',null);UI.form.lbl='${lbl}';UI.form.time='${time}';UI.form.teacher='${teacher}';saveSpEntry();`);
  add('Mathe', '8:15 – 9:00', 'Fr. Beispiel');
  add('Sport', '9:00 – 9:45', '');
  let mo = a.get(`S.stundenplan['${kid}'].mo`);
  assert.deepEqual(mo.map(e => e.lbl), ['Mathe', 'Sport']);
  assert.equal(mo[0].teacher, 'Fr. Beispiel'); // Regression: Lehrkraft ging beim Speichern verloren
  a.run(`moveSpEntry('${kid}','mo',1,'up')`);
  assert.deepEqual(a.get(`S.stundenplan['${kid}'].mo`).map(e => e.lbl), ['Sport', 'Mathe']);
  a.run(`openSpModal('${kid}','mo',0);UI.form.lbl='Schwimmen';saveSpEntry();`);
  a.run(`delSpEntry('${kid}','mo',1)`);
  mo = a.saved('ra_cfg3').stundenplan[kid].mo;
  assert.deepEqual(mo.map(e => e.lbl), ['Schwimmen']);
  a.run(`setView('stundenplan');setSpDay('mo')`);
  assert.match(a.app(), /Schwimmen/);
  a.run(`setSpDay('di')`);
  assert.match(a.app(), /Noch keine Einträge für Dienstag/);
});

// ─── Taschengeld ──────────────────────────────────────────────
function tgApp() {
  const a = household();
  const kid = a.get('UI.kid');
  a.run(`togTgAktiv('${kid}');openTgBetragModal('${kid}');UI.form.betrag='2.50';saveTgBetrag();setView('taschengeld')`);
  return { a, kid };
}

test('Taschengeld: inaktiv bis eingeschaltet, Betrag setzen', () => {
  const a = household();
  a.run(`setView('taschengeld')`);
  assert.match(a.app(), /nicht aktiv/);
  const { a: b, kid } = tgApp();
  assert.deepEqual(b.get(`S.taschengeld['${kid}']`), { betrag: 2.5, aktiv: true });
  assert.match(b.app(), /2,50 €/);
  b.run(`openTgBetragModal('${kid}');UI.form.betrag='-1';saveTgBetrag();`);
  assert.equal(b.get(`S.taschengeld['${kid}'].betrag`), 2.5);
});

test('Taschengeld: Woche sparen, umentscheiden auf ausgezahlt', () => {
  const { a, kid } = tgApp();
  a.run(`setTgStatus('gespart')`);
  assert.equal(a.get(`SAVINGS['${kid}']`), 2.5);
  a.run(`setTgStatus('ausgezahlt')`);
  assert.equal(a.get(`SAVINGS['${kid}']`), 0);
  assert.equal(a.get('TX').length, 0); // Umentscheiden hinterlässt keine Buchungen
  assert.equal(a.get(`TGD['${kid}:'+weekKey()]`), 'ausgezahlt');
});

test('Taschengeld: nochmal tippen nimmt den Status zurück', () => {
  const { a, kid } = tgApp();
  a.run(`setTgStatus('gespart');setTgStatus('gespart')`);
  assert.equal(a.get(`SAVINGS['${kid}']`), 0);
  assert.deepEqual(a.get('TGD'), {});
  assert.match(a.app(), /Noch nicht festgelegt/);
  a.run(`setTgStatus('ausgezahlt');setTgStatus('ausgezahlt')`);
  assert.deepEqual(a.saved('ra_tgd'), {});
  assert.equal(a.get(`SAVINGS['${kid}']`), 0);
});

test('Taschengeld: Ein- und Auszahlen mit Teilbeträgen und Verlauf', () => {
  const { a, kid } = tgApp();
  const move = (kind, betrag, note = '') =>
    a.run(`openTgMoveModal('${kind}');UI.form.betrag='${betrag}';UI.form.note='${note}';saveTgMove();`);
  move('ein', '10', 'Oma');
  move('aus', '2,50', 'Eis');
  assert.equal(a.get(`SAVINGS['${kid}']`), 7.5);
  move('aus', '0,10');
  move('aus', '0,20');
  assert.equal(a.get(`SAVINGS['${kid}']`), 7.2); // keine Rundungsfehler
  move('aus', '99');
  assert.equal(a.get(`SAVINGS['${kid}']`), 7.2);
  assert.match(a.toast(), /nur 7,20 €/);
  for (const bad of ['abc', '0', '-3', '']) move('ein', bad);
  assert.equal(a.get(`SAVINGS['${kid}']`), 7.2);
  a.run(`openTgMoveModal('aus');tgQuickAll();saveTgMove();`);
  assert.equal(a.get(`SAVINGS['${kid}']`), 0);
  const tx = a.saved('ra_tx');
  assert.equal(tx.length, 5);
  assert.deepEqual(tx.slice(0, 2).map(x => [x.amt, x.note]), [[10, 'Oma'], [-2.5, 'Eis']]);
  assert.match(a.app(), /Letzte Buchungen/);
  assert.match(a.app(), /Auszahlen<\/button>/);
  assert.match(a.app(), /disabled/); // leeres Sparschwein: Auszahlen gesperrt
});

test('Taschengeld: Verlauf ist auf 200 Buchungen begrenzt', () => {
  const { a, kid } = tgApp();
  a.run(`for(let i=0;i<230;i++)bookSavings('${kid}',1,'x')`);
  assert.equal(a.saved('ra_tx').length, 200);
  assert.equal(a.get(`SAVINGS['${kid}']`), 230);
});

// ─── Export / Import ──────────────────────────────────────────
test('Export/Import: Roundtrip auf ein frisches Gerät', () => {
  const { a, kid } = tgApp();
  a.run(`openSpModal('${kid}','mo',null);UI.form.lbl='Mathe';saveSpEntry();bookSavings('${kid}',4,'Start');setTgStatus('gespart')`);
  const dump = JSON.stringify(a.get('buildExport()'));
  a.run('exportData()');
  assert.match(a.created.at(-1).download, /^famos-backup-\d{4}-\d{2}-\d{2}\.json$/);

  const b = load(VORLAGE);
  assert.equal(b.run(`applyImport(${dump})`), true);
  b.run('render()');
  assert.deepEqual(b.get('S'), a.get('S'));
  assert.deepEqual(b.get('SAVINGS'), a.get('SAVINGS'));
  assert.deepEqual(b.get('TX'), a.get('TX'));
  assert.deepEqual(b.get('TGD'), a.get('TGD'));
  assert.match(b.app(), /Emma/);
  // und es übersteht einen Neustart
  const c = load(VORLAGE, { storage: b.store });
  assert.deepEqual(c.get('S'), a.get('S'));
});

test('Import: ungültige Dateien ändern nichts', () => {
  const a = household();
  const before = a.get('S');
  for (const bad of ['null', '[]', '{}', '{"cfg":"x"}', '{"cfg":{"kids":"nope"}}', '42']) {
    assert.equal(a.run(`applyImport(${bad})`), false, bad);
  }
  assert.deepEqual(a.get('S'), before);
});

test('Import: Schadcode in Namen, IDs und Emojis wird neutralisiert', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const data = {
    cfg: {
      household: { name: evil, adults: [{ id: 'a1', name: evil, icon: '"><script>' }] },
      kids: [
        { id: 'k1', name: evil, icon: '<b>', col: 'constructor' },
        { id: "');alert(1);//", name: 'Böse ID', icon: '😈', col: 'a' },
        { id: '__proto__', name: 'Proto', icon: '😈', col: 'a' },
        { id: 'k1', name: 'Doppelt', icon: '😈', col: 'a' },
      ],
      routines: { morgen: { id: 'morgen', label: evil, icon: evil, active: true, brot: true, wahl: true,
        tasks: [{ id: 't1', em: evil, lbl: evil, sub: evil, to: 'all' }, { id: 'x"y', em: '⭐', lbl: 'weg', to: 'all' }] } },
      wahlPool: [{ id: 'w1', em: evil, lbl: evil }],
      stundenplan: { k1: { mo: [{ em: evil, lbl: evil, time: evil, teacher: evil }] } },
      taschengeld: { k1: { betrag: '1e99', aktiv: 1 } },
      modules: { routine: false, stundenplan: false, taschengeld: false },
      fremd: 'unbekanntes Feld',
    },
    savings: { k1: -50, "x'y": 3 },
    tx: [{ t: 1, kid: 'k1', amt: 2, note: evil }, { t: 'x', kid: 'k1', amt: 2 }, 'kaputt'],
    tgd: { 'k1:2026W01': 'gespart', 'k1:2026W02': '<script>', "bad'key": 'gespart' },
  };
  const a = load(VORLAGE);
  assert.equal(a.run(`applyImport(${JSON.stringify(data)})`), true);
  const S = a.get('S');
  assert.deepEqual(S.kids.map(k => k.id), ['k1']);
  assert.equal(S.kids[0].col, 'b');
  assert.equal(S.routines.morgen.tasks.length, 1);
  assert.equal(S.taschengeld.k1.betrag, 1000);
  assert.equal(S.fremd, undefined);
  assert.ok(Object.values(S.modules).some(Boolean));
  assert.deepEqual(a.get('SAVINGS'), { k1: 0 });
  assert.equal(a.get('TX').length, 1);
  assert.deepEqual(a.get('TGD'), { 'k1:2026W01': 'gespart' });

  // Jede Ansicht rendern: nirgends darf ein fremdes Tag oder ein Attribut-Ausbruch entstehen
  const outputs = [];
  for (const v of ['routine', 'stundenplan', 'taschengeld']) { a.run(`setView('${v}');setSpDay('mo')`); outputs.push(a.app()); }
  for (const t of ['kinder', 'module', 'routinen', 'haushalt', 'stundenplan', 'taschengeld']) { a.run(`setATab('${t}')`); outputs.push(a.adm()); }
  a.run(`openTaskModal('morgen','t1')`); outputs.push(a.els.mc.innerHTML);
  a.run(`openKidModal('k1')`); outputs.push(a.els.mc.innerHTML);
  a.run(`openSpModal('k1','mo',0)`); outputs.push(a.els.mc.innerHTML);
  a.run(`openTgMoveModal('aus')`); outputs.push(a.els.mc.innerHTML);
  for (const html of outputs) {
    assert.doesNotMatch(html, /<img|<script|<b>/i);
    assert.doesNotMatch(html, /"[^"<>]*onerror=alert\(1\)[^"<>]*"\s+on/i);
  }
  assert.ok(outputs.join('').includes('&lt;img src=x onerror=alert(1)&gt;'));
});

// ─── Migrationen ──────────────────────────────────────────────
test('Migration: alter Stand ohne household/modules/_mv wird ergänzt, Daten bleiben', () => {
  const old = {
    kids: [{ id: 'k1', name: 'Emma', icon: '🦄', col: 'a' }],
    routines: { morgen: { id: 'morgen', label: 'Morgen', icon: '☀️', active: true, brot: false, wahl: false,
      tasks: [{ id: 't1', em: '👕', lbl: 'Anziehen', sub: '', to: 'all' }] } },
    wahlPool: [],
    stundenplan: { k1: { mo: [{ em: '📖', lbl: 'Lesen' }] } },
    taschengeld: { k1: { betrag: 3, aktiv: true } },
  };
  const a = load(VORLAGE, { storage: { ra_cfg3: JSON.stringify(old) } });
  const S = a.get('S');
  assert.deepEqual(S.household, { name: 'Unsere Familie', adults: [] });
  assert.deepEqual(S.modules, { heute: true, routine: true, stundenplan: true, taschengeld: true, wuensche: true, aufgaben: true, kalender: true, essen: true, einkauf: true });
  assert.deepEqual(S.einkauf.items, []);
  assert.deepEqual(S.einkauf.std, []);
  assert.equal(S.einkauf.order[0], 'obst');
  assert.ok(S.essen.dishes.length >= 5); // ältere Stände bekommen Beispielgerichte
  assert.equal(S._mv, 4);
  assert.deepEqual(S.stundenplan.k1.mo, [{ em: '📖', lbl: 'Lesen', time: '', teacher: '' }]);
  assert.deepEqual(S.stundenplan.k1.sa, []);
  assert.deepEqual(S.stundenplan.k1.so, []);
  assert.deepEqual(S.taschengeld.k1, { betrag: 3, aktiv: true });
  assert.deepEqual(a.saved('ra_cfg3'), S); // migrierter Stand ist gespeichert
  assert.match(a.app(), /Emma/);
});

test('Migration: ensureHousehold', () => {
  const a = load(VORLAGE);
  const eh = c => a.run(`(()=>{const c=${JSON.stringify(c)};const r=ensureHousehold(c);return JSON.stringify([r,c.household]);})()`);
  assert.deepEqual(JSON.parse(eh({ kids: [{ id: 'k1' }] })), [true, { name: 'Unsere Familie', adults: [] }]);
  assert.deepEqual(JSON.parse(eh({ kids: [{ id: 'k1' }], household: { name: 'X' } })), [true, { name: 'X', adults: [] }]);
  assert.deepEqual(JSON.parse(eh({ kids: [], household: null })), [false, null]);
  assert.deepEqual(JSON.parse(eh({ kids: [{ id: 'k1' }], household: { name: 'X', adults: [] } })), [false, { name: 'X', adults: [] }]);
});

test('Migration: bestehende Modul-Schalter werden nicht überschrieben', () => {
  const a = household();
  a.run(`togModule('stundenplan')`);
  const b = load(VORLAGE, { storage: a.store });
  assert.equal(b.get('S.modules.stundenplan'), false);
  assert.equal(b.get('S.modules.routine'), true);
});

// ─── Robustheit ───────────────────────────────────────────────
test('Storage: kaputte Einträge führen zu Startdaten statt Absturz', () => {
  const a = load(VORLAGE, { storage: { ra_cfg3: '{kaputt', ra_tx: '"x"', ra_savings: '[1]', ra_day3: 'null', ra_tgd: '7' } });
  assert.equal(a.get('S.household'), null);
  assert.deepEqual(a.get('TX'), []);
  assert.deepEqual(a.get('SAVINGS'), {});
  assert.match(a.app(), /Haushalt anlegen/);
});

test('Storage: voller Speicher meldet sich, statt still zu scheitern', () => {
  const a = load(VORLAGE, { quotaFull: true });
  a.run(`openKidModal(null);UI.form.name='Emma';saveKid();`);
  assert.match(a.toast(), /Speichern fehlgeschlagen/);
});

test('Eingaben: Sonderzeichen in Namen werden als Text dargestellt', () => {
  const a = load(VORLAGE);
  a.run(`openKidModal(null);UI.form.name='Tom & <Jerry> "Q"';saveKid();obFinish();`);
  assert.match(a.app(), /Tom &amp; &lt;Jerry&gt; &quot;Q&quot;/);
  a.run(`openKidModal(S.kids[0].id)`);
  assert.match(a.els.mc.innerHTML, /value="Tom &amp; &lt;Jerry&gt; &quot;Q&quot;"/);
});

// ─── Essen ────────────────────────────────────────────────────
/** Haushalt mit Essen-Ansicht; Math.random fest, damit Würfeln reproduzierbar ist */
function essApp(rand = 0) {
  const a = household();
  a.run(`Math.random=()=>${rand};setView('essen')`);
  return a;
}
const td = a => a.get('today()');

test('Essen: Modul mit Beispielgerichten, nur Abend ist anfangs aktiv', () => {
  const a = essApp();
  assert.match(a.app(), /setView\('essen'\)/);
  assert.deepEqual(a.get('activeMeals().map(m=>m.id)'), ['abend']);
  assert.ok(a.get('S.essen.dishes').length >= 5);
  assert.match(a.app(), /Noch nichts geplant/);
  assert.doesNotMatch(a.app(), /Frühstück/);
});

test('Essen: Gericht anlegen mit Zutaten, Pflichtfelder werden geprüft', () => {
  const a = essApp();
  const n = a.get('S.essen.dishes.length');
  a.run(`openDishModal(null);UI.form.name='  ';saveDish()`);
  assert.match(a.toast(), /Namen/);
  a.run(`UI.form.name='Linsensuppe';UI.form.meals=[];saveDish()`);
  assert.match(a.toast(), /Mahlzeit/);
  a.run(`UI.form.meals=['abend','mittag'];UI.form.tags=['veg'];UI.form.ingr='250 g Linsen\\n\\n  2 Karotten  \\n';saveDish()`);
  const d = a.get('S.essen.dishes').at(-1);
  assert.equal(a.get('S.essen.dishes.length'), n + 1);
  assert.deepEqual([d.name, d.meals, d.tags, d.ingr], ['Linsensuppe', ['mittag', 'abend'], ['veg'], ['250 g Linsen', '2 Karotten']]);
  a.run(`openDishModal('${d.id}');UI.form.name='Rote Linsensuppe';saveDish()`);
  assert.equal(a.get(`dishById('${d.id}').name`), 'Rote Linsensuppe');
  assert.equal(a.get('S.essen.dishes.length'), n + 1);
  assert.equal(a.saved('ra_cfg3').essen.dishes.at(-1).name, 'Rote Linsensuppe');
});

test('Essen: Heute würfeln, nochmal würfeln wechselt, Festlegen sperrt', () => {
  const a = essApp();
  a.run(`rollToday('abend')`);
  const first = a.get(`planSlot(today(),'abend')`);
  assert.equal(first.pin, false);
  assert.match(a.app(), /Nochmal/);
  a.run(`rollToday('abend')`);
  assert.notEqual(a.get(`planSlot(today(),'abend').id`), first.id);
  a.run(`togPin(today(),'abend')`);
  const pinned = a.get(`planSlot(today(),'abend').id`);
  a.run(`rollToday('abend')`);
  assert.equal(a.get(`planSlot(today(),'abend').id`), pinned);
  assert.match(a.app(), /Festgelegt/);
});



test('Essen: kürzlich gegessen kommt seltener dran', () => {
  const a = essApp();
  const w = () => a.get(`dishWeight(dishById('g1'),'abend',today(),null)`);
  a.run(`setSlot(addDays(today(),-2),'abend','g1',false)`);
  assert.ok(Math.abs(w() - 0.1) < 1e-9);
  a.run(`S.essen.plan={};setSlot(addDays(today(),-6),'abend','g1',false)`);
  assert.ok(Math.abs(w() - 0.35) < 1e-9);
  a.run(`S.essen.plan={};setSlot(addDays(today(),-20),'abend','g1',false)`);
  assert.equal(w(), 1);
});

test('Essen: Woche würfeln füllt nur aktive Mahlzeiten, 📌 bleibt, Vergangenes bleibt unangetastet', () => {
  const a = essApp(0.5);
  a.run(`togMeal('mittag');setEssTab('woche');setEssWeek(1)`);
  const dates = a.get('weekDates(1)');
  a.run(`setSlot('${dates[2]}','abend','g3',true)`);
  a.run('rollWeek()');
  const plan = a.get('S.essen.plan');
  for (const ds of dates) {
    assert.ok(plan[ds]?.abend && plan[ds]?.mittag, ds);
    assert.equal(plan[ds].fruehstueck, undefined);
  }
  assert.deepEqual(plan[dates[2]].abend, { id: 'g3', pin: true });
  assert.match(a.toast(), /13 Mahlzeiten gewürfelt/);
  // keine Wiederholung am Folgetag, solange genug Gerichte da sind
  for (let i = 1; i < 7; i++) assert.notEqual(plan[dates[i]].abend.id, plan[dates[i - 1]].abend.id);
  // vergangene Tage dieser Woche werden nicht neu gewürfelt
  const past = a.get('weekDates(0)').filter(ds => ds < td(a));
  if (past.length) {
    a.run(`setSlot('${past[0]}','abend','g2',false);setEssWeek(0);rollWeek()`);
    assert.equal(a.get(`S.essen.plan['${past[0]}'].abend.id`), 'g2');
  }
});

test('Essen: Gericht von Hand wählen legt fest, Leeren entfernt', () => {
  const a = essApp();
  a.run(`openEssPick(today(),'abend')`);
  assert.match(a.els.mc.innerHTML, /Spaghetti Bolognese/);
  assert.doesNotMatch(a.els.mc.innerHTML, /Müsli/);
  a.run(`essPickSet('g2')`);
  assert.deepEqual(a.get(`planSlot(today(),'abend')`), { id: 'g2', pin: true });
  a.run(`openEssPick(today(),'abend');essPickSet('gibtsnicht')`);
  assert.equal(a.get(`planSlot(today(),'abend').id`), 'g2');
  a.run(`essPickSet(null)`);
  assert.equal(a.get(`planSlot(today(),'abend')`), null);
});

test('Essen: Gericht löschen räumt den Plan auf', () => {
  const a = essApp();
  a.run(`setSlot(today(),'abend','g1',true);openDishModal('g1');delDish()`);
  assert.equal(a.get(`dishById('g1')`), null);
  assert.deepEqual(a.get('S.essen.plan'), {});
});

test('Essen: Mahlzeiten schalten, mindestens eine bleibt an', () => {
  const a = essApp();
  a.run(`togMeal('abend')`);
  assert.equal(a.get('S.essen.meals.abend'), true);
  assert.match(a.toast(), /Mindestens eine Mahlzeit/);
  a.run(`togMeal('fruehstueck');togMeal('abend');render()`);
  assert.deepEqual(a.get('activeMeals().map(m=>m.id)'), ['fruehstueck']);
  assert.match(a.app(), /Frühstück/);
  a.run(`setATab('essen')`);
  assert.match(a.adm(), /role="switch" aria-checked="true" class="tog on" onclick="togMeal\('fruehstueck'\)"/);
});

test('Essen: alter Plan wird nach 5 Wochen aufgeräumt', () => {
  const a = essApp();
  a.run(`setSlot(addDays(today(),-40),'abend','g1',false);setSlot(addDays(today(),-10),'abend','g2',false);rollToday('abend')`);
  const keys = Object.keys(a.get('S.essen.plan'));
  assert.equal(keys.length, 2);
  assert.ok(!keys.includes(a.get('addDays(today(),-40)')));
});

test('Essen: Import validiert Gerichte, Plan und Bewertungen', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const a = load(VORLAGE);
  const data = { cfg: { kids: [{ id: 'k1', name: 'Emma' }], household: { name: 'X' }, essen: {
    meals: { abend: false, mittag: false, fruehstueck: false, snack: true },
    dishes: [
      { id: 'd1', em: evil, name: evil, meals: ['abend', 'snack'], tags: ['veg', 'gift'], ingr: [evil, 7, ''], ratings: { k1: 1, k9: -1, __proto__: 1 } },
      { id: 'd2', name: 'Ohne Mahlzeit', meals: [], ratings: { k1: 5 } },
      { id: 'd1', name: 'Doppelt' }, { id: "x'y", name: 'Böse ID' }, { name: 'Ohne ID' },
    ],
    plan: { '2026-11-10': { abend: { id: 'd1', pin: 'ja' }, mittag: { id: 'weg' } }, 'kaputt': { abend: { id: 'd1' } }, '__proto__': {} },
  } } };
  assert.equal(a.run(`applyImport(${JSON.stringify(data)})`), true);
  const E = a.get('S.essen');
  assert.deepEqual(E.meals, { fruehstueck: false, mittag: false, abend: true });
  assert.deepEqual(E.dishes.map(d => d.id), ['d1', 'd2']);
  assert.deepEqual(E.dishes[0].meals, ['abend']);
  assert.deepEqual(E.dishes[0].tags, ['veg']);
  assert.deepEqual(E.dishes[0].ratings, { k1: 1 });
  assert.equal(E.dishes[0].ingr.length, 1);
  assert.deepEqual(E.dishes[1].meals, ['abend']);
  assert.deepEqual(E.dishes[1].ratings, {});
  assert.deepEqual(E.plan, { '2026-11-10': { abend: { id: 'd1', pin: true } } });
  const out = [];
  for (const t of ['heute', 'woche', 'gerichte']) { a.run(`setView('essen');setEssTab('${t}')`); out.push(a.app()); }
  a.run(`openDishModal('d1')`); out.push(a.els.mc.innerHTML);
  a.run(`openEssPick('2026-11-10','abend')`); out.push(a.els.mc.innerHTML);
  for (const html of out) assert.doesNotMatch(html, /<img/i);
});

test('Essen: Export/Import enthält Gerichte, Bewertungen und Plan', () => {
  const a = essApp();
  a.run(`rateDish('g2',S.kids[0].id);rollToday('abend');togPin(today(),'abend')`);
  const b = load(VORLAGE);
  assert.equal(b.run(`applyImport(${JSON.stringify(a.get('buildExport()'))})`), true);
  assert.deepEqual(b.get('S.essen'), a.get('S.essen'));
});

// ─── Einkauf ──────────────────────────────────────────────────
function ekApp() { const a = household(); a.run(`setView('einkauf')`); return a; }
const add = (a, v) => a.run(`UI.ekNew=${JSON.stringify(v)};ekAddInput()`);
const names = a => a.get('S.einkauf.items').map(x => x.name);

test('Einkauf: eigene Ansicht ohne Kinder-Tabs, leere Liste mit Hinweis', () => {
  const a = ekApp();
  assert.doesNotMatch(a.app(), /kid-tabs/);
  assert.match(a.app(), /Die Liste ist leer/);
  assert.match(a.app(), /Zutaten aus dem Wochenplan/);
  a.run(`togModule('essen');render()`);
  assert.doesNotMatch(a.app(), /Zutaten aus dem Wochenplan/);
});

test('Einkauf: eintragen, Doppeltes abfangen, Feld leert sich', () => {
  const a = ekApp();
  add(a, '  Milch ');
  add(a, 'Brot');
  add(a, 'milch');
  assert.match(a.toast(), /milch steht schon auf der Liste/);
  assert.equal(a.get('UI.ekNew'), 'milch'); // abgelehnte Eingabe bleibt stehen
  add(a, '   ');
  assert.deepEqual(names(a), ['Milch', 'Brot']);
  add(a, 'Äpfel');
  assert.equal(a.get('UI.ekNew'), '');
  assert.equal(a.saved('ra_cfg3').einkauf.items.length, 3);
  assert.match(a.app(), /Einkaufen · 3/);
});

test('Einkauf: abhaken, Erledigte entfernen, Schnellwahl bringt sie zurück', () => {
  const a = ekApp();
  ['Milch', 'Brot', 'Käse'].forEach(v => add(a, v));
  const id = n => a.get(`S.einkauf.items.find(x=>x.name==='${n}').id`);
  a.run(`ekToggle('${id('Milch')}');ekToggle('${id('Käse')}')`);
  assert.match(a.app(), /Im Wagen · 2/);
  assert.match(a.app(), /Einkaufen · 1/);
  a.run(`ekToggle('${id('Käse')}')`); // zurück auf die Liste
  assert.match(a.app(), /Im Wagen · 1/);
  a.run('ekClearDone()');
  assert.deepEqual(names(a), ['Brot', 'Käse']);
  assert.deepEqual(a.get('S.einkauf.recent'), ['Milch']);
  assert.match(a.app(), /＋ Milch/);
  a.run('ekQuick(0)');
  assert.deepEqual(names(a), ['Brot', 'Käse', 'Milch']);
  assert.doesNotMatch(a.app(), /＋ Milch/); // steht drauf: kein Chip
  a.run(`ekDel('${id('Brot')}')`);
  assert.deepEqual(names(a), ['Käse', 'Milch']);
});

test('Einkauf: Schnellwahl merkt sich höchstens 20, das Neueste zuerst, ohne Dubletten', () => {
  const a = ekApp();
  for (let i = 0; i < 25; i++) add(a, 'Ding ' + i);
  a.run(`S.einkauf.items.forEach(x=>x.done=true);ekClearDone()`);
  add(a, 'Ding 3');
  a.run(`S.einkauf.items.forEach(x=>x.done=true);ekClearDone()`);
  const R = a.get('S.einkauf.recent');
  assert.equal(R.length, 20);
  assert.equal(R[0], 'Ding 3');
  assert.equal(new Set(R).size, 20);
});

test('Einkauf: Zutaten aus dem Wochenplan, zusammengefasst, nichts doppelt', () => {
  const a = ekApp();
  a.run(`togMeal('mittag')`);
  const dates = a.get('weekDates(1)');
  a.run(`setSlot('${dates[0]}','abend','g1',true);setSlot('${dates[1]}','mittag','g2',true);setSlot('${dates[2]}','abend','g4',true)`);
  add(a, '3 Eier'); // steht schon drauf
  const r = a.get('ekPlanLines(1)');
  assert.equal(r.dishes, 3);
  assert.equal(r.lines.find(l => l.name === 'Milch').n, 1);
  a.run('openEkPlanModal()');
  assert.match(a.els.mc.innerHTML, /\d+ Zutaten aus 3 Gerichten/);
  a.run('ekFromPlan(1)');
  const items = a.get('S.einkauf.items');
  assert.ok(items.some(x => x.name === '500 g Spaghetti'));
  assert.equal(items.filter(x => ekKeyOf(x.name) === '3 eier').length, 1);
  assert.match(a.toast(), /übernommen, 1 standen schon drauf/);
  a.run('ekFromPlan(1)');
  assert.match(a.toast(), /Alles stand schon auf der Liste/);
  // gleiche Zutaten mit Menge werden zusammengerechnet, ohne Menge gezählt
  a.run(`setSlot('${dates[3]}','abend','g1',true);S.einkauf.items=[];ekFromPlan(1)`);
  const names2 = a.get('S.einkauf.items.map(x=>x.name)');
  assert.ok(names2.includes('2 Zwiebel'), names2);
  assert.ok(names2.includes('1 kg Spaghetti'), names2);
  assert.ok(names2.includes('800 g Hackfleisch'), names2);
  assert.ok(names2.includes('2 Dose Tomaten'), names2);
});
function ekKeyOf(n) { return n.toLowerCase().replace(/\s+/g, ' ').trim(); }

test('Einkauf: diese Woche zählt erst ab heute, ausgeschaltete Mahlzeiten zählen nicht', () => {
  const a = ekApp();
  const t = a.get('today()');
  a.run(`setSlot(addDays(today(),-1),'abend','g1',true);setSlot(today(),'abend','g3',true);setSlot(today(),'mittag','g2',true)`);
  const r = a.get('ekPlanLines(0)');
  assert.equal(r.dishes, 1); // nur Pizza heute Abend; gestern vorbei, Mittag aus
  assert.ok(t);
});

test('Einkauf: Import validiert die Liste', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const a = load(VORLAGE);
  const data = { cfg: { kids: [{ id: 'k1', name: 'Emma' }], household: { name: 'X' }, einkauf: {
    items: [{ id: 'i1', name: evil, n: 500, done: 'ja' }, { id: 'i1', name: 'Doppelt' }, { id: "x'y", name: 'Böse' }, { id: 'i2', name: '' }, { id: 'i3', name: 'Brot', n: -4 }],
    recent: [evil, 'Milch', 'milch', 7, ''],
  } } };
  assert.equal(a.run(`applyImport(${JSON.stringify(data)})`), true);
  const E = a.get('S.einkauf');
  assert.deepEqual(E.items.map(x => [x.id, x.n, x.done]), [['i1', 99, true], ['i3', 1, false]]);
  assert.deepEqual(E.recent, [evil, 'Milch']);
  a.run(`setView('einkauf')`);
  assert.doesNotMatch(a.app(), /<img/);
  assert.match(a.app(), /&lt;img/);
});

test('Einkauf: Export/Import enthält Liste und Schnellwahl', () => {
  const a = ekApp();
  ['Milch', 'Brot'].forEach(v => add(a, v));
  a.run(`ekToggle(S.einkauf.items[0].id);ekClearDone()`);
  const b = load(VORLAGE);
  assert.equal(b.run(`applyImport(${JSON.stringify(a.get('buildExport()'))})`), true);
  assert.deepEqual(b.get('S.einkauf'), a.get('S.einkauf'));
});

// ─── Als App installieren ─────────────────────────────────────
function browser({ ua = '', standalone = false } = {}) {
  const listeners = {};
  const window = {
    matchMedia: q => ({ matches: standalone && q.includes('standalone') }),
    navigator: { standalone: false },
    location: { protocol: 'file:' },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
  };
  return { listeners, globals: { window, navigator: { userAgent: ua, maxTouchPoints: ua.includes('iPhone') ? 5 : 0 } } };
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
function onboard(a) { a.run(`openKidModal(null);UI.form.name='Emma';saveKid();obFinish()`); a.flush(); }

test('Installieren: nach dem Onboarding kommt die Aufforderung von selbst, einmal pro Gerät', () => {
  const b = browser({ ua: IPHONE });
  const a = load(VORLAGE, { globals: b.globals });
  onboard(a);
  assert.equal(a.get('UI.form.mode'), 'install');
  assert.match(a.els.mc.innerHTML, /Zum Home-Bildschirm/);
  assert.match(a.els.mc.innerHTML, /Teilen-Symbol/);
  assert.match(a.app(), /install-hint/);
  a.run('closeModal()');
  const c = load(VORLAGE, { storage: a.store, globals: b.globals }); // Neustart: nicht nochmal ungefragt
  c.flush();
  assert.notEqual(c.get('UI.form.mode'), 'install');
  assert.match(c.app(), /install-hint/); // die Karte bleibt, bis man sie wegklickt
});

test('Installieren: Android mit Installations-Dialog des Browsers', () => {
  const b = browser({ ua: ANDROID });
  const a = load(VORLAGE, { globals: b.globals });
  onboard(a);
  assert.match(a.els.mc.innerHTML, /App installieren/); // Anleitung, solange der Browser nichts anbietet
  let prompted = 0;
  const ev = { preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  b.listeners.beforeinstallprompt.forEach(fn => fn(ev));
  assert.match(a.app(), />Installieren</);
  a.run('openInstallModal()');
  assert.match(a.els.mc.innerHTML, /Jetzt installieren/);
  a.run('installNow()');
  assert.equal(prompted, 1);
  b.listeners.appinstalled.forEach(fn => fn());
  assert.equal(a.get('S.installHintDone'), true);
  assert.doesNotMatch(a.app(), /install-hint/);
  assert.match(a.toast(), /installiert/);
});

test('Installieren: in der installierten App kein Hinweis', () => {
  const b = browser({ ua: IPHONE, standalone: true });
  const a = load(VORLAGE, { globals: b.globals });
  onboard(a);
  assert.notEqual(a.get('UI.form.mode'), 'install');
  assert.doesNotMatch(a.app(), /install-hint/);
});

test('Installieren: „Nicht mehr zeigen“ wirkt dauerhaft', () => {
  const a = load(VORLAGE, { globals: browser({ ua: IPHONE }).globals });
  onboard(a);
  a.run('dismissInstall()');
  assert.equal(a.saved('ra_cfg3').installHintDone, true);
  assert.doesNotMatch(a.app(), /install-hint/);
  assert.equal(a.els.mb.classList.contains('open'), false);
  a.run(`localStorage.removeItem('famos_install_asked');maybeAskInstall()`); a.flush();
  assert.equal(a.els.mb.classList.contains('open'), false); // auch ohne Geräte-Merker: dauerhaft aus
});

// ─── Mengen und Kochschritte ──────────────────────────────────
test('Mengen: Zutatenzeilen werden erkannt', () => {
  const a = household();
  const p = l => a.get(`parseIngr(${JSON.stringify(l)})`);
  assert.deepEqual(p('500 g Mehl'), { q: 500, u: 'g', name: 'Mehl' });
  assert.deepEqual(p('1,5 kg Kartoffeln'), { q: 1500, u: 'g', name: 'Kartoffeln' });
  assert.deepEqual(p('250ml Sahne'), { q: 250, u: 'ml', name: 'Sahne' });
  assert.deepEqual(p('1/2 l Milch'), { q: 500, u: 'ml', name: 'Milch' });
  assert.deepEqual(p('½ Bund Petersilie'), { q: 0.5, u: 'Bund', name: 'Petersilie' });
  assert.deepEqual(p('2 EL Öl'), { q: 2, u: 'EL', name: 'Öl' });
  assert.deepEqual(p('3 Eier'), { q: 3, u: '', name: 'Eier' });
  assert.deepEqual(p('2 Dosen Tomaten'), { q: 2, u: 'Dose', name: 'Tomaten' });
  assert.deepEqual(p('1 Pck. Backpulver'), { q: 1, u: 'Pck.', name: 'Backpulver' });
  assert.deepEqual(p('Salz'), { q: null, u: '', name: 'Salz' });
  assert.deepEqual(p('Pizzateig'), { q: null, u: '', name: 'Pizzateig' });
  const f = x => a.get(`fmtIngr(${JSON.stringify(x)})`);
  assert.equal(f({ q: 1500, u: 'g', name: 'Mehl' }), '1,5 kg Mehl');
  assert.equal(f({ q: 750, u: 'ml', name: 'Milch' }), '750 ml Milch');
  assert.equal(f({ q: 2000, u: 'ml', name: 'Wasser' }), '2 l Wasser');
  assert.equal(f({ q: 0.5, u: 'Bund', name: 'Dill' }), '0,5 Bund Dill');
});

test('Mengen: Umrechnen auf Personen, Zählbares wird aufgerundet', () => {
  const a = household();
  const sc = (l, fac, shop = true) => a.get(`fmtIngr(scaleIngr(parseIngr(${JSON.stringify(l)}),${fac},${shop}))`);
  assert.equal(sc('500 g Spaghetti', 1.5), '750 g Spaghetti');
  assert.equal(sc('1 Dose Tomaten', 1.5), '2 Dose Tomaten');
  assert.equal(sc('3 Eier', 0.5), '2 Eier');
  assert.equal(sc('2 EL Öl', 0.5), '1 EL Öl');
  assert.equal(sc('800 g Mehl', 1.5), '1,2 kg Mehl');
  assert.equal(sc('Salz', 2), 'Salz');
  assert.equal(sc('1 Zwiebel', 1.5, false), '1,5 Zwiebel'); // im Rezept genau, beim Einkauf aufgerundet
  assert.equal(sc('½ Bund Dill', 1, true), '1 Bund Dill');
  // Einkauf aus dem Plan für 6 Personen bei Rezept für 4
  a.run(`setPersonsTo=n=>{S.essen.persons=n;};setPersonsTo(6);setSlot(weekDates(1)[0],'abend','g1',true)`);
  const lines = a.get('ekPlanLines(1).lines.map(l=>l.name)');
  assert.ok(lines.includes('750 g Spaghetti'), lines);
  assert.ok(lines.includes('600 g Hackfleisch'), lines);
  assert.ok(lines.includes('2 Dose Tomaten'), lines);
});

test('Rezept: Portionen und Schritte speichern, Ansicht rechnet um', () => {
  const a = household();
  a.run(`openDishModal(null);UI.form.name='Linsensuppe';UI.form.meals=['abend'];UI.form.ingr='250 g Linsen\\n2 Karotten';UI.form.portions='2';UI.form.steps='Linsen waschen\\n\\n 20 Minuten kochen ';saveDish()`);
  const d = a.get('S.essen.dishes.at(-1)');
  assert.equal(d.portions, 2);
  assert.deepEqual(d.steps, ['Linsen waschen', '20 Minuten kochen']);
  a.run(`openRecipe('${d.id}')`);
  const html = a.els.mc.innerHTML;
  assert.match(html, /Rezept für 2/);
  assert.match(html, /500 g Linsen/); // 4 Personen, Rezept für 2
  assert.match(html, /<li><span>Linsen waschen<\/span><\/li>/);
  a.run('recipePersons(-2)');
  assert.match(a.els.mc.innerHTML, /250 g Linsen/);
  assert.equal(a.get('S.essen.persons'), 4); // nur die Ansicht, nicht die Einstellung
  // Heute: Rezept-Knopf mit Anzahl Schritte
  a.run(`setView('essen');setSlot(today(),'abend','${d.id}',true);render()`);
  assert.match(a.app(), /Rezept ansehen · 2 Schritte/);
});

test('Rezept: Personenzahl in den Einstellungen, Grenzen 1 bis 20', () => {
  const a = household();
  a.run(`openAdmin();setATab('essen')`);
  assert.match(a.adm(), /Wir kochen für/);
  for (let i = 0; i < 30; i++) a.run('setPersons(1)');
  assert.equal(a.get('S.essen.persons'), 20);
  for (let i = 0; i < 30; i++) a.run('setPersons(-1)');
  assert.equal(a.get('S.essen.persons'), 1);
  assert.equal(a.saved('ra_cfg3').essen.persons, 1);
});

test('Rezept: Import begrenzt Schritte und Portionen, Schadcode wird Text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const a = load(VORLAGE);
  const data = { cfg: { kids: [{ id: 'k1', name: 'Emma' }], household: { name: 'X' }, essen: { persons: 999, dishes: [
    { id: 'd1', name: 'Suppe', meals: ['abend'], portions: -3, steps: [evil, 7, '', ...Array(40).fill('x')], ingr: [evil] },
  ] } } };
  assert.equal(a.run(`applyImport(${JSON.stringify(data)})`), true);
  const E = a.get('S.essen');
  assert.equal(E.persons, 20);
  assert.equal(E.dishes[0].portions, 1);
  assert.equal(E.dishes[0].steps.length, 30);
  a.run(`openRecipe('d1')`);
  assert.doesNotMatch(a.els.mc.innerHTML, /<img/);
  assert.match(a.els.mc.innerHTML, /&lt;img/);
});

test('Aussehen: zwei Farbwelten, pro Gerät gespeichert, Kinderfarben passend benannt', () => {
  const a = household();
  assert.equal(a.get('getLook()'), 'petrol');
  a.run(`openAdmin();setATab('kinder')`);
  assert.match(a.adm(), /Aussehen auf diesem Gerät/);
  a.run(`setLook('pop')`);
  assert.equal(a.store.famos_look, 'pop');
  assert.equal(a.get(`colorLabel('a')`), 'Orange');
  assert.match(a.adm(), /aria-pressed="true" onclick="setLook\('pop'\)"/);
  a.run(`setLook('<script>')`);
  assert.equal(a.get('getLook()'), 'pop');
  const b = load(VORLAGE, { storage: { ...a.store, famos_look: 'quatsch' } });
  assert.equal(b.get('getLook()'), 'petrol');
  // Look wandert nicht mit dem Backup (gerätebezogen)
  assert.equal(JSON.stringify(a.get('buildExport()')).includes('famos_look'), false);
});

test('Taschengeld: Fehlklick mit Korrektur hinterlässt keine Buchungen, andere bleiben', () => {
  const { a, kid } = tgApp();
  a.run(`bookSavings('${kid}',5,'Oma')`);
  for (let i = 0; i < 3; i++) a.run(`setTgStatus('gespart');setTgStatus('gespart')`);
  a.run(`setTgStatus('gespart')`);
  assert.deepEqual(a.get('TX.map(x=>x.note)'), ['Oma', `Wochengeld gespart (KW ${a.get('getKW()')})`]);
  assert.equal(a.get(`SAVINGS['${kid}']`), 7.5);
  // Geld ist inzwischen ausgegeben: Zurücknehmen löscht trotzdem nur die Wochenbuchung
  a.run(`openTgMoveModal('aus');UI.form.betrag='7';saveTgMove();setTgStatus('gespart')`);
  assert.equal(a.get(`SAVINGS['${kid}']`), 0);
  assert.equal(a.get('TX').some(x => x.note.startsWith('Wochengeld')), false);
});

test('Taschengeld: alte Fehlklick-Paare werden beim Laden aufgeräumt, Kontostand bleibt', () => {
  const kw = 'KW 46', t = n => 1700000000000 + n;
  const tx = [
    { t: t(1), kid: 'k1', amt: 1.5, note: `Wochengeld gespart (${kw})` },
    { t: t(2), kid: 'k1', amt: -1.5, note: `Sparen zurückgenommen (${kw})` },
    { t: t(3), kid: 'k1', amt: 1.5, note: `Wochengeld gespart (${kw})` },
    { t: t(4), kid: 'k1', amt: -1.5, note: `Sparen zurückgenommen (${kw})` },
    { t: t(5), kid: 'k1', amt: 1.5, note: `Wochengeld gespart (${kw})` },
    { t: t(6), kid: 'k2', amt: -1.5, note: `Sparen zurückgenommen (${kw})` }, // ohne Gegenstück: bleibt
    { t: t(7), kid: 'k1', amt: 2, note: 'Wochengeld gespart (KW 45)' },
    { t: t(8), kid: 'k1', amt: -1, note: 'Sparen zurückgenommen (KW 45)' }, // anderer Betrag: bleibt
  ];
  const a = load(VORLAGE, { storage: { ra_tx: JSON.stringify(tx), ra_savings: JSON.stringify({ k1: 10.5 }) } });
  assert.deepEqual(a.get('TX.map(x=>x.t)'), [t(5), t(6), t(7), t(8)]);
  assert.equal(a.get('SAVINGS.k1'), 10.5);
});

test('Taschengeld: Aufräumen klappt auch, wenn „zurückgenommen“ vor „gespart“ einsortiert ist (Uhren zweier Handys)', () => {
  const t = n => 1700000000000 + n;
  const tx = [
    { t: t(1), kid: 'k2', amt: -1.5, note: 'Sparen zurückgenommen (KW 46)' },
    { t: t(2), kid: 'k2', amt: 1.5, note: 'Wochengeld gespart (KW 46)' },
    { t: t(3), kid: 'k2', amt: 1.5, note: 'Wochengeld gespart (KW 46)' },
    { t: t(4), kid: 'k2', amt: -1.5, note: 'Sparen zurückgenommen (KW 46)' },
    { t: t(5), kid: 'k2', amt: 1.5, note: 'Wochengeld gespart (KW 46)' },
  ];
  const a = load(VORLAGE, { storage: { ra_tx: JSON.stringify(tx) } });
  assert.deepEqual(a.get('TX.map(x=>x.t)'), [t(5)]);
});

// ─── Einkauf: Bereiche im Laden, Standardliste ────────────────
test('Einkauf: Artikel landen im richtigen Bereich (Wörterbuch, längster Treffer)', () => {
  const a = household();
  const c = n => a.get(`ekGuessCat(${JSON.stringify(n)})`);
  const cases = {
    Bananen: 'obst', '10 Eier': 'obst', 'Kartoffeln': 'obst', 'Frühlingszwiebeln': 'obst',
    Vollkornbrot: 'brot', Toastbrot: 'brot', Brötchen: 'brot',
    '500 g Spaghetti': 'vorrat', 'Tomatenmark': 'vorrat', '1 Dose Tomaten': 'vorrat', 'passierte Tomaten': 'vorrat', Olivenöl: 'vorrat', Kokosmilch: 'vorrat',
    '5 l Milch': 'kuehl', 'Schlagsahne': 'kuehl', 'Frischkäse': 'kuehl', 'Joghurt': 'kuehl', Pizzateig: 'kuehl',
    Gouda: 'kaese', Salami: 'kaese', '400 g Hackfleisch': 'kaese',
    'O-Saft': 'getraenke', Mineralwasser: 'getraenke',
    Müsli: 'fruehstueck', Erdbeermarmelade: 'fruehstueck', Mehl: 'fruehstueck', Kräutertee: 'fruehstueck', Milchschokolade: 'fruehstueck',
    Klopapier: 'haushalt', Spülmittel: 'haushalt',
    Fischstäbchen: 'tk', 'TK Erbsen': 'tk', Rahmspinat: 'tk', Eis: 'tk',
    Geschenkpapier: 'sonst', Reis: 'vorrat',
  };
  for (const [n, want] of Object.entries(cases)) assert.equal(c(n), want, n);
});

test('Einkauf: Liste ist nach Läden-Reihenfolge gruppiert, Umsortieren wird gemerkt', () => {
  const a = household();
  a.run(`setView('einkauf')`);
  ['Fischstäbchen', 'Milch', 'Bananen', 'Brot', 'Geschenkpapier'].forEach(n => a.run(`ekAdd(${JSON.stringify(n)})`));
  a.run('render()');
  const order = [...a.app().matchAll(/class="ek-cat">[^ ]+ ([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(order, ['Obst, Gemüse &amp; Eier', 'Brot &amp; Backwaren', 'Milch, Sahne &amp; Joghurt', 'Tiefkühl', 'Sonstiges']);
  // Geschenkpapier gehört bei uns zu Drogerie: einmal zuordnen, gilt auch für später
  const id = a.get(`S.einkauf.items.find(x=>x.name==='Geschenkpapier').id`);
  a.run(`openEkItem('${id}');UI.form.cat='haushalt';UI.form.catSet=true;saveEkItem()`);
  assert.equal(a.get(`ekCat('Geschenkpapier')`), 'haushalt');
  assert.equal(a.saved('ra_cfg3').einkauf.cats.geschenkpapier, 'haushalt');
  // Reihenfolge der Bereiche ändern: Tiefkühl ganz nach oben
  const tk = a.get(`S.einkauf.order.indexOf('tk')`);
  for (let i = tk; i > 0; i--) a.run(`ekMoveCat(${i},-1)`);
  a.run('render()');
  assert.match(a.app(), /class="ek-cat">🧊 Tiefkühl</);
  assert.ok(a.app().indexOf('Tiefkühl<') < a.app().indexOf('Obst, Gemüse'));
  a.run('ekResetOrder()');
  assert.equal(a.get('S.einkauf.order[0]'), 'obst');
  assert.deepEqual(a.get('S.einkauf.cats'), {});
});

test('Einkauf: Eintrag umbenennen und löschen über ⋯', () => {
  const a = household();
  a.run(`setView('einkauf');ekAdd('Milhc')`);
  const id = a.get('S.einkauf.items[0].id');
  a.run(`openEkItem('${id}')`);
  assert.match(a.els.mc.innerHTML, /Bereich im Laden/);
  a.run(`UI.form.name='Milch';saveEkItem()`);
  assert.equal(a.get('S.einkauf.items[0].name'), 'Milch');
  assert.deepEqual(a.get('S.einkauf.cats'), {}); // erkannter Bereich wird nicht extra gespeichert
  a.run(`openEkItem('${id}');ekDel(UI.form.id);closeModal()`);
  assert.deepEqual(a.get('S.einkauf.items'), []);
});

test('Einkauf: Standardliste pflegen und mit einem Tipp hinzufügen, ohne Doppelte', () => {
  const a = household();
  a.run(`setView('einkauf')`);
  assert.doesNotMatch(a.app(), /Standardliste hinzufügen/);
  assert.match(a.app(), /Standardliste anlegen/);
  a.run(`openAdmin();setATab('einkauf');UI.ekStd='5 l Milch\\n10 Eier\\n\\nbananen\\nBananen\\nBrot';saveEkStd()`);
  assert.deepEqual(a.get('S.einkauf.std'), ['5 l Milch', '10 Eier', 'bananen', 'Brot']);
  a.run(`closeAdmin()`); a.flush();
  a.run(`setView('einkauf');ekAdd('Brot');ekAddStd()`);
  assert.deepEqual(a.get('S.einkauf.items.map(x=>x.name)'), ['Brot', '5 l Milch', '10 Eier', 'bananen']);
  assert.match(a.toast(), /3 Einträge aus der Standardliste, 1 standen schon drauf/);
  a.run('ekAddStd()');
  assert.match(a.toast(), /steht schon drauf/);
  // aktuelle Liste als Standard übernehmen
  a.run(`ekAdd('Klopapier');openAdmin();setATab('einkauf');ekStdFromList();saveEkStd()`);
  assert.ok(a.get('S.einkauf.std').includes('Klopapier'));
});

test('Einkauf: Import begrenzt Bereiche, Reihenfolge und Standardliste', () => {
  const a = load(VORLAGE);
  const data = { cfg: { kids: [{ id: 'k1', name: 'Emma' }], household: { name: 'X' }, einkauf: {
    cats: { milch: 'tk', '__proto__': 'tk', brot: 'gibtsnicht' }, order: ['tk', 'tk', 'quatsch', 'obst'], std: ['<b>x</b>', 7, '', ...Array(80).fill(0).map((_, i) => 'A' + i)],
  } } };
  assert.equal(a.run(`applyImport(${JSON.stringify(data)})`), true);
  const E = a.get('S.einkauf');
  assert.deepEqual(E.cats, { milch: 'tk' });
  assert.deepEqual(E.order.slice(0, 3), ['tk', 'obst', 'brot']);
  assert.equal(E.order.length, 10);
  assert.equal(E.std.length, 60);
  a.run(`setView('einkauf');ekAdd('<b>x</b>');render()`);
  assert.doesNotMatch(a.app(), /<b>x/);
});

test('Essen: Gericht für heute direkt auswählen, ohne zu würfeln', () => {
  const a = household();
  a.run(`setView('essen')`);
  assert.match(a.app(), /onclick="openEssPick\('[0-9-]+','abend'\)">Auswählen</);
  a.run(`openEssPick(today(),'abend');essPickSet('g3')`);
  assert.deepEqual(a.get(`planSlot(today(),'abend')`), { id: 'g3', pin: true });
  assert.match(a.app(), /Pizza/);
});

// ─── Mit Claude übernehmen ────────────────────────────────────
test('Claude: ein Rezept aus der Antwort (mit Code-Block drumherum) füllt das Formular', () => {
  const a = household();
  a.run(`setView('essen');setEssTab('gerichte');render()`);
  assert.match(a.app(), /openClaude\('rezept'\)/);
  a.run(`openClaude('rezept')`);
  assert.match(a.els.mc.innerHTML, /Text für Claude kopieren/);
  assert.match(a.get('CLAUDE_PROMPTS.rezept'), /"famos":"rezept"/);
  for (const k of ['rezept', 'stundenplan']) assert.match(a.get(`CLAUDE_PROMPTS.${k}`), /einzigen Codeblock \(```json … ```\)/);
  const answer = 'Hier ist das Rezept:\n```json\n' + JSON.stringify({ famos: 'rezept', name: 'Linsen-Dal', emoji: '🍛', portionen: 2,
    zutaten: ['250 g rote Linsen', '400 ml Kokosmilch'], schritte: ['Zwiebel anbraten', 'Linsen dazu, 15 Min. köcheln'], mahlzeiten: ['abend', 'snack'], eigenschaften: ['veg', 'quatsch'] }) + '\n```';
  a.run(`UI.form.text=${JSON.stringify(answer)};parseClaude()`);
  const f = a.get('UI.form');
  assert.equal(f.mode, 'dish');
  assert.deepEqual([f.name, f.em, f.portions, f.meals, f.tags], ['Linsen-Dal', '🍛', 2, ['abend'], ['veg']]);
  assert.equal(f.ingr, '250 g rote Linsen\n400 ml Kokosmilch');
  a.run('saveDish()');
  assert.equal(a.get('S.essen.dishes.at(-1).steps.length'), 2);
});

test('Claude: mehrere Rezepte über Vorschau, Unsinn wird abgefangen, Schadcode bleibt Text', () => {
  const a = household();
  const n = a.get('S.essen.dishes.length');
  a.run(`openClaude('rezept');UI.form.text='keine Ahnung, sorry';parseClaude()`);
  assert.match(a.get('UI.form.err'), /nicht nach Claudes Antwort/);
  a.run(`UI.form.text='{"famos":"rezept"}';parseClaude()`);
  assert.match(a.get('UI.form.err'), /Kein Rezept/);
  const list = [{ name: '<img src=x onerror=alert(1)>', zutaten: ['x'] }, { name: 'Suppe', portionen: 99 }];
  a.run(`UI.form.text=${JSON.stringify(JSON.stringify(list))};parseClaude()`);
  assert.doesNotMatch(a.els.mc.innerHTML, /<img/);
  a.run('applyClaude()');
  assert.equal(a.get('S.essen.dishes.length'), n + 2);
  assert.equal(a.get('S.essen.dishes.at(-1).portions'), 20);
});

test('Claude: Stundenplan vom Foto ersetzt nur die genannten Tage des gewählten Kindes', () => {
  const a = household();
  const [k1, k2] = a.get('S.kids').map(k => k.id);
  a.run(`openSpModal('${k2}','fr',null);UI.form.lbl='Schwimmen';saveSpEntry()`);
  a.run(`openAdmin();setATab('stundenplan')`);
  assert.match(a.adm(), /mit Claude vom Foto/);
  const plan = { famos: 'stundenplan', tage: { mo: [{ fach: 'Mathe', von: '8:15', bis: '9:00', lehrkraft: 'Fr. Beispiel', emoji: '📐' }, { fach: 'Deutsch', von: '9:00' }, { fach: '' }], di: [], xx: [{ fach: 'Hack' }] } };
  a.run(`openClaude('stundenplan');UI.form.text=${JSON.stringify(JSON.stringify(plan))};parseClaude();UI.form.kid='${k2}';applyClaude()`);
  const sp = a.get(`S.stundenplan['${k2}']`);
  assert.deepEqual(sp.mo, [{ em: '📐', lbl: 'Mathe', time: '8:15 – 9:00', teacher: 'Fr. Beispiel' }, { em: '📖', lbl: 'Deutsch', time: '9:00', teacher: '' }]);
  assert.deepEqual(sp.di, []);
  assert.deepEqual(sp.fr.map(e => e.lbl), ['Schwimmen']); // nicht genannter Tag bleibt
  assert.deepEqual(a.get(`S.stundenplan['${k1}'].mo`), []);
});

// ─── Essen: Plan und Kochbuch, Bewertung für alle ─────────────
test('Essen: zwei Bereiche Plan und Kochbuch, Kochbuch zeigt die Anzahl, kein Kinder-Umschalter', () => {
  const a = household();
  a.run(`setView('essen')`);
  assert.doesNotMatch(a.app(), /kid-tabs/);
  assert.match(a.app(), /Kochbuch <span class="seg-n">7</);
  assert.match(a.app(), /class="s-lbl">Heute</);
  assert.match(a.app(), /Woche würfeln/);
  a.run(`setEssTab('gerichte')`); // alte Bezeichnung landet im Kochbuch
  assert.equal(a.get('UI.essTab'), 'buch');
  assert.match(a.app(), /Aus Link/);
  a.run(`S.essen.dishes=[];setEssTab('plan')`);
  assert.match(a.app(), /Kochbuch ist noch leer/);
});

test('Essen: Plan zeigt heute groß und nur die kommenden Tage', () => {
  const a = household();
  a.run(`setView('essen');setSlot(today(),'abend','g3',true)`);
  const d = a.get('weekDates(0)'), t = a.get('today()');
  a.run('render()');
  assert.match(a.app(), /ess-today[\s\S]*Pizza/);
  const shown = (a.app().match(/class="ess-day"/g) || []).length;
  assert.equal(shown, d.filter(x => x > t).length || 0);
  a.run(`setEssWeek(1)`);
  assert.doesNotMatch(a.app(), /class="s-lbl">Heute</);
  assert.equal((a.app().match(/class="ess-day"/g) || []).length, 7);
});

test('Essen: Kochbuch mit Suche (Name und Zutat) und Filter', () => {
  const a = household();
  a.run(`setView('essen');setEssTab('buch')`);
  assert.match(a.app(), /id="essQ"/);
  a.run(`UI.essQ='hack';render()`);
  assert.match(a.app(), /Spaghetti Bolognese/);
  assert.doesNotMatch(a.app(), /Pfannkuchen/);
  a.run(`UI.essQ='';setEssTag('fisch')`);
  assert.match(a.app(), /Fischstäbchen/);
  assert.doesNotMatch(a.app(), /Pizza/);
  a.run(`UI.essQ='gibtsnicht';render()`);
  assert.match(a.app(), /Nichts gefunden/);
});

test('Bewerten: jedes Kind und jede/r Erwachsene direkt am Gericht, Antippen schaltet durch', () => {
  const a = household();
  a.run(`openAdmin();openAdultModal();adultQuick('Mama','👩');saveAdult();closeAdmin()`); a.flush();
  const [k1, k2] = a.get('S.kids').map(k => k.id), mama = a.get('S.household.adults[0].id');
  a.run(`setView('essen');setEssTab('buch')`);
  const chips = (a.app().match(/rate-chip/g) || []).length;
  assert.equal(chips, 7 * 3); // 7 Gerichte × (2 Kinder + 1 Erwachsene)
  const w = () => a.get(`dishWeight(dishById('g1'),'abend',today(),null)`);
  a.run(`rateDish('g1','${k1}')`); assert.equal(a.get(`dishById('g1').ratings['${k1}']`), 1);
  a.run(`rateDish('g1','${k1}')`); assert.equal(a.get(`dishById('g1').ratings['${k1}']`), -1);
  a.run(`rateDish('g1','${k1}')`); assert.equal(a.get(`dishById('g1').ratings['${k1}']`), undefined);
  a.run(`rateDish('g1','${k2}');rateDish('g1','${mama}')`);
  assert.ok(Math.abs(w() - 1.6 * 1.6) < 1e-9); // Erwachsene zählen mit
  a.run(`rateDish('g1','${mama}')`);
  assert.ok(Math.abs(w() - 1.6 * 0.4) < 1e-9);
  a.run(`rateDish('g1','fremd')`);
  assert.equal(a.get(`dishById('g1').ratings.fremd`), undefined);
  assert.match(a.app(), /aria-label="Mama: mag es nicht\. Tippen zum Ändern"/);
  // auch in der Rezeptansicht, Fenster bleibt offen
  a.run(`openRecipe('g1');rateDish('g1','${k1}')`);
  assert.equal(a.els.mb.classList.contains('open'), true);
  assert.match(a.els.mc.innerHTML, /rate-chip up/);
  // Bewertungen von Erwachsenen überstehen Neustart und Import
  const b = load(VORLAGE, { storage: a.store });
  assert.equal(b.get(`dishById('g1').ratings['${mama}']`), -1);
});

test('Rezept-Formular: Portionen ändern rechnet die Zutaten mit um, ohne Rundungsfehler', () => {
  const a = household();
  a.run(`openDishPrefilled({name:'Rührei',portions:2,ingr:['2 Eier','250 g Mehl','2 Dosen Tomaten','½ Bund Dill','1,5 kg Kartoffeln','Salz','  3 EL Öl']})`);
  const ingr = () => a.get('UI.form.ingr').split('\n');
  a.run(`dishPortions('4')`);
  assert.deepEqual(ingr(), ['4 Eier', '500 g Mehl', '4 Dosen Tomaten', '1 Bund Dill', '3 kg Kartoffeln', 'Salz', '6 EL Öl']); // Leerzeichen am Anfang entfernt schon die Übernahme
  a.run(`dishPortions('3')`);
  assert.deepEqual(ingr().slice(0, 4), ['3 Eier', '375 g Mehl', '3 Dosen Tomaten', '0,75 Bund Dill']);
  a.run(`dishPortions('')`); // beim Tippen kurz leer: nichts verändern
  assert.equal(ingr()[0], '3 Eier');
  a.run(`dishPortions('2')`);
  assert.deepEqual(ingr(), ['2 Eier', '250 g Mehl', '2 Dosen Tomaten', '1 Bund Dill'.replace('1', '0,5'), '1,5 kg Kartoffeln', 'Salz', '3 EL Öl']);
  // von Hand geändert: das ist die neue Grundlage
  a.run(`UI.form.ingr='1 Ei\\n100 g Käse';dishIngrBase();dishPortions('6')`);
  assert.deepEqual(ingr(), ['3 Ei', '300 g Käse']);
  a.run('saveDish()');
  const d = a.get('S.essen.dishes.at(-1)');
  assert.deepEqual([d.portions, d.ingr], [6, ['3 Ei', '300 g Käse']]);
  // bestehendes Gericht bearbeiten: Grundlage ist der gespeicherte Stand
  a.run(`openDishModal('${d.id}');dishPortions('2')`);
  assert.deepEqual(ingr(), ['1 Ei', '100 g Käse']);
});

// ─── Navigation: Ansicht merken, Zurück-Taste ─────────────────
test('Navigation: App öffnet wieder dort, wo man war (Bereich, Kochbuch, Kind)', () => {
  const a = household();
  const k2 = a.get('S.kids[1].id');
  a.run(`setView('essen');setEssTab('buch');setKid('${k2}')`);
  const b = load(VORLAGE, { storage: a.store });
  assert.equal(b.get('UI.view'), 'essen');
  assert.equal(b.get('UI.essTab'), 'buch');
  assert.equal(b.get('UI.kid'), k2);
  assert.match(b.app(), /Kochbuch/);
  // ausgeschaltetes Modul oder Unsinn: zurück zum Start
  b.run(`togModule('essen')`);
  const c = load(VORLAGE, { storage: { ...b.store, famos_ui: JSON.stringify({ view: 'essen', essTab: '<x>', kid: 'weg' }) } });
  assert.notEqual(c.get('UI.view'), 'essen');
  assert.equal(c.get('UI.essTab'), 'plan');
});

test('Navigation: Zurück schließt erst Fenster, dann Einstellungen, dann zweimal zum Beenden', () => {
  let pushes = 0, backs = 0, pop = null;
  const window = { location: { protocol: 'file:' }, history: { replaceState() {}, pushState() { pushes++; }, back() { backs++; } },
    addEventListener: (ev, fn) => { if (ev === 'popstate') pop = fn; }, matchMedia: () => ({ matches: false }), navigator: {} };
  const a = load(VORLAGE, { globals: { window } });
  a.run(`openKidModal(null);UI.form.name='Emma';saveKid();obFinish()`); a.flush();
  a.run('closeModal()');
  assert.equal(typeof pop, 'function');
  const p0 = pushes;
  a.run(`openAdmin();setATab('module');openTgMoveModal('ein')`);
  pop(); assert.equal(a.els.mb.classList.contains('open'), false); assert.equal(a.els.adm.classList.contains('open'), true);
  pop(); assert.equal(a.els.adm.classList.contains('open'), false);
  assert.equal(pushes, p0 + 2); // Merk-Eintrag jeweils erneuert, App bleibt offen
  pop(); assert.match(a.toast(), /nochmal zurück/); assert.equal(backs, 0);
  pop(); assert.equal(backs, 1); // zweites Zurück kurz danach: App darf schließen
});

// ─── Navigation: Kinder-Bereich, Haushalte ohne Kinder ────────
test('Navigation: unten Kinder · Essen · Einkauf, Kinder bündelt Routine, Stundenplan, Geld', () => {
  const a = household();
  const nav = () => [...a.app().matchAll(/<button class="bni[^"]*" onclick="([^"]+)"><span class="bni-ic">[\s\S]*?<\/span>([^<]+)<\/button>/g)].map(m => m[2]);
  assert.deepEqual(nav(), ['Heute', 'Kinder', 'Aufgaben', 'Kalender', 'Essen', 'Einkauf']);
  assert.equal(a.get('UI.view'), 'routine'); // nach dem Onboarding mit Kindern: Routine
  assert.match(a.app(), /class="seg seg-4"/);
  assert.match(a.app(), />Stundenplan</);
  a.run(`setView('taschengeld');setView('essen');goKinder()`);
  assert.equal(a.get('UI.view'), 'taschengeld'); // Kinder merkt sich den Unterbereich
  assert.match(a.app(), /class="bni on" onclick="goKinder\(\)"/);
  a.run(`togModule('stundenplan');togModule('taschengeld');togModule('wuensche');goKinder()`);
  assert.doesNotMatch(a.app(), /class="seg seg-/); // nur ein Kinder-Bereich: kein Umschalter
});

test('Haushalt ohne Kinder: Onboarding nur mit Erwachsenen, kein Kinder-Reiter', () => {
  const a = load(VORLAGE);
  a.run(`openAdultModal();adultQuick('Alex','🙂');saveAdult();ob().name='WG';obFinish()`);
  assert.equal(a.get('S.household.name'), 'WG');
  assert.deepEqual(a.get('S.kids'), []);
  assert.equal(a.get('UI.view'), 'heute');
  assert.doesNotMatch(a.app(), /goKinder|kid-tabs/);
  a.run(`setView('routine')`); // per altem Link/Speicherstand: wird umgeleitet
  assert.equal(a.get('UI.view'), 'heute');
  // letzte Person lässt sich nicht entfernen, erstes Kind schaltet Kinder-Reiter frei
  a.run(`openAdmin();delAdult(S.household.adults[0].id)`);
  assert.match(a.toast(), /Mindestens eine Person/);
  a.run(`openKidModal(null);UI.form.name='Mia';saveKid();render()`);
  assert.match(a.app(), /goKinder/);
});

// ─── Aufgaben ─────────────────────────────────────────────────
function todoApp() {
  const a = household();
  a.run(`openAdmin();openAdultModal();adultQuick('Mama','👩');saveAdult();openAdultModal();adultQuick('Papa','👨');saveAdult();closeAdmin()`); a.flush();
  a.run(`setView('aufgaben')`);
  return a;
}
const addT = (a, title) => { a.run(`UI.todoNew=${JSON.stringify(title)};addTodoInput()`); return a.get('S.aufgaben.items.at(-1).id'); };

test('Aufgaben: eintragen, Filter nach Person (merkt sich das Gerät), irgendwer erscheint bei allen', () => {
  const a = todoApp();
  const [mama, papa] = a.get('S.household.adults.map(x=>x.id)');
  assert.match(a.app(), /Noch keine Aufgaben/);
  addT(a, 'Steuererklärung');
  a.run(`setTodoWho('${mama}')`);
  const t2 = addT(a, 'Geschenk für Paul besorgen');
  assert.deepEqual(a.get(`S.aufgaben.items.find(x=>x.id==='${t2}').who`), [mama]); // Filter aktiv: gehört Mama
  assert.match(a.app(), /Steuererklärung/); // irgendwer: auch bei Mama
  a.run(`setTodoWho('${papa}')`);
  assert.doesNotMatch(a.app(), /Geschenk für Paul/);
  assert.match(a.app(), /Neue Aufgabe für Papa/);
  const b = load(VORLAGE, { storage: a.store });
  assert.equal(b.get('UI.todoWho'), papa);
});

test('Aufgaben: nach Fälligkeit gruppiert, Bearbeiten mit Schnellwahl für Datum', () => {
  const a = todoApp();
  const ids = ['Alt', 'Heute', 'Bald', 'Später', 'Irgendwann'].map(t => addT(a, t));
  const set = (id, due) => a.run(`openTodo('${id}');UI.form.due=${JSON.stringify(due)};saveTodo()`);
  set(ids[0], a.get('addDays(today(),-3)'));
  a.run(`openTodo('${ids[1]}');todoSetDue(today());saveTodo()`);
  set(ids[3], a.get('addDays(today(),20)'));
  const buckets = [...a.app().matchAll(/class="ek-cat[^"]*">([^·<]+) ·/g)].map(m => m[1].trim());
  assert.deepEqual(buckets.filter(x => x !== 'Diese Woche'), ['Überfällig', 'Heute', 'Später', 'Ohne Datum']);
  assert.match(a.app(), /class="ek-row over"/);
  assert.match(a.app(), /seit /);
  a.run(`openTodo('${ids[2]}');UI.form.title='  ';saveTodo()`);
  assert.match(a.toast(), /was zu tun ist/);
});

test('Aufgaben: wiederkehrende springen beim Abhaken auf den nächsten Termin, auch wenn überfällig', () => {
  const a = todoApp();
  const id = addT(a, 'Müll rausbringen');
  const td = a.get('today()');
  a.run(`openTodo('${id}');UI.form.rep='w';UI.form.due=addDays(today(),-10);saveTodo()`);
  a.run(`toggleTodo('${id}')`);
  const t = a.get(`S.aufgaben.items.find(x=>x.id==='${id}')`);
  assert.equal(t.done, false);
  assert.ok(t.due > td && a.get(`daysBetween(today(),'${t.due}')`) <= 7, t.due);
  assert.equal(a.get(`daysBetween(addDays(today(),-10),'${t.due}')`) % 7, 0); // gleicher Wochentag
  assert.match(a.toast(), /Nächstes Mal/);
  // ohne Datum + Wiederholung: Start heute
  const id2 = addT(a, 'Blumen gießen');
  a.run(`openTodo('${id2}');UI.form.rep='d';saveTodo()`);
  assert.equal(a.get(`S.aufgaben.items.find(x=>x.id==='${id2}').due`), td);
  // Monatlich am 31.: im kürzeren Monat der letzte Tag
  assert.equal(a.get(`addMonths('2027-01-31',1)`), '2027-02-28');
});

test('Aufgaben: einmalige abhaken, wer erledigt hat, Erledigte entfernen', () => {
  const a = todoApp();
  const mama = a.get('S.household.adults[0].id');
  a.run(`setTodoWho('${mama}')`);
  const id = addT(a, 'Kita-Formular');
  a.run(`toggleTodo('${id}')`);
  assert.match(a.app(), /Erledigt · 1/);
  assert.match(a.app(), /✓ Mama/);
  a.run(`toggleTodo('${id}')`); // zurück
  assert.equal(a.get(`S.aufgaben.items[0].done`), false);
  a.run(`toggleTodo('${id}');clearTodosDone()`);
  assert.deepEqual(a.get('S.aufgaben.items'), []);
});

test('Aufgaben: Kinder sehen ihre heutigen Aufgaben in der Routine und haken sie ab', () => {
  const a = todoApp();
  const [k1, k2] = a.get('S.kids.map(k=>k.id)');
  const id = addT(a, 'Zimmer aufräumen'), later = addT(a, 'Bastelsachen für Freitag');
  a.run(`openTodo('${id}');UI.form.who=['${k1}'];UI.form.due=today();saveTodo()`);
  a.run(`openTodo('${later}');UI.form.who=['${k1}'];UI.form.due=addDays(today(),5);saveTodo()`);
  a.run(`setView('routine');setKid('${k1}')`);
  assert.match(a.app(), /Meine Aufgaben[\s\S]*Zimmer aufräumen/);
  assert.doesNotMatch(a.app(), /Bastelsachen/); // erst später dran
  assert.doesNotMatch(a.app(), /openTodo\(/); // Kinder können nur abhaken
  a.run(`toggleTodo('${id}','${k1}')`);
  assert.equal(a.get(`S.aufgaben.items.find(x=>x.id==='${id}').doneBy`), k1);
  assert.match(a.app(), /class="ek-row done"[\s\S]*Zimmer aufräumen/); // bleibt heute sichtbar, abgehakt
  a.run(`setKid('${k2}')`);
  assert.doesNotMatch(a.app(), /Meine Aufgaben/);
});

test('Aufgaben: Import validiert, fremde Personen fallen weg, Schadcode bleibt Text', () => {
  const a = load(VORLAGE);
  const data = { cfg: { kids: [{ id: 'k1', name: 'Emma' }], household: { name: 'X' }, aufgaben: { items: [
    { id: 't1', title: '<img src=x onerror=alert(1)>', who: ['k1', 'fremd', 7], due: '2026-13-99x', rep: 'jährlich', done: 'ja' },
    { id: 't1', title: 'Doppelt' }, { id: 'x y', title: 'Böse' }, { id: 't2', title: '' },
  ] } } };
  assert.equal(a.run(`applyImport(${JSON.stringify(data)})`), true);
  assert.deepEqual(a.get('S.aufgaben.items'), [{ id: 't1', title: '<img src=x onerror=alert(1)>', note: '', who: ['k1'], due: '', rep: '', done: true, doneBy: '', doneAt: 0 }]);
  a.run(`setView('aufgaben')`);
  assert.doesNotMatch(a.app(), /<img/);
});

// ─── Wünsche ──────────────────────────────────────────────────
test('Wünsche: Kinder tragen ein, Anlass-Filter, besorgt und wer schenkt bleiben unsichtbar', () => {
  const a = household();
  const [k1, k2] = a.get('S.kids.map(k=>k.id)');
  a.run(`setView('wuensche');setKid('${k1}')`);
  assert.match(a.app(), /Was wünschst du dir\?/);
  a.run(`UI.wishNew='Lego Feuerwehr';addWishInput('${k1}');setWishOcc('weih');UI.wishNew='Schlitten';addWishInput('${k1}')`);
  assert.deepEqual(a.get(`S.wuensche.items.map(w=>[w.title,w.occ])`), [['Lego Feuerwehr', []], ['Schlitten', ['weih']]]);
  assert.match(a.app(), /Schlitten/);
  assert.doesNotMatch(a.app(), /Lego Feuerwehr/); // Filter Weihnachten
  a.run(`setWishOcc('');setKid('${k2}')`);
  assert.match(a.app(), /Noch keine Wünsche/); // pro Kind getrennt
  // Elternteil markiert als besorgt, mit Schenkenden
  a.run(`setKid('${k1}');wishParentOn()`);
  const id = a.get('S.wuensche.items[0].id');
  a.run(`openWish('${id}');UI.form.got=true;UI.form.from='Oma';saveWish()`);
  assert.match(a.app(), /von Oma/);
  assert.match(a.app(), /aria-pressed="true"/);
  a.run(`setView('routine');setView('wuensche')`); // Bereich verlassen: Eltern-Ansicht aus
  assert.equal(a.get('UI.wishParent'), false);
  assert.doesNotMatch(a.app(), /Oma|aria-pressed="true"/);
  a.run(`togWishGot('${id}')`); // ohne Eltern-Ansicht: keine Wirkung
  assert.equal(a.get(`S.wuensche.items[0].got`), true);
  a.run(`openWish('${id}')`);
  assert.doesNotMatch(a.els.mc.innerHTML, /Wer schenkt|Besorgt/);
});

test('Wünsche: Eltern-Ansicht verlangt die Eltern-PIN, falls gesetzt', () => {
  const a = household();
  a.run(`openPinSetModal();UI.form.p1='4711';UI.form.p2='4711';savePin();closeAdmin()`); a.flush();
  a.run(`UI.unlockUntil=0;setView('wuensche');wishParentOn()`);
  assert.equal(a.get('UI.wishParent'), undefined);
  assert.equal(a.get('UI.form.mode'), 'pin');
  a.run(`UI.form.pin='4711';pinSubmit()`);
  assert.equal(a.get('UI.wishParent'), true);
});

test('Wünsche: nur sichere Links, Import validiert, Schadcode bleibt Text', () => {
  const a = household();
  const k1 = a.get('S.kids[0].id');
  a.run(`setView('wuensche');UI.wishNew='Buch';addWishInput('${k1}');openWish(S.wuensche.items[0].id);UI.form.link='javascript:alert(1)';saveWish()`);
  assert.match(a.toast(), /https:\/\//);
  a.run(`UI.form.link='https://www.beispiel.de/buch?id=1';saveWish()`);
  assert.match(a.app(), /href="https:\/\/www\.beispiel\.de\/buch\?id=1" target="_blank" rel="noopener noreferrer"/);
  a.run('wishParentOn()');
  assert.doesNotMatch(a.app(), /<button[^>]*>(?:(?!<\/button>)[\s\S])*<a /); // kein Link im Knopf
  const b = load(VORLAGE);
  const data = { cfg: { kids: [{ id: 'k1', name: 'Emma' }], household: { name: 'X' }, wuensche: { items: [
    { id: 'w1', kid: 'k1', title: '<img src=x onerror=alert(1)>', link: 'javascript:alert(1)', occ: ['geb', 'ostern'], got: 1, from: 'Oma' },
    { id: 'w2', kid: 'fremd', title: 'Fremdes Kind' }, { id: 'w1', kid: 'k1', title: 'Doppelt' },
  ] } } };
  assert.equal(b.run(`applyImport(${JSON.stringify(data)})`), true);
  assert.deepEqual(b.get('S.wuensche.items'), [{ id: 'w1', kid: 'k1', title: '<img src=x onerror=alert(1)>', link: '', occ: ['geb'], note: '', got: true, from: 'Oma' }]);
  b.run(`setView('wuensche')`);
  assert.doesNotMatch(b.app(), /<img|javascript:/);
});

// ─── Heute, Gerät, Auszahlungstag ─────────────────────────────
function homeApp(opts) {
  const a = household(opts);
  a.run(`openAdmin();openAdultModal();adultQuick('Mama','👩');saveAdult();openAdultModal();adultQuick('Papa','👨');saveAdult();closeAdmin()`); a.flush();
  return a;
}
test('Gerät: einmal fragen, wer es nutzt; Familiengerät möglich; „Später“ fragt nicht nochmal', () => {
  const a = homeApp();
  const mama = a.get('S.household.adults[0].id');
  a.run(`closeModal();setView('heute')`); a.flush(); // nicht über ein anderes offenes Fenster
  assert.equal(a.get('UI.form.mode'), 'who');
  assert.match(a.els.mc.innerHTML, /Familiengerät \(für die Kinder\)/);
  a.run(`setMe('${mama}')`);
  assert.equal(a.get('getMe()'), mama);
  assert.equal(a.get('UI.todoWho'), mama); // Aufgaben-Filter folgt
  assert.match(a.app(), /Hallo|Guten (Morgen|Abend), Mama/);
  const b = load(VORLAGE, { storage: { ...a.store, famos_me: '' } });
  b.run(`closeModal();localStorage.setItem('famos_me_later','1');setView('heute')`); b.flush();
  assert.notEqual(b.get('UI.form.mode'), 'who');
  b.run(`openAdmin();setATab('kinder')`);
  assert.match(b.adm(), /Noch nicht zugeordnet/);
  b.run(`setMe('family')`);
  assert.match(b.adm(), /Familiengerät/);
  assert.equal(b.get('getMe()'), 'family');
  // gelöschte Person: Zuordnung gilt nicht mehr
  const c = load(VORLAGE, { storage: { ...a.store, famos_me: 'weg' } });
  assert.equal(c.get('getMe()'), '');
});

test('Heute: meine fälligen Aufgaben (abhakbar), Essen mit Würfeln, Kinder mit Routine und Brot, Einkauf eintragen', () => {
  const a = homeApp();
  const [mama, papa] = a.get('S.household.adults.map(x=>x.id)'), k1 = a.get('S.kids[0].id');
  a.run(`setMe('${mama}')`);
  const T = (title, who, due) => a.run(`S.aufgaben.items.push({id:uid(),title:${JSON.stringify(title)},note:'',who:${JSON.stringify(who)},due:${due},rep:'',done:false,doneBy:'',doneAt:0})`);
  T('Kita-Formular', [mama], 'addDays(today(),-1)'); T('Reifen', [papa], 'today()'); T('Fotos', [], 'today()'); T('Später', [mama], 'addDays(today(),3)');
  a.run(`togBrot('morgen');UI.kid='${k1}';UI.rt='morgen';setBrot('ja');setView('heute')`); a.flush(); a.run('closeModal()');
  const html = a.app();
  assert.match(html, /Meine Aufgaben[\s\S]*Kita-Formular/);
  assert.match(html, /Fotos/); // irgendwer
  assert.doesNotMatch(html, /Reifen|Später/); // Papas / nicht fällig
  assert.match(html, /Essen heute[\s\S]*noch offen[\s\S]*rollToday\('abend'\)/);
  assert.match(html, /Kinder heute[\s\S]*Morgenroutine 0\/6[\s\S]*🍞 braucht ein Brot/);
  a.run(`toggleTodo(S.aufgaben.items[0].id)`);
  assert.doesNotMatch(a.app(), /Kita-Formular/);
  a.run(`document.getElementById('homeEk').value='Milch';homeEkAdd()`);
  assert.deepEqual(a.get('S.einkauf.items.map(x=>x.name)'), ['Milch']);
  assert.match(a.app(), /Einkauf · 1 Ding/);
  a.run(`rollToday('abend')`);
  assert.match(a.app(), /Essen heute[\s\S]*home-link/);
});

test('Heute: Familiengerät zeigt Aufgaben aller, ohne Taschengeld-Entscheidungen; leere Karten fallen weg', () => {
  const a = homeApp();
  a.run(`setMe('family');togModule('einkauf');togModule('essen');S.kids.forEach(k=>{S.routines.morgen.tasks=[]});S.tgPay=(new Date().getDay()+6)%7;S.tgPaySince=today();togTgAktiv(S.kids[0].id);setView('heute')`);
  assert.match(a.app(), /Aufgaben heute|Heute steht nichts an|Kinder heute/);
  assert.doesNotMatch(a.app(), /Taschengeld .* fällig|tgDecide/);
  assert.doesNotMatch(a.app(), /Essen heute|Einkauf/);
});

test('Taschengeld: Auszahlungstag macht es heute fällig, danach überfällig, auch für die Vorwoche', () => {
  const a = homeApp();
  const [k1, k2] = a.get('S.kids.map(k=>k.id)'), mama = a.get('S.household.adults[0].id');
  a.run(`setMe('${mama}');togTgAktiv('${k1}');openTgBetragModal('${k1}');UI.form.betrag='2';saveTgBetrag()`);
  const dow = a.get('(new Date().getDay()+6)%7');
  a.run(`openAdmin();setATab('taschengeld')`);
  assert.match(a.adm(), /Auszahlungstag/);
  a.run(`setTgPay(${dow})`); // heute ist Auszahlungstag
  assert.equal(a.get('S.tgPaySince'), a.get('today()'));
  let due = a.get('tgDue()');
  assert.equal(due.length, 1); // nur das aktive Kind
  assert.deepEqual([due[0].kid.id, due[0].over, due[0].amt], [k1, false, 2]);
  a.run(`closeAdmin()`); a.flush(); a.run(`setView('heute')`); a.flush(); a.run('closeModal()');
  assert.match(a.app(), /Emma · 2,00 €[\s\S]*Taschengeld · heute fällig/);
  a.run(`setView('aufgaben')`);
  assert.match(a.app(), /Emma · 2,00 €/); // auch unter Aufgaben
  // Entscheiden: ins Sparschwein, Karte verschwindet
  a.run(`tgDecide('${k1}',weekKey(),'gespart')`);
  assert.equal(a.get(`SAVINGS['${k1}']`), 2);
  assert.deepEqual(a.get('tgDue()'), []);
  // Vorwoche: Auszahlungstag lag in der Vergangenheit, nichts entschieden → überfällig, mit richtiger KW
  a.run(`S.tgPaySince=addDays(today(),-14)`);
  due = a.get('tgDue()').filter(x => x.wk !== a.get('weekKey()'));
  assert.ok(due.length >= 1);
  assert.equal(due[0].over, true);
  a.run(`tgDecide('${k1}','${due[0].wk}','gespart')`);
  assert.equal(a.get(`TX.at(-1).note`), `Wochengeld gespart (KW ${Number(due[0].wk.slice(5))})`);
  // vor dem Festlegen liegende Wochen zählen nicht
  a.run(`S.tgPaySince=today();TGD={}`);
  assert.ok(a.get('tgDue()').every(x => x.pay >= a.get('today()')));
  a.run(`setTgPay(-1)`);
  assert.deepEqual(a.get('tgDue()'), []);
});

test('Taschengeld: Auszahlungstag wird beim Import geprüft und gleicht sich ab', () => {
  const a = load(VORLAGE);
  a.run(`applyImport(${JSON.stringify({ cfg: { kids: [{ id: 'k1', name: 'E' }], household: { name: 'X' }, tgPay: 9, tgPaySince: '<x>' } })})`);
  assert.deepEqual([a.get('S.tgPay'), a.get('S.tgPaySince')], [-1, '']);
  a.run(`applyImport(${JSON.stringify({ cfg: { kids: [{ id: 'k1', name: 'E' }], household: { name: 'X' }, tgPay: 5, tgPaySince: '2026-11-01' } })})`);
  assert.deepEqual([a.get('S.tgPay'), a.get('S.tgPaySince')], [5, '2026-11-01']);
});

// ─── Erwachsene mit Name und Emoji, Emoji-Auswahl ─────────────
test('Erwachsene: eigener Name und Emoji, Vorschläge optional, nachträglich bearbeiten', () => {
  const a = load(VORLAGE);
  a.run(`openAdultModal()`);
  assert.match(a.els.mc.innerHTML, /id="emA"/);
  assert.match(a.els.mc.innerHTML, /Vorschläge/);
  a.run(`UI.form.name='  Sam  ';UI.form.icon='🧑‍🍳';saveAdult()`);
  assert.deepEqual(a.get('ob().adults.map(x=>[x.name,x.icon])'), [['Sam', '🧑‍🍳']]);
  a.run(`openAdultModal(ob().adults[0].id);UI.form.name='Sam K.';saveAdult()`);
  assert.equal(a.get('ob().adults.length'), 1);
  assert.equal(a.get('ob().adults[0].name'), 'Sam K.');
  a.run(`ob().name='WG';obFinish()`);
  const id = a.get('S.household.adults[0].id');
  a.run(`openAdmin();setATab('kinder')`);
  assert.match(a.adm(), new RegExp(`openAdultModal\\('${id}'\\)`));
  a.run(`openAdultModal('${id}');UI.form.icon='🦸';UI.form.name='Sam';saveAdult()`);
  assert.deepEqual(a.saved('ra_cfg3').household.adults.map(x => [x.name, x.icon]), [['Sam', '🦸']]);
  a.run(`openAdultModal('${id}')`);
  assert.doesNotMatch(a.els.mc.innerHTML, /Vorschläge/); // beim Bearbeiten keine Vorschläge
  a.run(`UI.form.name='';saveAdult()`);
  assert.match(a.toast(), /Namen/);
});

test('Emoji-Auswahl: viele Kategorien, alles gültig, eigenes Emoji über die Tastatur', () => {
  const a = household();
  const EC = a.get('EC');
  assert.ok(EC.length >= 15, String(EC.length));
  assert.ok(EC.reduce((n, c) => n + c.e.length, 0) >= 500);
  for (const c of EC) {
    assert.equal(new Set(c.e).size, c.e.length, `Doppelt in ${c.id}`);
    for (const e of c.e) assert.equal(a.get(`epOwnOk(${JSON.stringify(e)})`), e, `${c.id}: ${e}`);
  }
  for (const bad of ['abc', '<b>', '1', '', 'A🙂', '"><img']) assert.equal(a.get(`epOwnOk(${JSON.stringify(bad)})`), '', bad);
  a.run(`openKidModal(S.kids[0].id);epOpen(e=>{UI.form.icon=e});document.getElementById('epOwn').value='🦩';epOwnPick()`);
  assert.equal(a.get('UI.form.icon'), '🦩');
  a.run(`epOpen(e=>{UI.form.icon=e});document.getElementById('epOwn').value='Hallo';epOwnPick()`);
  assert.match(a.toast(), /Emoji eintippen/);
  assert.equal(a.get('UI.form.icon'), '🦩');
});

// ─── Kalender ───
function cal() {
  const a = household();
  a.run(`setView('kalender')`);
  const add = f => { a.run(`openCal();Object.assign(UI.form,${JSON.stringify(f)});saveCal()`); return a.get('S.kalender.items.at(-1).id'); };
  return { a, add, td: a.get('today()'), day: n => a.get(`addDays(today(),${n})`) };
}

test('Kalender: Termin anlegen, Liste nach Tagen, bearbeiten, löschen', () => {
  const { a, add, td, day } = cal();
  assert.match(a.app(), /Noch keine Termine/);
  a.run('openCal();saveCal()');
  assert.match(a.toast(), /was ansteht/);
  const id = add({ title: 'Kinderarzt', day: day(2), from: '15:30', to: '16:00', place: 'Praxis', who: [a.get('S.kids[0].id')] });
  add({ title: 'Oma kommt', day: td });
  assert.deepEqual(a.get('S.kalender.items[0]'), { id, title: 'Kinderarzt', day: day(2), end: '', from: '15:30', to: '16:00', place: 'Praxis', note: '', who: [a.get('S.kids[0].id')], rep: '' });
  const html = a.app();
  assert.match(html, /Heute · [\s\S]*Oma kommt[\s\S]*ganztägig|Heute · [\s\S]*ganztägig[\s\S]*Oma kommt/);
  assert.ok(html.indexOf('Oma kommt') < html.indexOf('Kinderarzt')); // nach Tagen sortiert
  assert.match(html, /15:30<small>bis 16:00<\/small>/);
  assert.match(html, /📍 Praxis/);
  assert.equal(a.saved('ra_cfg3').kalender.items.length, 2);
  a.run(`openCal('${id}');UI.form.title='Zahnarzt';UI.form.to='';saveCal()`);
  assert.deepEqual(a.get('[S.kalender.items[0].title,S.kalender.items[0].to]'), ['Zahnarzt', '']);
  a.run(`openCal('${id}');delCal()`);
  assert.deepEqual(a.get('S.kalender.items.map(e=>e.title)'), ['Oma kommt']);
  // Vergangenes steht nicht in der Liste, Fernes erst nach „Weiter schauen“
  add({ title: 'War gestern', day: day(-1) });
  add({ title: 'In 50 Tagen', day: day(50) });
  assert.doesNotMatch(a.app(), /War gestern|In 50 Tagen/);
  a.run('calMore()');
  assert.match(a.app(), /In 50 Tagen/);
});

test('Kalender: Eingaben werden geprüft und bereinigt', () => {
  const { a, add, td, day } = cal();
  const bad = (f, re) => { a.run(`openCal();Object.assign(UI.form,${JSON.stringify(f)});saveCal()`); assert.match(a.toast(), re); assert.equal(a.get('S.kalender.items.length'), 0); };
  bad({ title: 'x', day: '2026-02-31' }, /Tag wählen/);
  bad({ title: 'x', day: '' }, /Tag wählen/);
  bad({ title: 'x', day: td, end: day(-1) }, /letzte Tag/);
  bad({ title: 'x', day: td, from: '10:00', to: '09:00' }, /Endzeit/);
  bad({ title: 'x', day: td, to: '09:00' }, /Anfangszeit/);
  const S = a.get(`sanitizeKalender({items:[
    {id:'a',title:'<b>ok</b>',day:'2026-03-01',end:'2026-03-01',from:'25:00',to:'10:00',who:['fremd'],rep:'x',place:'p'.repeat(200)},
    {id:'a',title:'doppelt',day:'2026-03-01'},{id:'b',title:'',day:'2026-03-01'},{id:'c',title:'kein Tag',day:'2026-13-01'},
    {id:'__proto__',title:'x',day:'2026-03-01'},{id:'d',title:'jährlich',day:'2026-03-01',end:'2026-03-05',rep:'y'}]},['k1'])`);
  assert.deepEqual(S.items.map(e => e.id), ['a', 'd']);
  assert.deepEqual([S.items[0].end, S.items[0].from, S.items[0].to, S.items[0].who, S.items[0].rep, S.items[0].place.length], ['', '', '', [], '', 80]);
  assert.equal(S.items[1].end, ''); // Wiederholung und mehrtägig schließen sich aus
  // Titel wird beim Anzeigen maskiert
  add({ title: '<img src=x onerror=1>', day: td, place: '"><script>' });
  assert.doesNotMatch(a.app(), /<img src=x|<script>/);
  assert.match(a.app(), /&lt;img src=x/);
});

test('Kalender: Wiederholung wöchentlich und jährlich, mehrtägig, 29. Februar', () => {
  const { a, add, td, day } = cal();
  const on = (e, ds) => a.get(`calOn(${JSON.stringify(e)},'${ds}')`);
  const w = { day: '2026-11-04', rep: 'w', end: '' };
  assert.deepEqual(['2026-11-04', '2026-11-11', '2026-11-12', '2026-10-28', '2027-03-31'].map(d => on(w, d)), [true, true, false, false, true]); // auch über die Zeitumstellung
  const y = { day: '2020-02-29', rep: 'y', end: '' };
  assert.deepEqual(['2024-02-29', '2025-02-28', '2024-02-28', '2025-03-01', '2019-02-28'].map(d => on(y, d)), [true, true, false, false, false]);
  const m = { day: '2026-12-30', rep: '', end: '2027-01-02' };
  assert.deepEqual(['2026-12-29', '2026-12-30', '2027-01-01', '2027-01-02', '2027-01-03'].map(d => on(m, d)), [false, true, true, true, false]);
  // Liste: Wöchentliches an jedem Termin, Mehrtägiges nur einmal
  add({ title: 'Turnen', day: td, from: '16:00', rep: 'w' });
  add({ title: 'Urlaub', day: day(-2), end: day(5) });
  const html = a.app();
  assert.equal(html.match(/Turnen/g).length, 5); // 30 Tage: heute + 4 Wochen
  assert.equal(html.match(/Urlaub/g).length, 1);
  assert.match(html, /Heute · [\s\S]*Urlaub/);
  assert.match(html, /↻ wöchentlich/);
});

test('Kalender: Monatsansicht mit Punkten, Tag wählen, Monat wechseln', () => {
  const { a, add } = cal();
  a.run(`UI.calMonth='2027-02';UI.calSel='2027-02-10';setCalTab('monat')`);
  add({ title: 'Fasching', day: '2027-02-09' });
  a.run(`setCalSel('2027-02-10')`);
  let html = a.app();
  assert.match(html, /Februar 2027/);
  assert.equal(html.match(/class="cal-d[ "]/g).length, 28); // Februar 2027 beginnt montags: genau 4 Wochen
  assert.match(html, /aria-label="9\.2\., 1 Termin"[^>]*>9<span class="cal-dots"><i><\/i><\/span>/);
  assert.match(html, /Nichts eingetragen/);
  a.run(`setCalSel('2027-02-09')`);
  assert.match(a.app(), /class="ek-cat">Di, 09\.02\.2027<\/div>[\s\S]*Fasching/);
  a.run('calShift(1)');
  html = a.app();
  assert.match(html, /März 2027/);
  assert.equal(html.match(/class="cal-d[ "]/g).length, 35);
  assert.match(html, /openCal\('','2027-03-01'\)/); // neuer Termin am gewählten Tag
  a.run('calShift(0)');
  assert.equal(a.get('UI.calMonth'), a.get('today().slice(0,7)'));
  a.run('calShift(-1);calShift(-1)');
  assert.equal(a.get('UI.calMonth'), a.get(`addMonths(today().slice(0,8)+'01',-2).slice(0,7)`));
});

test('Kalender: Filter nach Person, Kinder sehen ihre Termine nur zum Lesen, Startseite zeigt heute und morgen', () => {
  const { a, add, td, day } = cal();
  const [emma, ben] = a.get('S.kids.map(k=>k.id)');
  add({ title: 'Emma Flöte', day: td, from: '14:00', who: [emma] });
  add({ title: 'Ben Fußball', day: day(1), who: [ben] });
  add({ title: 'Familienfest', day: day(3) });
  add({ title: 'Emma später', day: day(9), who: [emma] });
  a.run(`setCalWho('${ben}')`);
  assert.doesNotMatch(a.app(), /Emma Flöte/);
  assert.match(a.app(), /Ben Fußball[\s\S]*Familienfest/); // Termine ohne Person betreffen alle
  // Kinder-Bereich: eigene + gemeinsame der nächsten 7 Tage, ohne Bearbeiten
  a.run(`setView('routine');setKid('${emma}')`);
  let html = a.app();
  assert.match(html, /Meine Termine[\s\S]*Emma Flöte[\s\S]*Familienfest/);
  assert.doesNotMatch(html, /Ben Fußball|Emma später|openCal\(/);
  // Startseite
  a.run(`setView('heute')`);
  html = a.app();
  assert.match(html, /Termine[\s\S]*Emma Flöte[\s\S]*Ben Fußball/);
  assert.match(html, /heute · [\s\S]*morgen · /);
  assert.doesNotMatch(html, /Familienfest/);
  // Modul aus: nirgends mehr sichtbar, Daten bleiben
  a.run(`togModule('kalender');render()`);
  assert.doesNotMatch(a.app(), /Emma Flöte|setView\('kalender'\)/);
  a.run(`setView('routine')`);
  assert.doesNotMatch(a.app(), /Meine Termine/);
  assert.equal(a.get('S.kalender.items.length'), 4);
});

test('Kalender: Backup enthält Termine, gelöschte Person verschwindet aus dem Termin', () => {
  const { a, add, td } = cal();
  const ben = a.get('S.kids[1].id');
  add({ title: 'Ben Schwimmen', day: td, who: [ben] });
  const backup = a.get('buildExport()');
  assert.equal(backup.cfg.kalender.items[0].title, 'Ben Schwimmen');
  const b = load(VORLAGE);
  assert.equal(b.get(`applyImport(${JSON.stringify(backup)})`), true);
  assert.deepEqual(b.get('S.kalender.items.map(e=>[e.title,e.who.length])'), [['Ben Schwimmen', 1]]);
  a.run(`delKid('${ben}');setView('kalender')`);
  assert.match(a.app(), /Ben Schwimmen[\s\S]*?alle/); // Anzeige sofort ohne die Person
  const c = load(VORLAGE, { storage: a.store }); // beim nächsten Start bereinigt
  assert.deepEqual(c.get('S.kalender.items[0].who'), []);
});
