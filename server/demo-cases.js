// Beispieldaten für den Demo-Modus (DEMO_MODE=true).
// Im Echtbetrieb liefern die Provider (Pipedrive + Microsoft 365) diese Struktur.
// Struktur ist bewusst identisch zur späteren Live-Antwort, damit das Frontend
// nichts ändern muss, wenn wir von Demo auf echte Daten umstellen.

module.exports = [
  {
    id: "c1", token: "2024/0231TG", name: "Ahrends", status: "ueberfaellig",
    recipType: "Kanzlei", recipOrg: "Kanzlei Vogt & Partner", recipPerson: "Fr. Claudia Busch",
    recipEmail: "c.busch@vogt-partner.de", du: true, salutation: "Hallo Claudia,",
    accident: "02.04.2026", insurer: "HUK-Coburg", schadenNr: "SC-4471203", wait: 21, due: "05.07.2026",
    lastStatus: "Unsere Anfrage vom 15.06. blieb bisher unbeantwortet. Letzte inhaltliche Rückmeldung: Kanzlei prüfte am 28.05. die Aktivlegitimation.",
    calloutType: "info",
    thread: [
      { dir: "in", who: "Kanzlei Vogt & Partner", tag: "Eingang", when: "28.05.2026", snippet: "„…wir prüfen derzeit die Aktivlegitimation und melden uns, sobald die Versicherung Stellung genommen hat.“" },
      { dir: "out", who: "Büro Gollenstede", tag: "Gesendet", when: "15.06.2026", snippet: "Erste Sachstandsnachfrage: ob Regulierung des Gutachtens veranlasst wurde." }
    ],
    draft:
`Hallo Claudia,

in der Schadensache Ahrends (unser Az. 2024/0231TG, Unfall vom 02.04.2026, HUK-Coburg Schaden-Nr. SC-4471203) möchte ich mich nach dem aktuellen Sachstand erkundigen.

Du teiltest am 28.05.2026 mit, dass die Aktivlegitimation geprüft wird und ihr euch nach Stellungnahme der Versicherung meldet. Auf unsere Nachfrage vom 15.06.2026 haben wir seither keine Rückmeldung erhalten.

Wurde die Regulierung des Gutachtens bzw. der Rechnung inzwischen veranlasst? Über eine kurze Rückmeldung zum Stand freue ich mich.

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`,
    draftAlt:
`Hallo Claudia,

kurze Rückfrage in der Schadensache Ahrends (Az. 2024/0231TG, HUK-Coburg SC-4471203): Gibt es zur Regulierung des Gutachtens inzwischen einen neuen Stand? Deine letzte Rückmeldung datiert vom 28.05.2026.

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`
  },
  {
    id: "c2", token: "2024/0198TG", name: "Kowalczyk", status: "ueberfaellig",
    recipType: "Versicherung", recipOrg: "VHV Allgemeine Versicherung AG", recipPerson: null,
    recipEmail: "schaden@vhv.de", du: false, salutation: "Sehr geehrte Damen und Herren,",
    accident: "18.03.2026", insurer: "VHV", schadenNr: "SCH-2026-88213", vertragNr: "V-559102", wait: 34, due: "22.06.2026",
    lastStatus: "Kein Anwalt hinterlegt — Empfänger ist die Versicherung direkt. Erst-Sachstandsanfrage, es liegt noch keine Antwort vor.",
    calloutType: "info",
    thread: [
      { dir: "out", who: "Büro Gollenstede", tag: "Gesendet", when: "20.05.2026", snippet: "Gutachten übersandt, Bitte um Regulierung der Sachverständigenkosten." }
    ],
    draft:
`Sehr geehrte Damen und Herren,

in der Schadensache Kowalczyk (unser Az. 2024/0198TG, Unfall vom 18.03.2026, VHV Schaden-Nr. SCH-2026-88213, Vertrags-Nr. V-559102) bitten wir um eine kurze Rückmeldung zum Sachstand.

Wurde die Regulierung unserer Sachverständigenkosten bzw. des Gutachtens inzwischen veranlasst? Sofern noch Unterlagen benötigt werden, teilen Sie uns dies bitte mit.

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`,
    draftAlt:
`Sehr geehrte Damen und Herren,

wir kommen zurück auf die Schadensache Kowalczyk (Az. 2024/0198TG, VHV Schaden-Nr. SCH-2026-88213). Nachdem seit Übersendung des Gutachtens am 20.05.2026 keine Rückmeldung erfolgte, bitten wir um kurzfristige Mitteilung des Regulierungsstandes.

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`
  },
  {
    id: "c3", token: "2025/0044TG", name: "Petersen", status: "rueckfrage",
    recipType: "Kanzlei", recipOrg: "Rechtsanwälte Böhm", recipPerson: "Hr. Philipp Nadler",
    recipEmail: "nadler@ra-boehm.de", du: true, salutation: "Hallo Philipp,",
    accident: "11.05.2026", insurer: "Allianz", schadenNr: "AZ-778120", wait: 4, due: "24.07.2026",
    lastStatus: "Neueste Mail kommt von der Kanzlei und enthält eine offene Rückfrage AN UNS — kein Standard-Entwurf, sondern Rückfrage-Hinweis.",
    calloutType: "warn",
    calloutTitle: "Rückfrage offen",
    calloutBody: "Kanzlei-Mail vom 22.07.2026: „Können Sie uns die Lichtbilder zum Heckschaden nochmals in besserer Auflösung zusenden?“ — bitte zuerst beantworten, dann Sachstand.",
    thread: [
      { dir: "in", who: "Rechtsanwälte Böhm", tag: "Eingang", when: "22.07.2026", snippet: "„…können Sie uns die Lichtbilder zum Heckschaden nochmals in besserer Auflösung zusenden? Die Allianz hat hierzu nachgefragt.“" },
      { dir: "out", who: "Büro Gollenstede", tag: "Gesendet", when: "10.07.2026", snippet: "Sachstandsnachfrage zur Regulierung." }
    ],
    draft:
`Hallo Philipp,

danke für deine Nachricht vom 22.07.2026. Die Lichtbilder zum Heckschaden in höherer Auflösung sende ich dir gleich gesondert zu.

Magst du mir bei der Gelegenheit auch kurz den Regulierungsstand der Allianz (Schaden-Nr. AZ-778120) mitteilen?

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`,
    draftAlt:
`Hallo Philipp,

die höher aufgelösten Lichtbilder zum Heckschaden folgen gleich per separater Mail. Sag gern Bescheid, falls die Allianz darüber hinaus noch etwas benötigt — und ob es zur Regulierung (AZ-778120) schon einen Stand gibt.

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`,
    isRueckfrage: true
  },
  {
    id: "c4", token: "2025/0112TG", name: "Söderberg", status: "reguliert",
    recipType: "Kanzlei", recipOrg: "Kanzlei Reinhard & Kollegen", recipPerson: "Fr. Dr. Lang",
    recipEmail: "lang@reinhard-kollegen.de", du: false, salutation: "Sehr geehrte Damen und Herren,",
    accident: "07.06.2026", insurer: "R+V", schadenNr: "RV-903221", wait: 2, due: "26.07.2026",
    lastStatus: "Mail der Kanzlei vom 24.07.2026: reguliert — Zahlung ist angewiesen. Kein Entwurf nötig.",
    calloutType: "ok",
    calloutTitle: "Bereits reguliert",
    calloutBody: "Mail der Kanzlei vom 24.07.2026: „Die R+V hat die Sachverständigenkosten vollständig ausgeglichen, die Zahlung ist angewiesen.“ — Aufgabe kann übersprungen und abgeschlossen werden.",
    thread: [
      { dir: "in", who: "Kanzlei Reinhard & Kollegen", tag: "Eingang", when: "24.07.2026", snippet: "„…die R+V hat die Sachverständigenkosten vollständig ausgeglichen, die Zahlung ist angewiesen. Der Vorgang ist damit erledigt.“" },
      { dir: "out", who: "Büro Gollenstede", tag: "Gesendet", when: "01.07.2026", snippet: "Sachstandsnachfrage zur Regulierung." }
    ],
    draft: null,
    skipReason: "reguliert (Mail der Kanzlei vom 24.07.2026)"
  },
  {
    id: "c5", token: "2025/0087TG", name: "Marchetti", status: "faellig",
    recipType: "Kanzlei", recipOrg: "Anwaltskanzlei Seifert", recipPerson: "Hr. Jens Schlossmacher",
    recipEmail: "schlossmacher@kanzlei-seifert.de", du: true, salutation: "Hallo Jens,",
    accident: "30.05.2026", insurer: "DEVK", schadenNr: "DK-2026-4410", wait: 0, due: "26.07.2026",
    lastStatus: "Erst-Sachstandsanfrage. Kanzlei ist zuständig, Ansprechpartner duzt sich (aus Korrespondenz + Anrede-Regeln).",
    calloutType: "info",
    thread: [
      { dir: "out", who: "Büro Gollenstede", tag: "Gesendet", when: "12.06.2026", snippet: "Gutachten und Kostenrechnung an Kanzlei übersandt." }
    ],
    draft:
`Hallo Jens,

in der Schadensache Marchetti (unser Az. 2025/0087TG, Unfall vom 30.05.2026, DEVK Schaden-Nr. DK-2026-4410) wollte ich mich nach dem aktuellen Sachstand erkundigen.

Wir hatten euch Gutachten und Kostenrechnung am 12.06.2026 übersandt. Gibt es von der DEVK zwischenzeitlich eine Rückmeldung, bzw. wurde die Regulierung veranlasst?

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`,
    draftAlt:
`Hallo Jens,

kurze Nachfrage zur Schadensache Marchetti (Az. 2025/0087TG, DEVK DK-2026-4410): Liegt inzwischen eine Reaktion der DEVK auf unser Gutachten vom 12.06.2026 vor?

Viele Grüße
Kfz-Sachverständigenbüro Gollenstede`
  },
  {
    id: "c6", token: "2025/0129TG", name: "Novak", status: "unklar",
    recipType: null, recipOrg: null, recipPerson: null, recipEmail: null, du: false,
    accident: "14.06.2026", insurer: null, schadenNr: null, vertragNr: null, wait: 1, due: "25.07.2026",
    lastStatus: "Weder Anwalt noch Versicherung in der Fallnotiz hinterlegt — kein Empfänger bestimmbar.",
    calloutType: "warn",
    calloutTitle: "Empfänger unklar",
    calloutBody: "In der Vault-Fallnotiz sind weder eine Kanzlei noch eine Versicherung hinterlegt. Bitte Empfänger im Vault ergänzen, dann erneut auslösen. Kein Entwurf erzeugt.",
    thread: [],
    draft: null,
    skipReason: "Empfänger unklar (Vault unvollständig)"
  }
];
