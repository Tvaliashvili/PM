// =============================================================
// Saving a built report as a PDF, in one of two shapes.
//
// "Continuous" is one page as long as the document needs. Nothing is cut,
// because there is no cut to make; it is meant to be read on screen.
//
// "Printable" is A4 sheets, for a report that will be put on paper or filed as
// one. html2pdf paginates by slicing the rendered image at fixed heights and
// has no idea where a line of text falls, so the breaks are measured and
// spaced out first - see paginate.js.
// =============================================================
import { continuousFormat, renderScale } from './pdfPage.js';
import { insertPageBreaks } from './paginate.js';

const MARGIN_MM = [10, 10, 12, 10]; // top, right, bottom, left

/**
 * Waits until a built page can be measured and drawn: the Georgian font loaded,
 * and every photo either in or given up on. A picture still loading would be
 * drawn as a blank frame, and would measure as nothing - which throws out the
 * page height, the page breaks and any picture cut from the page.
 */
export async function pageReady(page) {
  await document.fonts?.ready;
  await Promise.all([...page.querySelectorAll('img')].map((img) => (
    img.complete ? img.decode().catch(() => {}) : new Promise((done) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    })
  )));
}

/**
 * Writes out the capitals that CSS only asks for. A browser leaves Georgian
 * alone under text-transform: uppercase; html2canvas does not, and turns it
 * into Mtavruli. So the Latin is raised in the text itself and the transform
 * taken off - the page looks as it did, and the render matches it.
 */
export function settleCapitals(page) {
  const raised = new Set();
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || getComputedStyle(el).textTransform !== 'uppercase') continue;
    n.nodeValue = n.nodeValue.replace(/\P{Script=Georgian}+/gu, (t) => t.toUpperCase());
    raised.add(el);
  }
  for (const el of raised) el.style.textTransform = 'none';
}

/**
 * @param {HTMLElement} page      the built report, laid out in the document
 * @param {string} filename       including the .pdf
 * @param {boolean} printable     true for A4 sheets, false for one long page
 */
export async function savePdf(page, filename, { printable = false } = {}) {
  await pageReady(page);
  settleCapitals(page);
  if (printable) insertPageBreaks(page, MARGIN_MM);

  await window.html2pdf()
    .set({
      margin: MARGIN_MM,
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: renderScale(page), useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: {
        unit: 'mm',
        format: printable ? 'a4' : continuousFormat(page, MARGIN_MM),
        orientation: 'portrait',
      },
      // On A4 the breaks are already spaced out above, so html2pdf only has to
      // cut on the grid it was given. On one page there is nothing to cut.
      pagebreak: { mode: printable ? ['css', 'legacy'] : [] },
    })
    .from(page)
    .save();
}
