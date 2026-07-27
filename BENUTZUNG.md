# Sachstands-Cockpit — Anleitung

Diese Anleitung beschreibt, **wie die Lösung im Alltag benutzt wird** und **wie sie
eingerichtet ist**. Technische Details zur Weiterentwicklung stehen in `STATUS.md`,
die Kurzfassung im `README.md`.

- **Adresse:** https://sachstaende.gollenstede.app
- **Anmeldung:** Microsoft-Konto des Büros (Entra ID)

---

## 1. Was die Lösung macht

Sie übernimmt die Vorarbeit für Sachstandsanfragen an Kanzleien und Versicherungen:

1. **Einmal am Tag** (standardmäßig ab 7 Uhr) sieht sie in Pipedrive nach fälligen
   Aufgaben, deren Betreff mit „Sachstand anfragen" beginnt. Sachstände sind
   Tagesgeschäft — häufigeres Nachsehen brächte nichts und belastet nur das
   Tageskontingent der Pipedrive-API. Der Knopf **⟳** löst jederzeit einen
   sofortigen Lauf aus.
2. Für jeden Fall liest sie **Deal, Notizen und den Mailverlauf** und beurteilt die
   Sachlage.
3. Passt eine Nachfrage, schreibt sie einen **fertigen Entwurf** und legt ihn in die
   Warteschlange. Passt sie nicht, wird der Fall **mit Begründung übersprungen**.
4. Du siehst dir die Entwürfe an, gibst frei, lässt ändern oder überspringst.

**Ohne deine Freigabe passiert nichts nach außen.** Der Hintergrundlauf schreibt
weder in Pipedrive noch verschickt er Mails.

---

## 2. Der Arbeitsablauf

### Anmelden

Seite aufrufen → **„Mit Microsoft anmelden"** → das übliche Microsoft-Fenster.
Die Sitzung hält 12 Stunden. Oben rechts steht dein Name; ein Klick darauf meldet ab.

### Liste durchsehen

Links (am Handy: die Startansicht) stehen die Fälle, die eine Entscheidung brauchen.
Pro Zeile: Aktenzeichen, Anspruchsteller, Empfänger, Status und wie lange gewartet wird.

Die Filter oben:

| Filter | Zeigt |
|---|---|
| **Zu prüfen** | alles, was auf deine Entscheidung wartet (Standard) |
| **Überfällig** | davon die, deren Frist am längsten läuft |
| **Rückfragen** | Fälle, in denen die Gegenseite *uns* etwas gefragt hat |
| **Erledigt** | freigegeben oder übersprungen — zum Nachsehen. Nur wirklich Entschiedenes; „Empfänger unklar" und „Bereits angefragt" stehen unter **Alle** |
| **Alle** | alles zusammen |

### Fall ansehen

Rechts (am Handy: nach dem Antippen) steht alles zum Fall:

- **Kopf:** Anspruchsteller, Aktenzeichen, Versicherung, Schadennummer, Fälligkeit
  und ein Link, der den Deal in Pipedrive öffnet.
- **Letzter Stand:** was zuletzt passiert ist, mit Datum und Quelle.
- **Einschätzung:** die erkannte Fall-Kategorie und worauf die Anfrage den
  Schwerpunkt legt — damit nachvollziehbar ist, warum der Text so formuliert ist.
- **Notizen in Pipedrive:** die letzten Notizen am Deal. Eigene Entwurfs- und
  Freigabenotizen sind ausgeblendet.
- **Mailverlauf:** die letzten Nachrichten, neueste zuerst.

Notizen und Nachrichten stehen gekürzt da. Ist mehr vorhanden, erscheint darunter
**„Ganze Notiz"** bzw. **„Ganze Nachricht"** — ein Antippen zeigt den vollständigen
Text, ohne dass du nach Pipedrive wechseln musst.
- **Anfrage-Entwurf:** Empfänger, Betreff und der Text. **Der Text ist direkt
  bearbeitbar** — tippe hinein und ändere, was du willst.

### Entscheiden

| Knopf | Wirkung |
|---|---|
| **Freigeben & senden** | Der Entwurf gilt als freigegeben. Es wird eine Notiz „✅ Sachstandsanfrage freigegeben" an den Deal geschrieben, damit 30 Tage lang nicht erneut gefragt wird. **Achtung: aktuell geht dabei noch keine Mail raus** (siehe Abschnitt 6). |
| **Ändern lassen** | Ein Feld öffnet sich: schreibe hinein, was anders werden soll („kürzer", „förmlicher", „konkret nach der Rechnung fragen") — der Text wird neu geschrieben. Es gibt auch Schnellwahl-Knöpfe. |
| **Überspringen** | Der Fall verschwindet aus „Zu prüfen" und landet unter „Erledigt". |

Nach einer Entscheidung springt die Ansicht direkt zum nächsten offenen Fall — du
kannst die Liste also durcharbeiten, ohne zurückzugehen.

---

## 3. Wann die Lösung *nicht* fragt

Ein übersprungener Fall ist kein Fehler, sondern eine begründete Entscheidung. Der
Grund steht immer am Fall. Die Prüfkette von oben nach unten — der erste Treffer gewinnt:

| Prüfung | Quelle | Folge |
|---|---|---|
| reguliert, ausgeglichen, Zahlung angewiesen | Mail **oder** Notiz | übersprungen |
| Rückfrage der Gegenseite offen | neueste Mail an uns | **Antwort**-Entwurf statt Nachfrage |
| laufendes Gerichtsverfahren | Mail oder Notiz, jünger als 60 Tage | übersprungen |
| „abwarten", Akteneinsicht steht aus | Mail oder Notiz, jünger als 30 Tage | übersprungen |
| **Frist läuft noch** | letzte eigene Anfrage jünger als 30 Tage (60 bei Verfahren) | übersprungen |
| kein Empfänger ermittelbar | Deal-Feld „Rechtsanwalt" und Versicherung leer | übersprungen |

### Die Wiedervorlage-Frist

Das ist die Sperre gegen doppelte Anfragen. Maßgeblich ist das **Alter der letzten
Sachstandsanfrage**, nicht das Fälligkeitsdatum der Aufgabe:

- **30 Tage** im Normalfall, **60 Tage** bei laufendem Gerichtsverfahren.
- Als Anfrage zählt nur eine **ausgehende Mail mit „Sachstand" im Betreff** oder eine
  **Freigabe-Notiz am Deal**. Ein Gutachtenversand ist keine Nachfrage und unterdrückt
  die nächste nicht.
- Die Freigabe-Notiz steht in Pipedrive. Die Sperre wirkt deshalb auch dann, wenn die
  Anwendung neu gestartet wird.

Am Fall steht dann etwa: *„Unsere letzte Sachstandsanfrage: Freigabe vom 19.07.2026 —
vor 7 von 30 Tagen. Nächste Nachfrage ab 18.08.2026 (in 23 Tagen)."*

Einstellbar über `ABWARTEN_TAGE` und `GERICHT_TAGE`.

---

## 4. Wie der Entwurf entsteht

**Fakten und Formulierung sind bewusst getrennt.**

| Kommt aus festen Regeln | Kommt vom Sprachmodell |
|---|---|
| Empfänger (Deal-Feld „Rechtsanwalt", sonst Versicherung) | Formulierung des Textes |
| Aktenzeichen, Schaden- und Vertragsnummer | Schwerpunkt je Sachlage |
| Anrede (Duzen-Liste) | Bezug auf die letzte Aussage der Gegenseite |
| Überspringen ja/nein, Fristen | Einordnung in eine Kategorie |

Der Grund für die Trennung: Ein Sprachmodell formuliert eine **falsche** Schadennummer
genauso flüssig wie eine richtige — sie fällt dann niemandem auf. Adressen und Nummern
kommen deshalb aus den Daten, nicht aus dem Modell.

**Jeder Text wird geprüft, bevor du ihn siehst.** Verworfen wird er bei einem fremden
Aktenzeichen, einer nicht belegten Nummer, geänderter Anrede oder Grußformel und bei
Mahn- oder Drohformulierungen. Greift die Prüfung, siehst du den geprüften
Standardtext plus den Hinweis **„KI-Entwurf verworfen"** mit Begründung. Wenn das
häufiger vorkommt, sollten die Regeln nachgeschärft werden.

### Fall-Kategorien

In `server/rules.js` steht je Kategorie, worauf die Anfrage den Schwerpunkt legt.
Die Datei ist bewusst gut lesbar — Änderungen dort wirken sofort auf alle Fälle.

| Kategorie | Schwerpunkt |
|---|---|
| Frische Akte, keine Korrespondenz | kurze, neutrale Erstanfrage |
| **SVK gekürzt / Abtretung offen** | Stand der Rückabtretung und Reaktion auf das SV-Risiko — **nicht** pauschal nach „Regulierung" fragen, die Hauptforderung ist meist bezahlt |
| Teilzahlung eingegangen | Eingang bestätigen, nach dem Restbetrag fragen |
| Klage anhängig / Verfahren läuft | Verfahrensstand erfragen, nicht auf Zahlung drängen |
| Haftungsquote strittig | Quote nicht bewerten, nach Entscheidung fragen |
| Akteneinsicht steht aus | nur nach Eingang der Einsicht fragen |
| Kanzlei ausgefallen | taktvoll klären, wer nun bearbeitet — **nie** den ausgefallenen Anwalt ansprechen |
| Rückfrage liegt bei uns | zuerst antworten, dann beiläufig nach dem Stand fragen |
| Kein Anwalt mehr | **kein Entwurf** — Honorarklärung mit dem Kunden |
| Eigene Forderung tituliert | **kein Entwurf** — Vollstreckung, keine Sachstandssache |

Die letzten beiden erzeugen absichtlich keinen Entwurf, werden dir aber **mit
Begründung vorgelegt** statt still übersprungen.

---

## 5. Kosten

Die einzige laufende Ausgabe ist das Sprachmodell (Claude Sonnet 5):
**etwa 1,4 Cent pro Entwurf.**

Ein Entwurf wird **nur neu erzeugt, wenn sich am Fall etwas geändert hat** (neue Mail,
neue Notiz, andere Fälligkeit). Wiederholte Läufe kosten nichts. Jeder Lauf
protokolliert seine Kosten:

```
[ai] 10 Entwürfe erzeugt, geschätzte Kosten 0.1095 USD (Cache gelesen: 36620 Token)
[worker] Lauf fertig: 19 Fälle (0 unverändert übernommen), 112 Pipedrive-Aufrufe, 17 zur Freigabe.
```

Die Pipedrive-API hat ein Tageskontingent. Mit einem Lauf am Tag liegt der
Verbrauch bei rund 110 Abrufen — zuvor waren es bei halbstündlichen Läufen
über 6000.

Empfehlung: in der Anthropic-Console unter *Settings → Limits* ein Monatslimit
setzen. Bei diesem Volumen wird es nie erreicht.

---

## 6. Freigabe, Outlook-Entwurf und Zuordnung in Pipedrive

Beim Freigeben passiert dreierlei:

1. Die Freigabe wird als Notiz am Deal protokolliert.
2. Der Text landet als **Entwurf im Outlook-Postfach** (`MS_SENDER_UPN`), nicht als
   fertige Mail. Abgeschickt wird erst von dir aus Outlook — nichts geht ungefragt
   raus. Der Entwurf wird als HTML ohne feste Schriftart und Farbe angelegt, damit er
   die Outlook-Einstellungen erbt; das Kopieren aus einer Notiz mitsamt schwarzer
   Unterstreichung entfällt.
3. Die **Aufgabe in Pipedrive wird abgeschlossen**. Daran hängen dort die
   Automatisierungen, die die nächste Wiedervorlage anlegen — bliebe sie offen,
   entstünde keine Erinnerung und der Fall stünde am nächsten Tag wieder in der Liste.
4. Im Cockpit erscheint ein Link direkt zu diesem Entwurf.

Die Ergebniskarte zeigt für jeden dieser Schritte eine eigene Zeile, damit ohne Blick
nach Pipedrive erkennbar ist, was angekommen ist und was noch aussteht. **An jeder
offenen Zeile hängt ein eigener Knopf**, der genau diesen Schritt sofort ausführt —
„Notiz jetzt anlegen", „Aufgabe jetzt abschließen", „Entwurf jetzt anlegen". Das kostet
einen einzigen Pipedrive-Aufruf; der Knopf ⟳ oben würde dafür alle Fälle neu laden
(rund 110 Aufrufe).

Nimmt Pipedrive die Notiz oder den Abschluss der Aufgabe gerade nicht an — praktisch immer, weil das Tageskontingent
der Pipedrive-Schnittstelle aufgebraucht ist —, **entsteht der Outlook-Entwurf
trotzdem**. Der offene Schritt wird vorgemerkt und selbsttätig nachgeholt: erstmals nach einer
Viertelstunde, danach in wachsenden Abständen (30 Minuten, 1 Stunde, 2, 4, höchstens 6),
bis es klappt. Das hängt **nicht** am Tageslauf — ein abends aufgebrauchtes Kontingent
ist um Mitternacht wieder frei, und der nächste Anlauf kommt dann von allein. Wer nicht
warten will, drückt **⟳**; das übergeht die Wartezeit. Nach drei Tagen ohne Erfolg wird
aufgegeben und im Log vermerkt.

In der Ergebniskarte des Falls steht, ob die Notiz angekommen ist.

Umgekehrt gilt: Lässt sich der Entwurf *nicht* anlegen, wird die Freigabe **nicht**
vermerkt und der Fall bleibt in der Liste — sonst verschwände er, ohne dass irgendwo
eine Mail läge.

**Zuordnung zum richtigen Deal.** Der Betreff trägt Kundenname und Aktenzeichen
(`Sachstandsanfrage · Nuhi · [Az. 0824/1308TG]`). Das hilft beim Suchen, ordnet die
Mail aber noch keinem Vorgang zu — Pipedrive erkennt über die Empfängeradresse nur
die *Person*, und eine Kanzlei hängt an vielen Deals gleichzeitig. Deshalb bekommt
jeder Entwurf zusätzlich die **deal-eigene Dropbox-Adresse als Blindkopie**:

```
kfz-sachverstaendigenbuerogollenstede+deal<Deal-ID>@pipedrivemail.com
```

In `PIPEDRIVE_BCC_DROPBOX` genügt ein Beispiel dieser Adresse (mit oder ohne
`+deal…`) — die Deal-Nummer setzt die App je Fall selbst ein. Ist die Variable leer,
wird kein BCC gesetzt und der Entwurf trotzdem angelegt.

**Das persistente Volume.** `DATA_DIR=/data` ist gesetzt; in Coolify dazu unter
*Application → Persistent Storage → + Add → **Volume Mount*** anlegen: Name z. B.
`sachstaende-data`, Mount Path `/data`, Host-Pfad leer lassen (Coolify legt ein
benanntes Docker-Volume an). *Directory Mount* wäre ein Bind-Mount auf einen
Serverpfad, *File Mount* nur für einzelne Dateien — für `/data` ist der Volume Mount
richtig. Danach einmal *Redeploy*. Ohne Volume wird die Warteschlange bei jedem
Deployment geleert und alle Entwürfe werden neu erzeugt — rund 30 Cent pro
Deployment. **Doppelte Anfragen entstehen dadurch nicht**, dafür sorgt die Notiz in
Pipedrive.

---

## 7. Einrichtung der Anmeldung (Entra ID)

Einmalig im Azure-Portal unter *Microsoft Entra ID → App-Registrierungen*:

1. **Neue Registrierung**, Name z. B. `Sachstands-Cockpit`.
   Kontotypen: *Nur Konten in diesem Organisationsverzeichnis*.
2. **Redirect-URI** hinzufügen, Plattform **Web**:
   `https://sachstaende.gollenstede.app/auth/callback`
3. Unter *Zertifikate & Geheimnisse* ein **neues Client-Secret** erzeugen und den Wert
   sofort kopieren (er wird nur einmal angezeigt).
4. Unter *API-Berechtigungen* genügen die Standardrechte
   (`openid`, `profile`, `email`) — mehr braucht die Anmeldung nicht.
5. In Coolify unter *Environment Variables* setzen:

```
MS_TENANT_ID=<Verzeichnis-ID (Mandant)>
MS_CLIENT_ID=<Anwendungs-ID (Client)>
MS_CLIENT_SECRET=<der kopierte Wert>
APP_PUBLIC_URL=https://sachstaende.gollenstede.app
SESSION_SECRET=<beliebige lange Zufallszeichenfolge>
SESSION_STUNDEN=12
ENTRA_ERLAUBTE_NUTZER=lgollenstede@gollenstede-sachverstand.de
```

`ENTRA_ERLAUBTE_NUTZER` ist optional. Leer bedeutet: **jedes** Konto des Mandanten
darf sich anmelden. Mit Liste (Komma getrennt) nur die genannten Adressen.

6. Danach **Redeploy**. Im Log steht dann `Zugangsschutz: Microsoft Entra ID`.

**Solange Entra nicht vollständig konfiguriert ist, greift weiter Basic-Auth**
(`BASIC_AUTH_USER` / `BASIC_AUTH_PASS`). Die Anwendung steht also nie ungeschützt
im Netz, sperrt dich aber auch nicht aus. Sind beide nicht gesetzt, warnt das Log
deutlich.

### Wie die Anmeldung technisch abläuft

Authorization Code Flow mit PKCE. Der Code wird serverseitig gegen Tokens getauscht —
das Client-Secret verlässt den Server nie. Geprüft werden Zielgruppe, Mandant,
Aussteller und Gültigkeit des ID-Tokens sowie die Freigabeliste. Die Sitzung steckt
in einem signierten Cookie (`HttpOnly`, `SameSite=Lax`, hinter HTTPS zusätzlich
`Secure`); ein Sitzungsspeicher ist nicht nötig, die Anmeldung übersteht Neustarts.

---

## 8. Wenn etwas nicht stimmt

| Beobachtung | Ursache und Abhilfe |
|---|---|
| „Die Anmeldung ist noch nicht konfiguriert" | Eine der vier Variablen aus Abschnitt 7 fehlt. |
| Nach der Anmeldung sofort wieder auf der Anmeldeseite | Cookie kommt nicht an — steht `APP_PUBLIC_URL` auf **https**? |
| „Das Konto … ist nicht freigegeben" | Adresse in `ENTRA_ERLAUBTE_NUTZER` ergänzen. |
| „Anmeldung aus einem fremden Mandanten" | `MS_TENANT_ID` gehört zu einem anderen Verzeichnis. |
| Liste bleibt leer | Gibt es fällige Aufgaben mit Betreff „Sachstand anfragen" und `due_date <= heute`? Der Knopf **⟳** löst einen Lauf sofort aus. |
| Alle Fälle „Empfänger unklar" | Im Deal fehlt das Feld „Rechtsanwalt" bzw. eine Versicherung. |
| Entwürfe klingen unpassend | Kategorie am Fall prüfen und den Schwerpunkt in `server/rules.js` anpassen. |
| Häufig „KI-Entwurf verworfen" | Der Prüfschritt greift zu oft — die Prompt-Regeln müssen nachgeschärft werden. |
| Nach einem Deployment ist die Liste leer | Fehlendes Volume (Abschnitt 6). Der nächste Lauf füllt sie wieder. |

**Logs ansehen:** Coolify → Application → *Logs*. Aussagekräftige Zeilen beginnen mit
`[worker]`, `[ai]` oder `[auth]`.
