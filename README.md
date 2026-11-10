# FamOS

**Das Gehirn der Familie.** Familien-App als Single-File-PWA (Vanilla HTML/CSS/JS, kein Build-Schritt, kein Framework). Module: Routine, Stundenplan, Taschengeld, Essen, Einkauf.

## Grundregel: Im Code steht nur Rahmen, kein Inhalt

Keine Kindernamen, Lehrkräfte, Stundenpläne, Zugänge oder Passwörter im Repo, auch nicht in Tests oder Commit-Nachrichten. Familiendaten kommen über den Import in die App (später über Supabase). Zugangsdaten gehören in GitHub-Secrets bzw. in nicht eingecheckte lokale Dateien.

## Dateien

| Pfad | Zweck |
|---|---|
| `app/famos.html` | Die App. Einzige Quelle, startet neutral mit Onboarding. |
| `app/icons/` | Logo (`logo.svg`) und daraus erzeugte PNG-Icons. |
| `tools/build.py` | Baut `dist/` (Seite, Manifest, Service Worker, Icons), mit Personendaten-Check. |
| `tools/make_icons.js` | Erzeugt die PNG-Icons aus `app/icons/logo.svg` (lokal, braucht Playwright). Nur nach Logo-Änderungen nötig. |
| `LICENSES/` | Lizenz der eingebetteten Schrift. |
| `tests/` | Node-`vm`-Harness mit gestubbtem `document`/`localStorage`, ohne Abhängigkeiten. Nur fiktive Testnamen. |
| `.github/workflows/ci.yml` | Tests, Build, Check, Veröffentlichung per GitHub Pages. |
| `dist/` | Build-Ergebnis, nicht eingecheckt. |

## Workflow

1. Änderungen in `app/famos.html`.
2. Lokal testen (baut `dist/` gleich mit, prüft auch die Datenbank-Regeln):
   ```bash
   npm ci
   npm test
   ```
3. Push auf `main`: GitHub Actions testet, baut, prüft auf Personendaten und veröffentlicht `dist/` per GitHub Pages. Schlägt ein Schritt fehl, wird nichts veröffentlicht.

## Personendaten-Check

Die Sperrliste (Namen, die nie im Code auftauchen dürfen) steht selbst nicht im Code:

- **GitHub:** Secret `PERSONAL_NAMES` (Settings → Secrets and variables → Actions), Namen durch Komma getrennt. Ohne Secret schlägt der CI-Lauf fehl.
- **Lokal (optional):** Datei `.personal-names` im Repo-Root, ist per `.gitignore` ausgeschlossen.

Treffer brechen den Build ab. Das Log nennt nur die Anzahl, nicht die Namen.

## Daten und Datenschutz

- Alle Daten liegen **pro Gerät** im `localStorage` (`ra_cfg3`, `ra_day3`, `ra_tgd`, `ra_savings`, `ra_tx`). Kein Server, kein Tracking, keine Cookies.
- Backup und Gerätewechsel über **Einstellungen → Haushalt → Exportieren/Importieren**. Die Backup-Datei enthält Familiendaten: nicht ins Repo, nicht offen teilen.
- Keine einzige externe Anfrage: Die Schrift Andika ist eingebettet (SIL Open Font License, siehe `LICENSES/Andika-OFL.txt`).

## Sicherheit

- Content-Security-Policy im HTML: keinerlei Netzwerkzugriffe, keine fremden Skripte, Schrift und Bilder nur eingebettet.
- Jede Nutzereingabe wird beim Rendern escaped.
- Alles aus `localStorage` und aus Importen läuft durch `sanitizeCfg` & Co.: feste Struktur, Längenlimits, IDs nur `[A-Za-z0-9_-]`, unbekannte Felder fallen weg.
- Eltern-PIN (optional, Einstellungen → Haushalt): schützt Einstellungen und Taschengeld-Buchungen. Kindersicherung, kein Tresor: gespeichert wird ein gesalzener Hash auf dem Gerät. „PIN vergessen“ setzt nach einer Rechenaufgabe zurück.
- CI läuft mit Leserechten; nur der Deploy-Job darf auf Pages schreiben.
- Bekannte Grenze: Inline-Eventhandler erfordern `script-src 'unsafe-inline'`. Ohne Build-Schritt ist das der Kompromiss; Escaping und Validierung sind deshalb per Test abgesichert.

## Als App installieren

- Nach dem Onboarding fragt FamOS einmal pro Gerät von selbst; danach bleibt eine Hinweis-Karte, bis man sie wegklickt oder installiert.
- Android/Chrome: echter Installations-Dialog (`beforeinstallprompt`). iPhone: Apple erlaubt Webseiten keinen Dialog, daher eine Schritt-für-Schritt-Anleitung.
- In der installierten App erscheint kein Hinweis.
- Service Worker (`sw.js`): Netz zuerst, bei Funkloch aus dem Cache. Updates kommen beim nächsten Start mit Netz.

## Design

- Palette als CSS-Tokens in `:root`: Terracotta `#AE5238`, Mustard `#D39B32`, Deep Teal `#225D65` (Primärfarbe), Olive `#5C633E`, Warm Cream `#E3D8C6`.
- Schrift: Andika (Druckschrift mit einstöckigem a, für Leseanfänger gemacht), eingebettet als WOFF2 (Latin, 400/700). Überschriften in Großbuchstaben.
- Logo: Familien-Netz im Haus (vier verbundene Punkte in den Palettenfarben).
- Tippflächen mindestens 44 px, Zoom erlaubt, sichtbarer Fokus, `prefers-reduced-motion` wird respektiert.

## Datenmodell

Config (`ra_cfg3`): `household {name, adults[]}` (`null` = Onboarding), `kids[]`, `routines`, `wahlPool`, `stundenplan[kidId][tag]`, `taschengeld[kidId]`, `essen {meals, dishes[], plan[datum][mahlzeit]}`, `einkauf {items[], recent[]}`, `modules`, `pin`, `_mv` (aktuell 4).

## Modul Essen

- Gerichte mit Emoji, Mahlzeiten (Frühstück/Mittag/Abend), Eigenschaften und Zutaten. Kochschritte folgen später.
- **Heute:** pro Mahlzeit würfeln, nochmal würfeln, 📌 festlegen. **Woche:** diese/nächste Woche würfeln, 📌 bleibt, vergangene Tage bleiben unangetastet.
- Gewichtung: 👍 eines Kindes ×1,6, 👎 ×0,4 (seltener, nie ausgeschlossen); in den letzten 3/7/14 Tagen geplant ×0,1/0,35/0,7; schon in derselben Woche ×0,15.
- Welche Mahlzeiten geplant werden, steht unter Einstellungen → Essen. Plan-Einträge älter als 5 Wochen werden aufgeräumt.
- **Mengen:** Zutaten bleiben Textzeilen; Menge und Einheit werden erkannt („500 g“, „1,5 kg“, „½ Bund“, „2 EL“, „1 Dose“). Jedes Gericht hat Portionen („Rezept für 4“), unter Einstellungen → Essen steht, für wie viele gekocht wird. Rezeptansicht rechnet genau um, die Einkaufsliste rundet Zählbares auf (keine halben Dosen) und rechnet gleiche Zutaten zusammen (g/kg, ml/l).
- **Kochschritte:** ein Schritt pro Zeile; „📖 Rezept“ zeigt Zutaten und nummerierte Schritte, Personenzahl dort nur für die Ansicht änderbar.
- Keine KI, keine laufenden Kosten.

## Modul Einkauf

- Eintragen per Textfeld (Enter, Tastatur bleibt offen), Doppeltes wird abgefangen.
- „Zutaten aus dem Wochenplan“: diese Woche ab heute oder nächste Woche; gleiche Zeilen werden gezählt (×2), was schon offen auf der Liste steht, kommt nicht doppelt dazu. Mengen werden nicht verrechnet („500 g“ + „200 g“ bleiben zwei Zeilen).
- Abhaken → „Im Wagen“; „Erledigte entfernen“ merkt sich die letzten 20 Einträge als Schnellwahl.
- Bis zum Supabase-Sync liegt die Liste nur auf dem jeweiligen Gerät.

## Supabase

- Projekt in der Region Frankfurt, AVV abgeschlossen.
- Schema: alle Dateien in `supabase/migrations/` der Reihe nach einmal im SQL-Editor ausführen (001, 002, …).
  - `households` + `members`: Haushalte mit Einladungscode (8 Zeichen), Rollen Besitzer/Erwachsene.
  - `docs`: Einstellungen, Tagesstand, Taschengeld als Dokumente mit Versionsnummer (Konflikte werden erkannt).
  - `shopping_items`: Einkaufsliste zeilenweise, damit mehrere Handys gleichzeitig eintragen können.
  - Row Level Security auf allen Tabellen: nur Mitglieder sehen und ändern Daten ihres Haushalts; ohne Login kein Zugriff.
  - Anlegen/Beitreten/Code erneuern nur über Funktionen; Code ändern nur der Besitzer.
- `tests/db.test.js` prüft Schema und Regeln in einer echten Postgres-Instanz (PGlite), auch in CI.
- App-Konfiguration kommt aus GitHub-Variablen `SUPABASE_URL` und `SUPABASE_PUBLISHABLE_KEY` (nicht geheim, Schutz über RLS). Der secret/service_role key gehört nirgends hin.

### Konto & Sync in der App

- Anmeldung per **6-stelligem Code aus der E-Mail** (kein Passwort, kein Link: ein Link würde auf dem iPhone in Safari statt in der installierten App landen).
- Lokal zuerst: Die App arbeitet immer mit `localStorage`. Mit Anmeldung werden Änderungen nach ~1 s hochgeladen und alle 5 s (Einkauf) bzw. 15 s (Rest) abgeholt, außerdem beim Öffnen der App.
- Gleichzeitige Änderungen: Haken des Tages, Taschengeld-Wochenstatus und Buchungen werden zusammengeführt; Einkaufsliste läuft zeilenweise ohne Verlust; bei den Einstellungen gewinnt der Cloud-Stand (mit Hinweis).
- Gerätebezogen bleibt: Installations-Hinweis, Anmeldung.
- Abmelden lässt die Daten auf dem Gerät. Besitzer/in kann den Haushalt in der Cloud löschen (DSGVO: Löschung), Mitglieder können austreten.
- Ohne `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` baut die App ohne Sync; die CSP erlaubt dann keinerlei Netzwerkzugriff. Mit Konfiguration genau die eine Projektadresse.
- Tests: `tests/sync.test.js` (zwei Geräte gegen nachgebauten Server `tests/fake-supabase.js`), `tests/db.test.js` (echte SQL-Regeln).

## Roadmap

Echtzeit per WebSocket statt Abfrage-Intervall, eigener E-Mail-Versand (EU), optional Rezept-Import per Link, Kochschritte und Mengen.
