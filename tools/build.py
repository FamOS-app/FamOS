#!/usr/bin/env python3
"""Baut die auslieferbare Seite aus app/famos.html.

Aufruf: python3 tools/build.py app/famos.html dist

Ergebnis in <ziel>/: genau index.html und manifest.webmanifest.

Personendaten-Check: Bricht mit Exit 1 ab, wenn ein Name aus der Sperrliste
in der App vorkommt. Die Sperrliste steht NIE im Code. Quelle, in dieser Reihenfolge:
  1. Umgebungsvariable PERSONAL_NAMES (in GitHub Actions aus dem gleichnamigen Secret)
  2. Datei .personal-names im Repo-Root (lokal, per .gitignore ausgeschlossen)
Namen durch Komma oder Zeilenumbruch getrennt. Mit REQUIRE_PERSONAL_NAMES=1
ist eine fehlende Liste ein Fehler (so läuft es in CI).
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = '#F4EDE1'
ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E"
        "%3Crect width='512' height='512' rx='112' fill='%23F4EDE1'/%3E%3Ctext x='256' y='340' "
        "font-size='280' text-anchor='middle'%3E%E2%98%80%EF%B8%8F%3C/text%3E%3C/svg%3E")


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

    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        os.remove(os.path.join(out, f))
    open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(s)
    manifest = {
        'name': 'FamOS', 'short_name': 'FamOS', 'description': 'Das Gehirn der Familie',
        'lang': 'de', 'start_url': '.', 'scope': '.', 'display': 'standalone',
        'background_color': BG, 'theme_color': BG,
        'icons': [{'src': ICON, 'sizes': 'any', 'type': 'image/svg+xml', 'purpose': 'any'}],
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
    print(f'Gebaut: {out}/index.html, {out}/manifest.webmanifest'
          + (f' · Personendaten-Check: {len(names)} Namen, keine Treffer' if names else ''))


if __name__ == '__main__':
    main()
