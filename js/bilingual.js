// =============================================================
// Bilingual (Georgian / English) text for generated documents.
// The app UI is English; every document it produces shows both.
// Keys are the English strings used in config.js and the report.
// =============================================================

export const KA = {
  // Weather
  'Sunny': 'მზიანი',
  'Cloudy': 'ღრუბლიანი',
  'Rain': 'წვიმა',
  'Heavy rain': 'ძლიერი წვიმა',
  'Windy': 'ქარიანი',
  'Snow': 'თოვლი',
  'Extreme heat': 'ძლიერი სიცხე',

  // Delay causes
  'Weather': 'ამინდი',
  'Material shortage': 'მასალის დეფიციტი',
  'Labour shortage': 'სამუშაო ძალის ნაკლებობა',
  'Equipment breakdown': 'ტექნიკის გაუმართაობა',
  'Design change': 'პროექტის ცვლილება',
  'Permit / inspection': 'ნებართვა / ინსპექცია',
  'Subcontractor': 'ქვეკონტრაქტორი',
  'Payment / funding': 'გადახდა / დაფინანსება',
  'Other': 'სხვა',

  // Trades (manpower)
  'Masons': 'კალატოზები',
  'Carpenters': 'დურგლები',
  'Steel fixers': 'არმატურის მომწყობები',
  'Concrete workers': 'ბეტონის ჩამსხმელები',
  'Electricians': 'ელექტრიკოსები',
  'Plumbers': 'სანტექნიკოსები',
  'Tilers': 'მომპირკეთებლები',
  'Painters': 'მღებავები',
  'Labourers': 'დამხმარე მუშები',
  'Daily workers': 'დღიური მუშები',

  // Report phrases
  'Site-wide': 'მთელი ობიექტი',
  'Not recorded': 'არ არის ჩაწერილი',
  'Total': 'სულ',
  'No manpower recorded.': 'სამუშაო ძალა არ არის ჩაწერილი.',
  'No delays recorded today.': 'დღეს შეფერხებები არ დაფიქსირებულა.',
  'No site notes recorded.': 'ობიექტის შენიშვნები არ არის.',
  'No daily log or delays were recorded for this project today.':
    'დღეს ამ პროექტზე დღიური ჩანაწერი ან შეფერხება არ დაფიქსირებულა.',
  'AI summary unavailable': 'AI შეჯამება მიუწვდომელია',
  'Summary written by Gemini from the log and delay entries in this report.':
    'შეჯამება შექმნილია Gemini-ს მიერ ამ ანგარიშის ჩანაწერებისა და შეფერხებების საფუძველზე.',
  'Generated': 'შექმნილია',
  'Block': 'ბლოკი',
  'Room': 'ოთახი',
  'No timetable': 'გრაფიკი არ არის',
  'plan': 'გეგმა',
};

/** Georgian for an English term, or the English itself when there's no entry. */
export const ka = (en) => KA[en] ?? en;

/** "ქართული / English" — both languages on one line. */
export const bi = (en) => (KA[en] ? `${KA[en]} / ${en}` : en);

/** Bilingual "Prepared by" block for the end of a document (HTML string). */
export function signatureHtml(author) {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `
    <div class="doc-signature">
      <p class="doc-signature-label">მოამზადა · Prepared by</p>
      <p class="doc-signature-name">${e(author.nameKa)} <span>/ ${e(author.name)}</span></p>
      <p class="doc-signature-title">${e(author.titleKa)} <span>/ ${e(author.title)}</span></p>
      <div class="doc-signature-line"><span>ხელმოწერა · Signature</span></div>
    </div>`;
}

/** A name spelled in both languages: "ქართული / English", or whichever exists. */
export const biName = (en, ka) => (en && ka && en !== ka ? `${ka} / ${en}` : (ka || en || ''));

const KA_MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი',
  'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
const KA_WEEKDAYS = ['კვირა', 'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი'];

// Spelled out by hand so the result doesn't depend on the browser's Georgian locale data.
export function dateKa(iso) {
  const d = new Date(`${iso}T00:00`);
  return `${KA_WEEKDAYS[d.getDay()]}, ${d.getDate()} ${KA_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function dateEn(iso) {
  return new Date(`${iso}T00:00`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}
