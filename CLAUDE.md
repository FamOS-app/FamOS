# CLAUDE.md – Projektregeln FamOS

FamOS („Das Gehirn der Familie“): Familien-App als **Single-File-PWA** (`app/famos.html`, Vanilla HTML/CSS/JS, kein Framework, kein Bundler). Repo: `FamOS-app/FamOS`, live unter `https://famos-app.github.io/FamOS/`.

## Harte Regeln
- **Keine personenbezogenen Daten im Repo**: keine Namen (Kinder, Erwachsene, Lehrkräfte, Nachnamen), Adressen, Stundenpläne, Zugangsdaten – auch nicht in Tests, Commit-Nachrichten oder Beispielen. Tests nutzen fiktive Namen (Emma, Ben, Mama, Papa …). Familiendaten kommen nur über die App (Import/Supabase).
- **Kein Konto-/Personenname im Code**: Links auf das eigene Repo werden zur Laufzeit aus `location` abgeleitet (siehe `ownGuide()`).
- **Commit-Autor neutral, kein Personenname**: `git config user.name Claude` und `git config user.email noreply@anthropic.com` (so zeigt GitHub die Commits nicht als „Unverified“).
- **DSGVO / CSP**: keine externen Ressourcen (Schrift Manrope ist eingebettet). Netzwerk nur zur konfigurierten Supabase-Adresse (`https` + `wss`), die CSP wird beim Build gesetzt. Kein `fetch` außerhalb von `sb()`, kein `eval`, kein `alert`.
- **Supabase**: nur der Publishable Key (`sb_publishable_…`) gehört in die App; der Secret Key nie. Der Build verweigert ihn.
- **Escaping**: jede Nutzereingabe beim Rendern durch `esc()`; alles aus localStorage, Import und Server durch die `sanitize*`-Funktionen.
- Antworten an die Nutzerin auf **Deutsch**, präzise, mit Rückfragen bei Unklarheit.

## Aufbau
| Pfad | Inhalt |
|---|---|
| `app/famos.html` | die App (CSS, HTML, JS in einer Datei) |
| `app/icons/` | Logo (`logo.svg`) und PNG-Icons (`node tools/make_icons.js`) |
| `tools/build.py` | baut `dist/` (Seite, Manifest, Service Worker, Icons), Personendaten-Check, Supabase-Konfiguration aus Umgebung |
| `supabase/migrations/` | SQL, **von der Nutzerin manuell** im Supabase SQL Editor ausgeführt (001, 002, 003, 004 …). Neue Änderungen immer als neue nummerierte Datei, nie alte ändern. |
| `supabase/functions/recipe-import/index.ts` | Edge Function (manuell im Dashboard deployt, „Verify JWT“ an) |
| `tests/` | `famos.test.js` (App im node:vm-Harness), `sync.test.js` (zwei Geräte gegen `fake-supabase.js`), `db.test.js` (SQL in PGlite, Supabase-Umgebung nachgebaut), `recipe-import.test.js` |
| `.github/workflows/ci.yml` | Tests → Build → Personendaten-Check → Deploy `dist/` auf GitHub Pages |

## Arbeitsweise
- Vor jedem Commit: `npm ci` (einmalig) und `npm test` – alles grün. Für neue Funktionen Tests schreiben; bei sicherheitsrelevanten Regeln eine Gegenprobe (absichtlicher Fehler muss rot werden).
- UI-Änderungen im Browser prüfen (Playwright ist vorinstalliert, `dist/index.html` per `file://`).
- Nach dem Push den CI-Lauf abwarten (öffentliche API: `/repos/FamOS-app/FamOS/actions/runs`). Build-Fehler erscheinen als Annotation (`/check-runs/<job>/annotations`).
- Neue Module: Eintrag in `MODULES`, Standardwert in `DEF.modules`, Tests für Modul-Liste/Navigation anpassen.
- Daten zwischen Geräten: Einstellungen als Dokument `docs.cfg` (Konflikt → Cloud gewinnt), Einkauf, Aufgaben und Termine zeilenweise (`shopping_items`, `tasks`, `events`) über die Warteschlange `SYNC.queue`. Neue Tabellen erst nach erfolgreichem Abruf in der Sofort-Übertragung abonnieren (siehe `SYNC.eventsOk`), sonst scheitert die Verbindung, solange die Migration fehlt.

## Stand / offen
- Konto & Sync: Registrierung in Supabase gesperrt, Freunde werden eingeladen. Ohne Konto läuft alles lokal.
- Login-Mails ohne eigenes SMTP: nur Link → App akzeptiert eingefügten Link. Optional Brevo-SMTP für Code in der Mail.
- Wünsche gleichen sich über `cfg` ab (bei gleichzeitigen Änderungen gewinnt die Cloud); bei Bedarf auf eigene Tabelle umstellen.
- Kalender: eigene Termine in FamOS; Abgleich mit Google/Outlook/iCloud und `.ics`-Export bewusst noch nicht gebaut.
- Erinnerungen/Push-Benachrichtigungen: bewusst noch nicht gebaut.
