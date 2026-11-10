// Test-Harness: lädt das <script> aus der Single-File-App in einen node:vm-Kontext
// mit gestubbtem document / localStorage. Kein Browser, keine Abhängigkeiten.
const fs = require('node:fs');
const vm = require('node:vm');

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Kein <script>-Block gefunden');
  return m[1];
}

function makeEl(tag) {
  const cls = new Set();
  return {
    tagName: tag, innerHTML: '', textContent: '', value: '', style: {}, children: [],
    classList: {
      add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
      toggle: c => (cls.has(c) ? cls.delete(c) : cls.add(c)),
    },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll: () => [], closest: () => null,
    focus() {}, click() { this.clicked = true; },
  };
}

/**
 * @param {string} file  Pfad zur HTML-Datei
 * @param {object} opts  storage: Startinhalt von localStorage (Objekt mit Strings)
 *                       confirm: Antwort auf confirm() (Standard true)
 *                       globals: zusätzliche Globale, z. B. window/navigator für Browser-Szenarien
 */
function load(file, opts = {}) {
  const html = fs.readFileSync(file, 'utf8');
  const code = extractScript(html);
  const store = { ...(opts.storage || {}) };
  const els = {};
  const created = [];
  const timers = [];
  const listeners = {};
  const document = {
    hidden: false,
    head: makeEl('head'),
    getElementById: id => (els[id] ||= makeEl('div')),
    createElement: tag => { const e = makeEl(tag); created.push(e); return e; },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
  };
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { if (opts.quotaFull) throw new Error('QuotaExceededError'); store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const ctx = vm.createContext({
    document, localStorage, console,
    navigator: {},
    confirm: () => opts.confirm !== false,
    alert: msg => { throw new Error('alert() darf nicht mehr vorkommen: ' + msg); },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0, // Sync-Intervall: Tests rufen syncNow() selbst auf
    requestAnimationFrame: fn => fn(),
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o?.type; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    ...(opts.globals || {}),
  });
  new vm.Script(code, { filename: file }).runInContext(ctx);
  const run = src => vm.runInContext(src, ctx);
  return {
    html, code, ctx, store, els, created, listeners, run,
    /** Wert aus dem App-Zustand als reine JSON-Kopie (ohne vm-Prototypen) */
    get: expr => { const j = run(`JSON.stringify(${expr})`); return j === undefined ? undefined : JSON.parse(j); },
    app: () => els.app.innerHTML,
    adm: () => els.adm?.innerHTML || '',
    toast: () => els.toast?.textContent || '',
    flush: () => { while (timers.length) timers.shift()(); },
    saved: key => JSON.parse(store[key]),
  };
}

module.exports = { load, extractScript };
