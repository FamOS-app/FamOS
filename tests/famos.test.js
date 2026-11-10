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
    // Keine externe Quelle, auch keine Schrift: Andika ist eingebettet
    const hosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1])
      .filter(h => h !== 'www.w3.org'); // SVG-Namespace in Data-URLs, kein Request
    assert.deepEqual([...new Set(hosts)], []);
    assert.equal((html.match(/@font-face\{font-family:'Andika'/g) || []).length, 2);
    assert.match(html, /font-src data:;/);
    assert.doesNotMatch(html, /<link[^>]+stylesheet/);
    assert.doesNotMatch(html, /googleapis|gstatic|google-analytics|gtag/i);
    const js = extractScript(html);
    assert.doesNotMatch(js, /\balert\(|\beval\(|document\.write|XMLHttpRequest|new WebSocket/);
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
test('Vorlage: Erststart zeigt Onboarding, kein Haushalt ohne Kind', () => {
  const a = load(VORLAGE);
  assert.equal(a.get('S.household'), null);
  assert.match(a.app(), /Haushalt anlegen/);
  a.run('obFinish()');
  assert.equal(a.get('S.household'), null);
  assert.match(a.toast(), /mindestens ein Kind/);
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
  a.run(`togModule('stundenplan');togModule('essen');togModule('einkauf')`);
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
  assert.equal(a.get('TX').length, 2);
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
  assert.deepEqual(S.modules, { routine: true, stundenplan: true, taschengeld: true, essen: true, einkauf: true });
  assert.deepEqual(S.einkauf, { items: [], recent: [] });
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

test('Essen: Filter wirkt beim Würfeln, ohne Treffer gibt es einen Hinweis', () => {
  const a = essApp();
  a.run(`setEssTag('fisch');rollToday('abend')`);
  assert.ok(a.get(`dishById(planSlot(today(),'abend').id).tags`).includes('fisch'));
  a.run(`S.essen.dishes.forEach(d=>d.tags=d.tags.filter(t=>t!=='we'));setEssTag('we');S.essen.plan={};rollToday('abend')`);
  assert.equal(a.get(`planSlot(today(),'abend')`), null);
  assert.match(a.toast(), /Kein passendes Gericht/);
});

test('Essen: Gewichtung nach Bewertung, 👎 macht seltener statt auszuschließen', () => {
  const a = essApp();
  const [k1, k2] = a.get('S.kids').map(k => k.id);
  const w = () => a.get(`dishWeight(dishById('g1'),'abend',today(),null)`);
  assert.equal(w(), 1);
  a.run(`UI.kid='${k1}';rateDish('g1',1)`);
  assert.equal(w(), 1.6);
  a.run(`UI.kid='${k2}';rateDish('g1',-1)`);
  assert.ok(Math.abs(w() - 0.64) < 1e-9);
  a.run(`rateDish('g1',-1)`); // nochmal tippen nimmt die Bewertung zurück
  assert.equal(w(), 1.6);
  a.run(`UI.kid='${k1}';rateDish('g1',-1);UI.kid='${k2}';rateDish('g1',-1)`);
  assert.ok(w() > 0);
  assert.equal(a.get(`dishWeight(dishById('g6'),'abend',today(),null)`), 0); // Müsli passt nicht zum Abend
  a.run(`setEssTab('gerichte')`);
  assert.match(a.app(), /👎 2/);
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
  a.run(`rateDish('g2',1);rollToday('abend');togPin(today(),'abend')`);
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
  // Mengen gleicher Zeilen werden gezählt
  a.run(`setSlot('${dates[3]}','abend','g1',true);S.einkauf.items=[];ekFromPlan(1)`);
  assert.equal(a.get(`S.einkauf.items.find(x=>x.name==='1 Zwiebel').n`), 2);
  assert.match(a.app(), /×2/);
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
