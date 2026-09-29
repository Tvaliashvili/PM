// =============================================================
// Page breaks for the generated PDFs.
//
// html2pdf renders the whole document to one tall image and then cuts it at
// fixed intervals. Its own "avoid" rules and the CSS break-inside properties
// are advisory at best, so a heading or a table row regularly lands half on one
// page and half on the next - and half a line of Georgian reads as a different
// word, not as a clipped one.
//
// So the cuts are placed here instead, before anything is rendered: every
// element that has to stay whole is measured against the page grid, and a
// spacer pushes it onto the next page when it would straddle a boundary.
// =============================================================

const A4 = { width: 210, height: 297 }; // mm, portrait

/** Anything in here is never cut through the middle. Document order matters. */
const KEEP_WHOLE = [
  'h1', 'h2', 'h3',
  '.rpt-h', '.rpt-sub-h', '.rpt-legend', '.rpt-chart', '.rpt-tile', '.rpt-panel',
  '.rpt-card', '.rpt-tiles', '.rpt-ring-box', '.rpt-log', '.rpt-bar-row',
  '.pdf-facts', '.pdf-avoid-break', '.doc-signature',
  'tr', 'p',
].join(',');

const spacerOf = (height, template) => {
  // A spacer between table rows has to be a row itself, or the table breaks.
  if (template.tagName === 'TR') {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = template.children.length || 1;
    td.style.cssText = `height:${height}px;padding:0;border:0;background:none`;
    tr.appendChild(td);
    return tr;
  }
  const div = document.createElement('div');
  div.style.cssText = `height:${height}px`;
  return div;
};

/**
 * Inserts spacers into `page` so that no kept-whole element is cut by a page
 * break. Call it once the page is laid out in the document and the fonts have
 * loaded - it measures, so nothing may move afterwards.
 *
 * @param {HTMLElement} page      the rendered report, already in the DOM
 * @param {number[]} marginMm     html2pdf's margin: [top, right, bottom, left]
 */
export function insertPageBreaks(page, marginMm) {
  const [mTop, mRight, mBottom, mLeft] = marginMm;
  const width = page.getBoundingClientRect().width;
  if (!width) return; // not laid out - leave it to html2pdf rather than guess

  // The page is drawn at `width` px across and scaled to fit the printable
  // width, so one page of height is that same scale applied to the mm left
  // between the top and bottom margins.
  const pxPerMm = width / (A4.width - mLeft - mRight);
  const pageHeight = (A4.height - mTop - mBottom) * pxPerMm;
  if (!(pageHeight > 0)) return;

  for (const el of page.querySelectorAll(KEEP_WHOLE)) {
    // Read fresh each time: a spacer inserted for an earlier element has
    // already moved everything below it.
    const pageTop = page.getBoundingClientRect().top;
    const box = el.getBoundingClientRect();
    const top = box.top - pageTop;
    const height = box.height;
    // Taller than a page, or empty: it has to be cut somewhere regardless.
    if (height <= 0 || height > pageHeight) continue;

    const startsOn = Math.floor(top / pageHeight);
    // A hair off the bottom edge is a rounding artefact, not a second page.
    const endsOn = Math.floor((top + height - 1) / pageHeight);
    if (startsOn === endsOn) continue;

    const gap = (startsOn + 1) * pageHeight - top;
    el.parentNode?.insertBefore(spacerOf(gap, el), el);
  }
}
