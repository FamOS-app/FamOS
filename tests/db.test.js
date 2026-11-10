// Prüft supabase/migrations/*.sql in einer echten Postgres-Instanz (PGlite, ohne Server).
// Supabase-Umgebung wird minimal nachgebaut: Rollen anon/authenticated, auth.users, auth.uid(),
// Publication supabase_realtime. Aufruf: npm test  (oder node --test tests/db.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
create publication supabase_realtime;
-- wie bei Supabase: Erweiterungen liegen im Schema extensions, nicht im Suchpfad
create schema extensions;
create extension pgcrypto schema extensions;
`;

const U = {
  jana: '11111111-1111-1111-1111-111111111111',
  partner: '22222222-2222-2222-2222-222222222222',
  fremd: '33333333-3333-3333-3333-333333333333',
};

async function setup() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  for (const [k, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, k + '@example.org']);
  // wie der Supabase SQL-Editor: extensions im Suchpfad beim Anlegen; zur Laufzeit gilt der Suchpfad der Funktion
  await db.exec('set search_path to public, extensions;');
  for (const f of fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  }
  return db;
}

/** Führt SQL als angemeldete Person aus (wie PostgREST: Rolle + JWT-Claim, in einer Transaktion) */
async function as(db, who, sql, params = []) {
  return db.transaction(async tx => {
    if (who === 'anon') {
      await tx.exec(`set local role anon; select set_config('request.jwt.claim.sub', '', true);`);
    } else {
      await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${U[who]}', true);`);
    }
    return (await tx.query(sql, params)).rows;
  });
}
async function fails(p, re) {
  await assert.rejects(p, e => (re ? re.test(e.message) : true));
}

let db, hh;
test.before(async () => {
  db = await setup();
  [hh] = await as(db, 'jana', `select * from create_household('Familie Test')`);
});

test('DB: Haushalt anlegen macht mich zum Besitzer, Code hat 8 Zeichen ohne Verwechsler', async () => {
  assert.match(hh.invite_code, /^[A-HJKMNP-Z2-9]{8}$/);
  const m = await as(db, 'jana', 'select user_id, role from members');
  assert.deepEqual(m, [{ user_id: U.jana, role: 'owner' }]);
});

test('DB: Fremde sehen nichts und können nichts schreiben', async () => {
  await as(db, 'jana', `insert into docs (household_id, key, data) values ($1, 'cfg', '{"kids":[{"name":"Emma"}]}')`, [hh.id]);
  await as(db, 'jana', `insert into shopping_items (household_id, id, name) values ($1, 'i1', 'Milch')`, [hh.id]);
  for (const t of ['households', 'members', 'docs', 'shopping_items']) {
    assert.deepEqual(await as(db, 'fremd', `select * from ${t}`), [], t);
  }
  await fails(as(db, 'fremd', `insert into docs (household_id, key, data) values ($1, 'day', '{}')`, [hh.id]), /row-level security/);
  await fails(as(db, 'fremd', `insert into shopping_items (household_id, id, name) values ($1, 'x', 'Hack')`, [hh.id]), /row-level security/);
  const upd = await as(db, 'fremd', `update docs set data='{}' where household_id=$1 returning 1`, [hh.id]);
  assert.equal(upd.length, 0);
  const del = await as(db, 'fremd', `delete from shopping_items where household_id=$1 returning 1`, [hh.id]);
  assert.equal(del.length, 0);
  await fails(as(db, 'fremd', `insert into members (household_id, user_id) values ($1, $2)`, [hh.id, U.fremd]));
});

test('DB: Ohne Anmeldung (anon) gar kein Zugriff', async () => {
  for (const t of ['households', 'members', 'docs', 'shopping_items']) {
    await fails(as(db, 'anon', `select * from ${t}`), /permission denied/);
  }
  await fails(as(db, 'anon', `select * from create_household('X')`), /permission denied/);
  await fails(as(db, 'anon', `select * from join_household('ABCDEFGH')`), /permission denied/);
});

test('DB: Beitreten per Code, Groß-/Kleinschreibung und Leerzeichen egal', async () => {
  await fails(as(db, 'partner', `select * from join_household('XXXXXXXX')`), /Code ungültig/);
  const code = hh.invite_code.toLowerCase().replace(/(....)/, '$1 ');
  const [h] = await as(db, 'partner', `select * from join_household($1)`, [code]);
  assert.equal(h.id, hh.id);
  const docs = await as(db, 'partner', 'select data from docs');
  assert.equal(docs[0].data.kids[0].name, 'Emma');
  await as(db, 'partner', `select * from join_household($1)`, [hh.invite_code]); // doppelt: kein Fehler
  const m = await as(db, 'jana', 'select role from members order by role');
  assert.deepEqual(m.map(x => x.role), ['adult', 'owner']);
});

test('DB: Mitglieder dürfen nur den Namen ändern, nicht den Code; Code erneuern nur der Besitzer', async () => {
  await as(db, 'partner', `update households set name='Familie Neu' where id=$1`, [hh.id]);
  await fails(as(db, 'partner', `update households set invite_code='AAAAAAAA' where id=$1`, [hh.id]), /permission denied/);
  await fails(as(db, 'partner', `select rotate_invite($1)`, [hh.id]), /nur für den Besitzer/);
  const [{ rotate_invite: neu }] = await as(db, 'jana', `select rotate_invite($1)`, [hh.id]);
  assert.notEqual(neu, hh.invite_code);
  await fails(as(db, 'fremd', `select * from join_household($1)`, [hh.invite_code]), /Code ungültig/); // alter Code tot
  hh.invite_code = neu;
});

test('DB: Rollen und Mitgliedschaften lassen sich nicht selbst hochstufen', async () => {
  await fails(as(db, 'partner', `update members set role='owner' where user_id=$1`, [U.partner]), /permission denied/);
  const del = await as(db, 'partner', `delete from households where id=$1 returning 1`, [hh.id]);
  assert.equal(del.length, 0); // nur der Besitzer darf löschen
});

test('DB: Dokument-Version steigt bei jeder Änderung, Konflikte sind erkennbar', async () => {
  const [{ version: v1 }] = await as(db, 'jana', `select version from docs where household_id=$1 and key='cfg'`, [hh.id]);
  const ok = await as(db, 'partner', `update docs set data='{"kids":[]}' where household_id=$1 and key='cfg' and version=$2 returning version, updated_by`, [hh.id, v1]);
  assert.deepEqual(ok, [{ version: v1 + 1, updated_by: U.partner }]);
  // Jana schreibt mit veralteter Version: trifft keine Zeile → App weiß, dass sie neu laden muss
  const stale = await as(db, 'jana', `update docs set data='{"x":1}' where household_id=$1 and key='cfg' and version=$2 returning 1`, [hh.id, v1]);
  assert.equal(stale.length, 0);
  await fails(as(db, 'jana', `insert into docs (household_id, key, data) values ($1, 'geheim', '{}')`, [hh.id]), /check/);
});

test('DB: Einkaufsliste zeilenweise, Eingaben werden begrenzt', async () => {
  await as(db, 'partner', `insert into shopping_items (household_id, id, name) values ($1, 'i2', 'Brot')`, [hh.id]);
  await as(db, 'jana', `update shopping_items set done=true where household_id=$1 and id='i1'`, [hh.id]);
  const rows = await as(db, 'partner', 'select id, name, done from shopping_items order by id');
  assert.deepEqual(rows, [{ id: 'i1', name: 'Milch', done: true }, { id: 'i2', name: 'Brot', done: false }]);
  await fails(as(db, 'jana', `insert into shopping_items (household_id, id, name) values ($1, 'bad id!', 'x')`, [hh.id]), /check/);
  await fails(as(db, 'jana', `insert into shopping_items (household_id, id, name, n) values ($1, 'i3', 'x', 500)`, [hh.id]), /check/);
  await fails(as(db, 'jana', `insert into shopping_items (household_id, id, name) values ($1, 'i4', $2)`, [hh.id, 'x'.repeat(81)]), /check/);
});

test('DB: Austreten, Besitzer entfernt Mitglieder, Haushalt löschen räumt alles ab', async () => {
  await as(db, 'partner', `delete from members where user_id=$1`, [U.partner]);
  assert.deepEqual(await as(db, 'partner', 'select * from docs'), []);
  await as(db, 'partner', `select * from join_household($1)`, [hh.invite_code]);
  const removed = await as(db, 'jana', `delete from members where user_id=$1 returning 1`, [U.partner]);
  assert.equal(removed.length, 1);
  await as(db, 'jana', `delete from households where id=$1`, [hh.id]);
  const left = await db.query('select (select count(*) from docs) d, (select count(*) from shopping_items) s, (select count(*) from members) m');
  assert.deepEqual(left.rows[0], { d: 0, s: 0, m: 0 });
});

test('DB: höchstens 3 Haushalte pro Person, Realtime für docs und Einkauf aktiv', async () => {
  for (let i = 0; i < 3; i++) await as(db, 'fremd', `select * from create_household('H${i}')`);
  await fails(as(db, 'fremd', `select * from create_household('H4')`), /zu viele Haushalte/);
  const pub = await db.query(`select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1`);
  assert.deepEqual(pub.rows.map(r => r.tablename), ['docs', 'shopping_items']);
});
