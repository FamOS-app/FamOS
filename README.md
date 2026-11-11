# FamOS

**Das Gehirn der Familie.** Familien-App als Single-File-PWA (Vanilla HTML/CSS/JS, kein Build-Schritt, kein Framework). Module: Routine, Stundenplan, Taschengeld, Essen, Einkauf.

**Selbst betreiben?** Siehe [Eigene Instanz einrichten](#eigene-instanz-einrichten).

## Grundregel: Im Code steht nur Rahmen, kein Inhalt

Keine Kindernamen, Lehrkräfte, Stundenpläne, Zugänge oder Passwörter im Repo, auch nicht in Tests oder Commit-Nachrichten. Familiendaten kommen über den Import in die App (später über Supabase). Zugangsdaten gehören in GitHub-Secrets bzw. in nicht eingecheckte lokale Dateien.

## Dateien

| Pfad | Zweck |
|---|---|
| `app/famos.html` | Die App. Einzige Quelle, startet neutral mit Onboarding. |
| `app/icons/` | Logo (`logo.svg`) und daraus erzeugte PNG-Icons. |
| `tools/build.py` | Baut `dist/` (Seite, Manifest, Service Worker, Icons), mit Personendaten-Check. |
| `tools/make_icons.js` | Erzeugt die PNG-Icons aus `app/icons/logo.svg` (lokal, braucht Playwright). Nur nach Logo-Änderungen nötig. |
| `LICENSES/` | Lizenz der eingebetteten Schrift (Manrope, OFL). |
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
- Keine einzige externe Anfrage: Die Schrift Manrope ist eingebettet (SIL Open Font License, siehe `LICENSES/Manrope-OFL.txt`).

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

- Look: minimalistisch, flache Flächen mit 1-px-Linien, Linien-Icons in Navigation und Kopf. Zwei Farbwelten, pro Gerät wählbar unter Einstellungen → Haushalt: **Petrol** (Petrol, Terracotta, Senf) und **Pop** (Beige, Schwarz, Orange/Pink/Grün). Alles über CSS-Tokens, `data-look` am `<html>`.
- Schrift: Manrope (variabel 200–800, Latin, 24 KB), eingebettet. Überschriften in Großbuchstaben.
- Logo: Familien-Netz im Haus (vier verbundene Punkte in den Palettenfarben).
- Tippflächen mindestens 44 px, Zoom erlaubt, sichtbarer Fokus, `prefers-reduced-motion` wird respektiert.

## Navigation und Startseite

- Unten: **Heute · Kinder · Aufgaben · Kalender · Essen · Einkauf**. „Kinder“ bündelt Routine, Stundenplan, Taschengeld, Wünsche (nur wenn es Kinder gibt). Die App merkt sich pro Gerät die letzte Ansicht; Android-Zurück schließt erst Offenes.
- **Fotos zu Gerichten:** Im Gericht-Dialog ein Foto vom Gerät wählen; es ersetzt das Emoji in Plan, Kochbuch, Auswahl und auf der Startseite und steht groß über dem Rezept. Die App verkleinert es vor dem Speichern (Vorschau 160 px, Bild höchstens 900 px, zusammen rund 0,1–0,2 MB) und entfernt dabei Aufnahmeort und Kameradaten. Auf dem Gerät liegen Fotos in IndexedDB, im Haushalt in der Tabelle `dish_images`; sie sind nicht im Backup-Export enthalten.
- **Kalender:** Familientermine und Verabredungen mit Tag, optionaler Uhrzeit, Ort und Personen; mehrtägig (Urlaub) oder wiederkehrend (wöchentlich, jährlich). Ansicht als Liste ab heute oder als Monat. Kinder sehen ihre Termine der nächsten 7 Tage in der Routine (nur lesen). Kein Abgleich mit Google/Outlook, keine Erinnerungen.
- **Heute:** Karten für Termine heute und morgen, meine fälligen Aufgaben (inkl. fälligem Taschengeld), Kinder (Routine-Fortschritt, Brot, Stundenplan kurz), Essen heute (würfeln, wenn leer), Einkauf (direkt eintragen), ab 14 Uhr „Morgen“. Leere Karten entfallen; morgens Kinder oben, ab 14 Uhr Aufgaben/Essen/Morgen.
- **Gerät:** „Wer nutzt dieses Gerät?“ (Erwachsene oder Familiengerät), pro Gerät, einmal gefragt, änderbar unter Einstellungen → Haushalt.
- **Taschengeld-Auszahlungstag** (Einstellungen → Taschengeld): am Tag fällig unter Heute/Aufgaben, danach überfällig bis „Ausgezahlt“/„Sparen“, auch für vergangene Wochen (zählt ab dem Tag des Festlegens).

## Datenmodell

Config (`ra_cfg3`): `household {name, adults[]}` (`null` = Onboarding), `kids[]`, `routines`, `wahlPool`, `stundenplan[kidId][tag]`, `taschengeld[kidId]`, `essen {meals, dishes[], plan[datum][mahlzeit]}`, `einkauf {items[], recent[]}`, `modules`, `pin`, `_mv` (aktuell 4).

## Modul Essen

- Gerichte mit Emoji, Mahlzeiten (Frühstück/Mittag/Abend), Eigenschaften und Zutaten. Kochschritte folgen später.
- **Heute:** pro Mahlzeit würfeln, nochmal würfeln, 📌 festlegen. **Woche:** diese/nächste Woche würfeln, 📌 bleibt, vergangene Tage bleiben unangetastet.
- Gewichtung: 👍 eines Kindes ×1,6, 👎 ×0,4 (seltener, nie ausgeschlossen); in den letzten 3/7/14 Tagen geplant ×0,1/0,35/0,7; schon in derselben Woche ×0,15.
- Welche Mahlzeiten geplant werden, steht unter Einstellungen → Essen. Plan-Einträge älter als 5 Wochen werden aufgeräumt.
- **Mengen:** Zutaten bleiben Textzeilen; Menge und Einheit werden erkannt („500 g“, „1,5 kg“, „½ Bund“, „2 EL“, „1 Dose“). Jedes Gericht hat Portionen („Rezept für 4“), unter Einstellungen → Essen steht, für wie viele gekocht wird. Rezeptansicht rechnet genau um, die Einkaufsliste rundet Zählbares auf (keine halben Dosen) und rechnet gleiche Zutaten zusammen (g/kg, ml/l).
- **Kochschritte:** ein Schritt pro Zeile; „📖 Rezept“ zeigt Zutaten und nummerierte Schritte, Personenzahl dort nur für die Ansicht änderbar.
- **Rezept aus Link:** Supabase-Funktion `supabase/functions/recipe-import` liest schema.org/Recipe (JSON-LD) aus der Seite. Ohne KI, speichert nichts, nur angemeldet; nur öffentliche Adressen (keine IPs/localhost/Sonderports, auch nicht nach Weiterleitung), max. 2 MB, 8 s.
- **Mit Claude übernehmen** (Rezept oder Stundenplan vom Foto): Die App kopiert einen fertigen Auftrag; Foto + Auftrag in der Claude-App senden, Antwort (JSON) in FamOS einfügen. Die Antwort wird streng geprüft, Rezepte gehen ins Formular bzw. über eine Vorschau, beim Stundenplan werden nur die genannten Tage des gewählten Kindes ersetzt. Keine API-Kosten.
- Keine KI in der App, keine laufenden Kosten.

## Modul Einkauf

- Eintragen per Textfeld (Enter, Tastatur bleibt offen), Doppeltes wird abgefangen.
- „Zutaten aus dem Wochenplan“: diese Woche ab heute oder nächste Woche; gleiche Zeilen werden gezählt (×2), was schon offen auf der Liste steht, kommt nicht doppelt dazu. Mengen werden nicht verrechnet („500 g“ + „200 g“ bleiben zwei Zeilen).
- **Bereiche im Laden:** Die offene Liste ist nach Bereichen gruppiert, Standard-Reihenfolge wie ein typischer Aldi (Obst/Gemüse/Eier → Brot → Nudeln/Konserven/Öl → Kühlregal → Käse/Wurst/Fleisch → Getränke → Müsli/Aufstrich/Backen → Drogerie → Tiefkühl → Sonstiges). Zuordnung per Wörterbuch (das letzte Glied eines zusammengesetzten Worts entscheidet, Signalwörter wie „passiert“, „Dose“, „TK“ haben Vorrang). Über „⋯“ lässt sich ein Artikel umbenennen, löschen oder einem anderen Bereich zuordnen; das wird pro Artikel gemerkt. Reihenfolge der Bereiche unter Einstellungen → Einkauf.
- **Standardliste:** wiederkehrende Einkäufe unter Einstellungen → Einkauf; „Standardliste hinzufügen“ ergänzt nur, was noch fehlt.
- Abhaken → „Im Wagen“; „Erledigte entfernen“ merkt sich die letzten 20 Einträge als Schnellwahl.

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

- Edge Function `recipe-import`: einmal im Dashboard anlegen (Edge Functions → Deploy a new function → Via Editor → Name `recipe-import` → Inhalt von `supabase/functions/recipe-import/index.ts` → Deploy; „Verify JWT“ an lassen). Tests: `tests/recipe-import.test.js`.

### Konto & Sync in der App

- Anmeldung per **6-stelligem Code aus der E-Mail** (kein Link: ein Link würde auf dem iPhone in Safari statt in der installierten App landen).
- Alternativ **mit Passwort**, ganz ohne Mail: Konto in Supabase unter Authentication → Users → **Add user** mit E-Mail und Passwort anlegen („Auto Confirm User“ anhaken), in der App **Anmelden → Mit Passwort anmelden**. Das Passwort ändert jede/r selbst unter ⚙️ → Konto & Sync → **Passwort festlegen oder ändern** (mindestens 8 Zeichen). Die App speichert das Passwort nicht.
- Lokal zuerst: Die App arbeitet immer mit `localStorage`. Mit Anmeldung werden Änderungen nach ~1 s hochgeladen.
- **Sofort-Übertragung:** Dauerverbindung zu Supabase Realtime (WebSocket, nur `wss://<projekt>.supabase.co`). Eine Meldung löst nur das Abholen aus, die Daten kommen weiter über REST mit RLS. Fremde Haushalte lehnt der Server beim Verbinden ab.
- Sicherheitsnetz: Steht die Dauerverbindung, fragt die App zusätzlich alle 30 s nach; ohne sie alle 5 s (Einkauf) bzw. 15 s (Rest). Abgerissene Verbindungen werden mit wachsendem Abstand (bis 60 s) neu aufgebaut.
- Gleichzeitige Änderungen: Haken des Tages, Taschengeld-Wochenstatus und Buchungen werden zusammengeführt; Einkaufsliste läuft zeilenweise ohne Verlust; bei den Einstellungen gewinnt der Cloud-Stand (mit Hinweis).
- Gerätebezogen bleibt: Installations-Hinweis, Anmeldung.
- Abmelden lässt die Daten auf dem Gerät. Besitzer/in kann den Haushalt in der Cloud löschen (DSGVO: Löschung), Mitglieder können austreten.
- Ohne `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` baut die App ohne Sync; die CSP erlaubt dann keinerlei Netzwerkzugriff. Mit Konfiguration genau die eine Projektadresse.
- Tests: `tests/sync.test.js` (zwei Geräte gegen nachgebauten Server `tests/fake-supabase.js`), `tests/db.test.js` (echte SQL-Regeln).

## Eigene Instanz einrichten

Für alle, die FamOS mit **eigenem Supabase** betreiben möchten, damit die Familiendaten bei ihnen selbst liegen und nicht bei der Person, die den Link geteilt hat.

**Wer nur ausprobieren will, braucht das nicht:** Die App unter dem geteilten Link funktioniert für alle ohne Konto, die Daten bleiben dann auf dem Handy. Diese Anleitung ist für Konto & Sync auf eigener Infrastruktur.

**Dauer:** ca. 45 Minuten, am besten am Computer. **Kosten:** keine (GitHub Free, Supabase Free-Plan).
**Ergebnis:** eigene Adresse `https://<dein-github-name>.github.io/FamOS/`, eigenes Supabase-Projekt, eigene Konten.

### Schritt 1: Konten anlegen
1. **GitHub-Konto** auf github.com (falls noch nicht vorhanden). Die E-Mail-Adresse bestätigen, sonst lässt sich GitHub Pages nicht einschalten.
2. **Supabase-Konto** auf supabase.com (Login mit GitHub geht).

### Schritt 2: Repository kopieren (Fork)
1. https://github.com/FamOS-app/FamOS öffnen → oben rechts **Fork** → **Create fork**. Den Namen `FamOS` beibehalten, sonst ändert sich die Adresse.
2. Im eigenen Fork: Reiter **Actions** → **„I understand my workflows, go ahead and enable them“**. Bei Forks sind Actions anfangs aus.

### Schritt 3: Supabase-Projekt anlegen
1. **New project**:
   - Name: `famos`
   - Region: **Central EU (Frankfurt)**
   - Datenbank-Passwort generieren lassen und im Passwort-Manager speichern
2. **Auftragsverarbeitungsvertrag (DPA):** Organization Settings → Legal Documents, falls nicht schon automatisch vorhanden.
3. **Tabellen und Regeln anlegen:** links **SQL Editor** → **New query**. Nacheinander jede Datei aus `supabase/migrations/` **in Nummernreihenfolge** einfügen und mit **Run** ausführen (001, 002, 003, 004, 005 …). Jedes Mal sollte „Success. No rows returned“ erscheinen. Zum Kopieren auf GitHub die Datei öffnen und oben rechts „Copy raw file“ nutzen.
4. **Rezept-Import per Link (optional):** links **Edge Functions** → **Deploy a new function** → **Via Editor**.
   - Name: `recipe-import`
   - Beispielcode vollständig ersetzen durch den Inhalt von `supabase/functions/recipe-import/index.ts`
   - **Deploy**. „Verify JWT“ bleibt an.
   - Achtung: Das ist kein SQL, also **nicht** in den SQL Editor.
5. **Login-Adresse:** Authentication → **URL Configuration**
   - Site URL: `https://<dein-github-name>.github.io/FamOS/`
   - dieselbe Adresse unter **Redirect URLs** hinzufügen

### Schritt 4: Zugangsdaten in GitHub eintragen
Im eigenen Fork: **Settings → Secrets and variables → Actions**.

| Wo | Name | Wert | Woher |
|---|---|---|---|
| Reiter **Variables** | `SUPABASE_URL` | `https://<projekt>.supabase.co` | Supabase → Project Settings → Data API (ein angehängtes `/rest/v1` stört nicht) |
| Reiter **Variables** | `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | Supabase → Project Settings → API Keys → **Publishable key** |
| Reiter **Secrets** | `PERSONAL_NAMES` | Namen eurer Familie, durch Komma getrennt | selbst festlegen (siehe unten) |

- **Niemals den Secret Key (`sb_secret_…`) eintragen**, weder hier noch sonst irgendwo. Der Build bricht ab, wenn er ihn erkennt.
- **`PERSONAL_NAMES` ist Pflicht.** Der Build prüft damit, dass diese Namen nie im Code oder auf der öffentlichen Seite landen, und läuft ohne das Secret nicht durch. Eintragen: Vornamen von Kindern **und** Erwachsenen, den Nachnamen, ggf. Namen von Lehrkräften, Kita oder Schule. Das Secret ist auf GitHub nicht mehr lesbar, auch nicht für euch selbst.
- Der Check findet nur die eingetragenen Wörter. Adressen oder Geburtsdaten erkennt er nicht. Grundregel bleibt: Familiendaten nur in der App, nie im Code.

### Schritt 5: GitHub Pages einschalten und veröffentlichen
1. **Settings → Pages** (linke Leiste, Abschnitt „Code and automation“) → **Source: GitHub Actions**.
2. Reiter **Actions** → links **„CI und Veröffentlichung“** → **Run workflow** → **Run workflow**.
3. Nach 1 bis 2 Minuten ist der Lauf grün. Die App liegt dann unter `https://<dein-github-name>.github.io/FamOS/`.

### Schritt 6: Einrichten und absichern
1. Die eigene Adresse auf dem Handy öffnen → Haushalt anlegen → **Als App speichern**.
2. ⚙️ → **Konto & Sync** → **Anmelden** → Code bzw. Link aus der Mail → **Neuen Haushalt in der Cloud anlegen**.
3. Partner/in meldet sich ebenfalls an und tritt mit dem **Einladungscode** bei.
4. **Erst danach** die Registrierung sperren: Supabase → Authentication → **Sign In / Providers** → **„Allow new users to sign up“** aus. Weitere Personen lädt man unter Authentication → **Users** → **Invite user** ein.

### Optional: Code direkt in der Login-Mail
Ohne eigenen Mailversand verschickt Supabase nur einen Link und wenige Mails pro Stunde; die E-Mail-Vorlagen sind gesperrt. Die App kommt damit zurecht: Link in der Mail **lange drücken → kopieren → in der App einfügen**. Komfortabler wird es mit eigenem SMTP, z. B. Brevo (EU, kostenlos bis 300 Mails/Tag):
- Supabase → Authentication → Emails → **SMTP Settings**: Host `smtp-relay.brevo.com`, Port `587`, Login und SMTP-Schlüssel aus Brevo
- dann in den Vorlagen **„Confirm signup“** und **„Magic Link“** `{{ .Token }}` statt des Links verwenden

### Updates übernehmen
- Auf GitHub im eigenen Fork **„Sync fork“ → „Update branch“**. Die neue Version wird automatisch gebaut und veröffentlicht.
- **Neue Dateien in `supabase/migrations/` beachten:** Kommt eine Datei mit neuer Nummer dazu (z. B. `004_…`), muss sie einmal im SQL Editor ausgeführt werden. Bereits ausgeführte Dateien **nicht** erneut ausführen.
- Hat sich `supabase/functions/recipe-import/index.ts` geändert, den Code in der Edge Function ersetzen und erneut deployen.

### Wenn etwas hakt

| Meldung / Symptom | Ursache | Lösung |
|---|---|---|
| CI rot bei „Bauen mit Personendaten-Check“: *keine Sperrliste* | Secret `PERSONAL_NAMES` fehlt | Secret anlegen (Schritt 4), Lauf neu starten |
| CI rot: *SUPABASE_URL muss so aussehen …* | Adresse falsch eingetragen | Variable prüfen: `https://<projekt>.supabase.co` |
| CI rot: *Das ist der geheime Schlüssel* | Secret Key statt Publishable Key | Variable durch `sb_publishable_…` ersetzen und den Secret Key in Supabase neu erzeugen |
| Deploy rot: *Ensure GitHub Pages has been enabled* | Pages-Quelle nicht gesetzt | Schritt 5.1 |
| In der App kein „Konto & Sync“ | Variablen fehlten beim Build | Variablen setzen, Lauf neu starten |
| Beim Haushalt-Anlegen *function … does not exist* | Migrationen fehlen oder in falscher Reihenfolge | alle Dateien aus `supabase/migrations/` der Reihe nach ausführen |
| Aufgaben gleichen sich nicht ab | `003_aufgaben.sql` fehlt | ausführen; bereits angelegte Aufgaben werden nachgeliefert |
| Termine gleichen sich nicht ab | `004_termine.sql` fehlt | ausführen; bereits angelegte Termine werden nachgeliefert |
| Fotos erscheinen nicht auf dem anderen Handy | `005_gericht_fotos.sql` fehlt | ausführen; vorhandene Fotos werden nachgeliefert |
| „Aus Link“: *noch nicht eingerichtet* | Edge Function fehlt oder heißt anders | Schritt 3.4, Name exakt `recipe-import` |
| Login: *zu viele Anmelde-Mails* / „limit exceeded“ in Supabase | eingebauter Mailversand von Supabase: wenige Mails pro Stunde für das ganze Projekt | mit Passwort anmelden (siehe oben) oder eigenes SMTP einrichten |
| Login: *nicht freigeschaltet* | Registrierung gesperrt, Adresse nicht eingeladen | unter Users einladen |

## Roadmap

Eigener E-Mail-Versand (EU) für Code statt Link, optional Rezept-Import per Link.
