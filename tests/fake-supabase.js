// Nachgebauter Supabase-Server (Auth + PostgREST-Ausschnitt) für App-Tests ohne Netz.
// Bildet die Regeln aus supabase/migrations nach: nur Mitglieder sehen/ändern ihren Haushalt,
// Versionen steigen bei jedem Update, Einkauf zeilenweise. Die echten SQL-Regeln prüft db.test.js.
const KEY = 'sb_publishable_test';
let seq = 0;
const nid = p => `${p}${(++seq).toString().padStart(4, '0')}`;
const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');

class FakeSupabase {
  constructor() {
    this.users = {};      // email → {id,email}
    this.codes = {};      // email → code
    this.tokens = {};     // access → userId
    this.refresh = {};    // refresh → userId
    this.households = []; this.members = []; this.docs = []; this.items = [];
    this.offline = false; this.rateLimited = false; this.log = [];
    this.fetch = this.fetch.bind(this);
  }
  code(email) { return this.codes[email]; }
  expireTokens() { this.tokens = {}; }
  revokeRefresh() { this.refresh = {}; }
  isMember(uid, hid) { return this.members.some(m => m.user_id === uid && m.household_id === hid); }
  session(email) {
    const u = this.users[email], at = nid('at-'), rt = nid('rt-');
    this.tokens[at] = u.id; this.refresh[rt] = u.id;
    return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'bearer', user: { id: u.id, email } };
  }

  async fetch(url, { method = 'GET', headers = {}, body } = {}) {
    if (this.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url), path = u.pathname, q = u.searchParams;
    const data = body ? JSON.parse(body) : undefined;
    this.log.push(`${method} ${path}`);
    const res = (status, obj) => ({ ok: status < 300, status, text: async () => (obj === undefined ? '' : JSON.stringify(obj)) });
    if (headers.apikey !== KEY) return res(401, { message: 'Invalid API key' });

    // ── Auth ──
    if (path === '/auth/v1/otp') {
      if (this.rateLimited) return res(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
      this.users[data.email] ||= { id: uuid(), email: data.email };
      this.codes[data.email] = String(100000 + (seq * 7919) % 900000);
      return res(200, {});
    }
    if (path === '/auth/v1/verify') {
      if (data.type !== 'email' && data.type !== 'signup') return res(400, { msg: 'bad type' });
      if (!this.codes[data.email] || this.codes[data.email] !== data.token) return res(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      delete this.codes[data.email];
      return res(200, this.session(data.email));
    }
    if (path === '/auth/v1/token') {
      const uid = this.refresh[data.refresh_token];
      if (!uid) return res(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      delete this.refresh[data.refresh_token];
      const email = Object.values(this.users).find(x => x.id === uid).email;
      return res(200, this.session(email));
    }
    const bearer = (headers.Authorization || '').replace(/^Bearer /, '');
    const uid = this.tokens[bearer];
    if (path === '/auth/v1/logout') { delete this.tokens[bearer]; return res(204); }
    if (!uid) return res(401, { code: 'PGRST301', message: 'JWT expired' });
    if (path === '/auth/v1/user') return res(200, Object.values(this.users).find(x => x.id === uid));

    // ── RPC ──
    if (path === '/rest/v1/rpc/create_household') {
      const h = { id: uuid(), name: data.p_name, invite_code: nid('C').padEnd(8, 'X').slice(-8).toUpperCase(), created_by: uid };
      this.households.push(h); this.members.push({ household_id: h.id, user_id: uid, role: 'owner' });
      return res(200, h);
    }
    if (path === '/rest/v1/rpc/join_household') {
      const h = this.households.find(x => x.invite_code === data.p_code);
      if (!h) return res(400, { code: 'P0001', message: 'Code ungültig' });
      if (!this.isMember(uid, h.id)) this.members.push({ household_id: h.id, user_id: uid, role: 'adult' });
      return res(200, h);
    }
    if (path === '/rest/v1/rpc/rotate_invite') {
      const h = this.households.find(x => x.id === data.p_household);
      if (!this.members.some(m => m.household_id === h?.id && m.user_id === uid && m.role === 'owner')) return res(400, { message: 'nur für den Besitzer' });
      h.invite_code = nid('N').padEnd(8, 'Y').slice(-8).toUpperCase();
      return res(200, h.invite_code);
    }

    // ── Tabellen ──
    const eq = k => (q.get(k) || '').replace(/^eq\./, '');
    const mine = rows => rows.filter(r => this.isMember(uid, r.household_id));
    const denied = () => res(403, { code: '42501', message: 'new row violates row-level security policy' });
    if (path === '/rest/v1/members') {
      if (method === 'GET') return res(200, this.members.filter(m => m.user_id === eq('user_id') && m.user_id === uid)
        .map(m => ({ household_id: m.household_id, role: m.role, households: this.households.find(h => h.id === m.household_id) })));
      if (method === 'DELETE') { this.members = this.members.filter(m => !(m.household_id === eq('household_id') && m.user_id === eq('user_id') && eq('user_id') === uid)); return res(204); }
    }
    if (path === '/rest/v1/households' && method === 'DELETE') {
      const hid = eq('id');
      if (this.members.some(m => m.household_id === hid && m.user_id === uid && m.role === 'owner')) {
        this.households = this.households.filter(h => h.id !== hid);
        for (const t of ['members', 'docs', 'items']) this[t] = this[t].filter(r => r.household_id !== hid);
      }
      return res(204);
    }
    if (path === '/rest/v1/docs') {
      const hid = eq('household_id'), keyF = q.get('key') || '', ver = q.get('version');
      const match = r => r.household_id === hid && (!keyF || (keyF.startsWith('in.(') ? keyF.slice(4, -1).split(',').includes(r.key) : r.key === keyF.replace(/^eq\./, ''))) && (!ver || r.version === Number(ver.replace(/^eq\./, '')));
      if (method === 'GET') return res(200, mine(this.docs).filter(match).map(r => ({ ...r, data: JSON.parse(JSON.stringify(r.data)) })));
      if (method === 'POST') {
        if (!this.isMember(uid, data.household_id)) return denied();
        if (this.docs.some(r => r.household_id === data.household_id && r.key === data.key)) return res(409, { code: '23505', message: 'duplicate key' });
        const row = { household_id: data.household_id, key: data.key, data: data.data, version: 1 };
        this.docs.push(row); return res(201, [row]);
      }
      if (method === 'PATCH') {
        const rows = mine(this.docs).filter(match);
        rows.forEach(r => { r.data = data.data; r.version++; });
        return res(200, rows.map(r => ({ ...r })));
      }
    }
    if (path === '/rest/v1/shopping_items') {
      const hid = eq('household_id');
      if (method === 'GET') return res(200, mine(this.items).filter(r => r.household_id === hid).sort((a, b) => a.created - b.created).map(({ created, ...r }) => r));
      if (method === 'POST') {
        if (!this.isMember(uid, data.household_id)) return denied();
        const ex = this.items.find(r => r.household_id === data.household_id && r.id === data.id);
        if (ex) Object.assign(ex, data); else this.items.push({ ...data, created: ++seq });
        return res(201);
      }
      if (method === 'DELETE') { this.items = this.items.filter(r => !(r.household_id === hid && r.id === eq('id') && this.isMember(uid, hid))); return res(204); }
    }
    return res(404, { message: `unbekannt: ${method} ${path}` });
  }
}
module.exports = { FakeSupabase, KEY };
