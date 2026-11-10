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
    // Einzige externe Quelle: Bunny Fonts
    const hosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1])
      .filter(h => h !== 'www.w3.org'); // SVG-Namespace in Data-URLs, kein Request
    assert.deepEqual([...new Set(hosts)], ['fonts.bunny.net']);
    assert.doesNotMatch(html, /googleapis|gstatic|google-analytics|gtag/i);
    assert.doesNotMatch(extractScript(html), /\balert\(|\beval\(|document\.write|fetch\(|XMLHttpRequest/);
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

test('Build: genau index.html und manifest.webmanifest, Manifest als Datei', () => {
  assert.deepEqual(fs.readdirSync(DIST).sort(), ['index.html', 'manifest.webmanifest']);
  const m = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'FamOS');
  assert.equal(m.start_url, '.');
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
  a.run(`togModule('stundenplan')`);
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
  assert.deepEqual(S.modules, { routine: true, stundenplan: true, taschengeld: true });
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
