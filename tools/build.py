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

Sync (optional): SUPABASE_URL und SUPABASE_PUBLISHABLE_KEY aus der Umgebung (in CI aus den
GitHub-Variablen). Beide werden geprüft, eingesetzt und die CSP erlaubt dann genau diese Adresse.
Fehlen sie, läuft die gebaute App nur lokal.
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


def fail(msg):
    """Fehler ausgeben; in GitHub Actions zusätzlich als Annotation (ohne geheime Werte)."""
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        print('::error title=Build::' + msg)
    sys.exit('FEHLER: ' + msg)


def supabase_config():
    url = os.environ.get('SUPABASE_URL', '').strip().rstrip('/')
    # Supabase zeigt die Adresse teils mit API-Pfad an (…/rest/v1): auf die Projektadresse kürzen
    url = re.sub(r'/(rest|auth|realtime|storage)/v1$', '', url).rstrip('/')
    key = os.environ.get('SUPABASE_PUBLISHABLE_KEY', '').strip()
    if not url and not key:
        return None
    if not re.fullmatch(r'https://[a-z0-9-]+\.supabase\.co', url):
        fail('SUPABASE_URL muss so aussehen: https://<projekt>.supabase.co (eingetragen: %d Zeichen, beginnt mit "%s", endet mit "%s")'
             % (len(url), url[:8], url[-12:]))
    if key.startswith('sb_secret_') or 'service_role' in key:
        fail('Das ist der geheime Schlüssel. Nur den Publishable Key (sb_publishable_…) verwenden!')
    if not re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key):
        fail('SUPABASE_PUBLISHABLE_KEY muss mit sb_publishable_ beginnen (eingetragen: %d Zeichen, beginnt mit "%s")'
             % (len(key), key[:6]))
    return url, key


def check_personal(text, names):
    """Gibt die Anzahl der Treffer zurück, ohne die Namen selbst auszugeben."""
    return sum(text.count(n) for n in names)


def build(src, out, sb=None):
    s = open(src, encoding='utf-8').read()

    if sb:
        url, key = sb
        for ph, val in (("'__SUPABASE_URL__'", repr(url)), ("'__SUPABASE_KEY__'", repr(key))):
            assert s.count(ph) == 1, ph
            s = s.replace(ph, val)
        assert s.count("worker-src 'self';") == 1
        s = s.replace("worker-src 'self';", "worker-src 'self'; connect-src " + url + ";")

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
            fail(msg)
        print('WARNUNG: ' + msg + ', Check übersprungen')
    hits = check_personal(open(src, encoding='utf-8').read(), names)
    if hits:
        fail(f'{hits} Personendaten-Treffer in {src}. Nichts gebaut.')
    sb = supabase_config()
    build(src, out, sb)
    print(f'Gebaut: {out}/ (index.html, manifest.webmanifest, sw.js, {len(ICONS)} Icons)'
          + (f' · Personendaten-Check: {len(names)} Namen, keine Treffer' if names else '')
          + (' · Sync: ' + sb[0] if sb else ' · ohne Sync'))


if __name__ == '__main__':
    main()
