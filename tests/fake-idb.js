// Nachgebautes IndexedDB (nur was die App für Gericht-Fotos nutzt). `data` ist der Speicher des Geräts:
// dasselbe Objekt an zwei load()-Aufrufe gegeben, verhält sich wie ein Neustart der App.
function fakeIndexedDB(data = {}) {
  const copy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const req = fn => { const r = {}; queueMicrotask(() => { r.result = fn(); r.onsuccess?.({ target: r }); }); return r; };
  const store = {
    getAll: () => req(() => Object.values(data).map(copy)),
    get: id => req(() => copy(data[id])),
    put: v => req(() => { data[v.id] = copy(v); }),
    delete: id => req(() => { delete data[id]; }),
    clear: () => req(() => { for (const k of Object.keys(data)) delete data[k]; }),
  };
  let created = false;
  return {
    data,
    open() {
      const o = {};
      const db = { createObjectStore() {}, close() {}, transaction() { const tx = { objectStore: () => store }; setImmediate(() => tx.oncomplete?.()); return tx; } };
      queueMicrotask(() => { o.result = db; if (!created) { created = true; o.onupgradeneeded?.(); } o.onsuccess?.(); });
      return o;
    },
  };
}
module.exports = { fakeIndexedDB };
