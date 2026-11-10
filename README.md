# FamOS

**Das Gehirn der Familie.** Familien-App als Single-File-PWA (Vanilla HTML/CSS/JS, kein Build-Schritt, kein Framework). Module: Routine, Stundenplan, Taschengeld, Essen.

## Grundregel: Im Code steht nur Rahmen, kein Inhalt

Keine Kindernamen, Lehrkräfte, Stundenpläne, Zugänge oder Passwörter im Repo, auch nicht in Tests oder Commit-Nachrichten. Familiendaten kommen über den Import in die App (später über Supabase). Zugangsdaten gehören in GitHub-Secrets bzw. in nicht eingecheckte lokale Dateien.

## Dateien

| Pfad | Zweck |
|---|---|
| `app/famos.html` | Die App. Einzige Quelle, startet neutral mit Onboarding. |
| `tools/build.py` | Baut `dist/index.html` + `dist/manifest.webmanifest`, mit Personendaten-Check. |
| `tests/` | Node-`vm`-Harness mit gestubbtem `document`/`localStorage`, ohne Abhängigkeiten. Nur fiktive Testnamen. |
| `.github/workflows/ci.yml` | Tests, Build, Check, Veröffentlichung per GitHub Pages. |
| `dist/` | Build-Ergebnis, nicht eingecheckt. |

## Workflow

1. Änderungen in `app/famos.html`.
2. Lokal testen (baut `dist/` gleich mit):
   ```bash
   node --test tests/famos.test.js
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
- Einzige externe Anfrage: Schriftart Andika von Bunny Fonts (EU). Keine Google Fonts.

## Sicherheit

- Content-Security-Policy im HTML: keine Netzwerkzugriffe außer Bunny Fonts, keine fremden Skripte, Bilder nur als Data-URL.
- Jede Nutzereingabe wird beim Rendern escaped.
- Alles aus `localStorage` und aus Importen läuft durch `sanitizeCfg` & Co.: feste Struktur, Längenlimits, IDs nur `[A-Za-z0-9_-]`, unbekannte Felder fallen weg.
- Eltern-PIN (optional, Einstellungen → Haushalt): schützt Einstellungen und Taschengeld-Buchungen. Kindersicherung, kein Tresor: gespeichert wird ein gesalzener Hash auf dem Gerät. „PIN vergessen“ setzt nach einer Rechenaufgabe zurück.
- CI läuft mit Leserechten; nur der Deploy-Job darf auf Pages schreiben.
- Bekannte Grenze: Inline-Eventhandler erfordern `script-src 'unsafe-inline'`. Ohne Build-Schritt ist das der Kompromiss; Escaping und Validierung sind deshalb per Test abgesichert.

## Design

- Palette als CSS-Tokens in `:root`: Terracotta `#AE5238`, Mustard `#D39B32`, Deep Teal `#225D65` (Primärfarbe), Olive `#5C633E`, Warm Cream `#E3D8C6`.
- Schrift: Andika (Druckschrift mit einstöckigem a, für Leseanfänger gemacht), Überschriften in Großbuchstaben.
- Tippflächen mindestens 44 px, Zoom erlaubt, sichtbarer Fokus, `prefers-reduced-motion` wird respektiert.

## Datenmodell

Config (`ra_cfg3`): `household {name, adults[]}` (`null` = Onboarding), `kids[]`, `routines`, `wahlPool`, `stundenplan[kidId][tag]`, `taschengeld[kidId]`, `essen {meals, dishes[], plan[datum][mahlzeit]}`, `modules`, `pin`, `_mv` (aktuell 4).

## Modul Essen

- Gerichte mit Emoji, Mahlzeiten (Frühstück/Mittag/Abend), Eigenschaften und Zutaten. Kochschritte folgen später.
- **Heute:** pro Mahlzeit würfeln, nochmal würfeln, 📌 festlegen. **Woche:** diese/nächste Woche würfeln, 📌 bleibt, vergangene Tage bleiben unangetastet.
- Gewichtung: 👍 eines Kindes ×1,6, 👎 ×0,4 (seltener, nie ausgeschlossen); in den letzten 3/7/14 Tagen geplant ×0,1/0,35/0,7; schon in derselben Woche ×0,15.
- Welche Mahlzeiten geplant werden, steht unter Einstellungen → Essen. Plan-Einträge älter als 5 Wochen werden aufgeräumt.
- Keine KI, keine laufenden Kosten.

## Roadmap

Supabase (EU/Frankfurt, AVV): Auth per Magic Link, Haushalte mit Einladungscode, Row Level Security. Danach Einkaufsliste aus dem Wochenplan (Live-Sync), optional Rezept-Import per Link.
