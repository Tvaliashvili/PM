// =============================================================
// Page size for the generated PDFs.
//
// The reports are produced as one continuous page, as long as the document
// needs, rather than cut into A4 sheets. html2pdf paginates by slicing the
// rendered image at fixed heights, and nothing tells it where a line of text
// or a table row happens to fall - so the cuts landed through headings, rows
// and photographs. A single page has no cuts to land anywhere: it scrolls.
// =============================================================

const A4_WIDTH_MM = 210;

// PDF measures a page in points and stores the number in 16 bits' worth of
// them, which stops at 200 inches. Past that the file is still written but
// readers disagree about it, so it is worth knowing where the edge is.
const MAX_HEIGHT_MM = 200 * 25.4;

/**
 * The jsPDF `format` for a report: A4 wide, and tall enough for all of it.
 *
 * @param {HTMLElement} page      the built report, laid out in the document
 * @param {number[]} marginMm     [top, right, bottom, left]
 * @returns {number[]}            [width, height] in mm
 */
export function continuousFormat(page, marginMm) {
  const [mTop, mRight, mBottom, mLeft] = marginMm;
  const box = page.getBoundingClientRect();
  const printableMm = A4_WIDTH_MM - mLeft - mRight;
  // The report is laid out at a fixed pixel width that stands for the
  // printable width, which is what ties pixels to millimetres here.
  const pxPerMm = box.width / printableMm;
  if (!(pxPerMm > 0)) return 'a4'; // not laid out: fall back rather than guess

  const heightMm = box.height / pxPerMm + mTop + mBottom;
  return [A4_WIDTH_MM, Math.min(Math.ceil(heightMm), MAX_HEIGHT_MM)];
}

// A browser refuses to draw a canvas taller than about this and hands back a
// blank one instead, which would mean an empty PDF rather than a rough one.
const MAX_CANVAS_PX = 16_000;

/**
 * How finely to render. Twice actual size keeps the text crisp, but a long
 * report has to give some of that up to be drawn at all.
 *
 * @param {HTMLElement} page   the built report, laid out in the document
 * @param {number} preferred   the scale to use when there is room for it
 */
export function renderScale(page, preferred = 2) {
  const { height } = page.getBoundingClientRect();
  if (!(height > 0)) return preferred;
  return Math.max(1, Math.min(preferred, MAX_CANVAS_PX / height));
}
