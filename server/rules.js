"use strict";

/*
 * Fachliche Regeln für Sachstandsanfragen — die einzige Stelle, an der Ton und
 * Schwerpunkt je Sachlage festgelegt werden. Bewusst als eigene Datei: hier soll
 * ohne Programmierkenntnisse nachgeschärft werden können. Änderungen wirken
 * sofort auf alle Fälle.
 *
 * Die Kategorien wurden aus der Auswertung von 25 echten offenen Fällen des
 * Büros abgeleitet (Notizen + Mailverlauf), nicht erfunden.
 */

const GENERAL_RULES = [
  "GRUNDHALTUNG: Wir sind Sachverständige, nicht Partei. Gefragt wird nach dem Stand der Regulierung",
  "unseres Gutachtens bzw. unserer Sachverständigenkosten (SVK). Wir bewerten keine Haftung und treiben nicht ein.",
  "Der Ton ist kollegial gegenüber Kanzleien, mit denen laufend zusammengearbeitet wird.",
  "Nimm auf die letzte inhaltliche Aussage der Gegenseite Bezug — das zeigt, dass gelesen wurde,",
  "und erspart Wiederholungen. Frage nur, was tatsächlich noch offen ist.",
  "WICHTIG: Häufig ist die Hauptforderung (Reparatur/Wiederbeschaffung) längst bezahlt und NUR unsere",
  "Kostenrechnung offen oder gekürzt. Eine pauschale Frage „wurde reguliert?“ wirkt dann unaufmerksam."
].join(" ");

/**
 * @typedef {object} Category
 * @property {string} id           Schlüssel (stabil, wird gespeichert)
 * @property {string} label        Bezeichnung für die Anzeige
 * @property {string} focus        Schwerpunkt-Anweisung an das Modell
 * @property {boolean} [noRequest] true = hier ist eine Sachstandsanfrage grundsätzlich
 *                                 unpassend; der Fall wird zur Prüfung vorgelegt,
 *                                 aber kein Anfrage-Entwurf erzeugt.
 */

/** @type {Category[]} */
const CATEGORIES = [
  {
    id: "neu_ohne_reaktion",
    label: "Frische Akte, keine Korrespondenz",
    focus:
      "Gutachten wurde versandt, es gibt noch keine Reaktion. Kurze, neutrale Erstanfrage: liegen Gutachten und "
      + "Kostenrechnung vor, ist die Regulierung veranlasst? Schaden- bzw. Vertragsnummer nennen. "
      + "NICHT auf frühere Korrespondenz Bezug nehmen (es gibt keine) und keinen Mahnton anschlagen."
  },
  {
    id: "honorarkuerzung_rueckabtretung",
    label: "SVK gekürzt / Abtretung offen",
    focus:
      "Der Versicherer hat unsere Sachverständigenkosten gekürzt (häufig ADAC, HUK) oder das Sachverständigenrisiko "
      + "nicht anerkannt. Die Hauptforderung ist meist bezahlt — frage deshalb NICHT pauschal nach „Regulierung“, "
      + "sondern gezielt: Stand der Abtretung bzw. Rückabtretung, Reaktion des Versicherers auf das SV-Risiko, "
      + "und wie mit dem gekürzten Restbetrag weiter verfahren wird. Einen belegten Kürzungsbetrag darfst du benennen. "
      + "Die Kürzung nicht rechtlich bewerten; anbieten, die Kostenrechnung zu erläutern."
  },
  {
    id: "teilzahlung_restbetrag",
    label: "Teilzahlung eingegangen, Rest offen",
    focus:
      "Es ist ein Teilbetrag eingegangen. Den Zahlungseingang zuerst bestätigen (Datum und Betrag nur, wenn belegt), "
      + "dann nach dem offenen Restbetrag und dem Grund der Differenz fragen. "
      + "NIEMALS fragen, ob überhaupt gezahlt wurde — das wirkt unaufmerksam."
  },
  {
    id: "klage_anhaengig",
    label: "Klage anhängig / Verfahren läuft",
    focus:
      "Es läuft ein Gerichtsverfahren (ggf. Berufung). Bis zum Urteil zahlt niemand — frage deshalb NICHT nach "
      + "„Regulierung veranlasst“. Erfrage den Verfahrensstand: Termin, Instanz, nächste Schritte, und ob unsere "
      + "Kosten im Verfahren mitgeltend gemacht sind. Anbieten, für Rückfragen des Gerichts oder ergänzende "
      + "Unterlagen bereitzustehen. Keine Einschätzung der Erfolgsaussichten."
  },
  {
    id: "quote_strittig",
    label: "Haftungsquote strittig",
    focus:
      "Die Haftung ist ganz oder teilweise bestritten (z. B. Teilschuld, Abrechnung 50:50). Die Quote NICHT bewerten "
      + "und keine Aussage zur Haftung treffen. Fragen, ob zur Quote eine Entscheidung vorliegt und ob unsere Kosten "
      + "anteilig abgerechnet werden."
  },
  {
    id: "akteneinsicht_offen",
    label: "Akteneinsicht steht aus",
    focus:
      "Es wird auf Ermittlungs- bzw. Strafakte oder ergänzende Akteneinsicht gewartet. Nur fragen, ob die Einsicht "
      + "inzwischen gewährt wurde und welche Schritte dann folgen. Ankündigen, dass wir uns entsprechend später "
      + "wieder melden — kein Druck."
  },
  {
    id: "kanzlei_ausgefallen",
    label: "Kanzlei ausgefallen / Abwicklung",
    focus:
      "Die Zuständigkeit ist entfallen (Anwalt verstorben, Kanzlei in Abwicklung, Mandat übergegangen). Besonders "
      + "taktvoll, keinerlei Druck. NIEMALS den ausgefallenen Anwalt persönlich ansprechen. Zunächst klären: Wer "
      + "bearbeitet die Sache jetzt (Abwickler, neue Kanzlei), ist unser Gutachten dort angekommen, und wohin sollen "
      + "wir Unterlagen und Kostenrechnung richten?"
  },
  {
    id: "rueckfrage_offen",
    label: "Rückfrage liegt bei uns",
    focus:
      "Die Gegenseite hat UNS etwas gefragt oder Unterlagen erbeten (z. B. Angaben zu Vorschäden, Lichtbilder, "
      + "Reparaturrechnung). Zuerst darauf eingehen und die Erledigung zusagen, DANN beiläufig nach dem Stand fragen. "
      + "Die Rückfrage konkret benennen, damit erkennbar ist, worauf sich die Antwort bezieht."
  },
  {
    id: "mandat_beendet_honorarklaerung",
    label: "Kein Anwalt mehr — Honorar beim Kunden",
    focus:
      "Das Mandat ist beendet bzw. die Honorarforderung wurde an uns zurückabgetreten; der Kunde wendet sich direkt "
      + "an uns, teils mit der Bitte um Kürzung. Hier ist eine Sachstandsanfrage an eine Kanzlei verfehlt — der Fall "
      + "gehört zur Honorarklärung mit dem Kunden. Keinen Anfrage-Entwurf erzeugen.",
    noRequest: true
  },
  {
    id: "titulierte_eigenforderung",
    label: "Eigene Forderung tituliert / Vollstreckung",
    focus:
      "Es geht um unsere eigene, titulierte Forderung gegen den Kunden (Kostenfestsetzung, vollstreckbare "
      + "Ausfertigung, Ratenzahlung). Das ist keine Sachstandsanfrage zur Regulierung. Keinen Anfrage-Entwurf "
      + "erzeugen — der Fall gehört in die Vollstreckungs- bzw. Ratenverfolgung.",
    noRequest: true
  }
];

/** Kategorien, in denen kein Anfrage-Entwurf erzeugt werden soll. */
const NO_REQUEST_IDS = CATEGORIES.filter(c => c.noRequest).map(c => c.id);

function categoryById(id) {
  return CATEGORIES.find(c => c.id === id) || null;
}

module.exports = { CATEGORIES, GENERAL_RULES, NO_REQUEST_IDS, categoryById };
