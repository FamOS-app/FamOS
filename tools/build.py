#!/usr/bin/env python3
"""Baut die auslieferbare Seite aus app/famos.html.

Aufruf: python3 tools/build.py app/famos.html dist

Ergebnis in <ziel>/: index.html, manifest.webmanifest, sw.js und icons/*.png.
Die Icons kommen aus app/icons/ (erzeugt mit tools/make_icons.js).

Personendaten-Check: Bricht mit Exit 1 ab, wenn ein Name aus der Sperrliste
in der App vorkommt. Die Sperrliste steht NIE im Code. Quelle, in dieser Reihenfolge:
  1. Umgebungsvariable PERSONAL_NAMES (in GitHub Actions aus dem gleichnamigen Secret)
  2. Datei .personal-names im Repo-Root (lokal, per .gitignore ausgeschlossen)
Namen durch Komma oder Zeilenumbruch getrennt. Mit REQUIRE_PERSONAL_NAMES=1
ist eine fehlende Liste ein Fehler (so läuft es in CI).
"""
import hashlib, json, os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = '#F4EDE1'
ICONS = ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png']

# Service Worker: Netz zuerst (Updates kommen sofort), bei Funkloch aus dem Cache
SW = '''const V='famos-%s';
const FILES=['./','./index.html','./manifest.webmanifest',%s];
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  e.respondWith(fetch(r).then(res=>{if(res.ok){const c=res.clone();caches.open(V).then(x=>x.put(r,c));}return res;})
    .catch(()=>caches.match(r,{ignoreSearch:true}).then(m=>m||(r.mode==='navigate'?caches.match('./index.html'):Response.error()))));
});
'''


def load_names():
    raw = os.environ.get('PERSONAL_NAMES', '')
    if not raw.strip():
        f = os.path.join(ROOT, '.personal-names')
        if os.path.exists(f):
            raw = open(f, encoding='utf-8').read()
    return [n.strip() for n in re.split(r'[,\n]', raw) if n.strip()]


def check_personal(text, names):
    """Gibt die Anzahl der Treffer zurück, ohne die Namen selbst auszugeben."""
    return sum(text.count(n) for n in names)


def build(src, out):
    s = open(src, encoding='utf-8').read()

    # Laufzeit-Manifest (Blob) durch echte Datei ersetzen: nötig für "Zum Home-Bildschirm" mit Offline-Start
    pat = re.compile(r"^\(\(\)=>\{const m=\{name:'FamOS'.*\n", re.M)
    assert len(pat.findall(s)) == 1, 'Manifest-Block nicht eindeutig gefunden'
    s = pat.sub('', s)
    assert s.count('<title>FamOS</title>') == 1
    s = s.replace('<title>FamOS</title>', '<title>FamOS</title>\n<link rel="manifest" href="manifest.webmanifest">')
    assert s.count("manifest-src blob: data:") == 1
    s = s.replace("manifest-src blob: data:", "manifest-src 'self'")

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, 'icons'))
    open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(s)
    src_icons = os.path.join(os.path.dirname(os.path.abspath(src)), 'icons')
    for name in ICONS:
        shutil.copyfile(os.path.join(src_icons, name), os.path.join(out, 'icons', name))
    version = hashlib.sha256(s.encode('utf-8')).hexdigest()[:10]
    with open(os.path.join(out, 'sw.js'), 'w', encoding='utf-8') as fh:
        fh.write(SW % (version, ','.join("'./icons/%s'" % n for n in ICONS)))
    manifest = {
        'name': 'FamOS', 'short_name': 'FamOS', 'description': 'Das Gehirn der Familie',
        'lang': 'de', 'start_url': '.', 'scope': '.', 'display': 'standalone',
        'background_color': BG, 'theme_color': BG,
        'icons': [
            {'src': 'icons/icon-192.png', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
            {'src': 'icons/icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
            {'src': 'icons/maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
    }
    with open(os.path.join(out, 'manifest.webmanifest'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    return s


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    names = load_names()
    if not names:
        msg = 'Personendaten-Check: keine Sperrliste (PERSONAL_NAMES / .personal-names)'
        if os.environ.get('REQUIRE_PERSONAL_NAMES') == '1':
            sys.exit('FEHLER: ' + msg)
        print('WARNUNG: ' + msg + ', Check übersprungen')
    hits = check_personal(open(src, encoding='utf-8').read(), names)
    if hits:
        sys.exit(f'FEHLER: {hits} Personendaten-Treffer in {src}. Nichts gebaut.')
    build(src, out)
    print(f'Gebaut: {out}/ (index.html, manifest.webmanifest, sw.js, {len(ICONS)} Icons)'
          + (f' · Personendaten-Check: {len(names)} Namen, keine Treffer' if names else ''))


if __name__ == '__main__':
    main()
