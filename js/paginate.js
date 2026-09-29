// =============================================================
// Page breaks for the generated PDFs.
//
// html2pdf renders the whole document to one tall image and then cuts it at
// fixed intervals. Its own "avoid" rules and the CSS break-inside properties
// are advisory at best, so a heading or a table row regularly lands half on one
// page and half on the next - and half a line of Georgian reads as a different
// word, not as a clipped one.
//
// So the cuts are placed here instead, before anything is rendered: the page is
// measured against the real page grid and a spacer pushes anything that would
// straddle a boundary onto the next page.
// =============================================================

const A4 = { width: 210, height: 297 }; // mm, portrait

// Never cut through the middle. `.rpt-avoid` is the report's own marker for
// this, so the list below only adds what it does not already cover.
const KEEP_WHOLE = [
  '.rpt-avoid', '.pdf-avoid-break',
  'h1', 'h2', 'h3', '.rpt-h', '.rpt-sub-h', '.rpt-legend',
  '.rpt-tile', '.rpt-panel', '.rpt-card', '.rpt-hbar', '.rpt-g-row', '.rpt-chart',
  '.pdf-facts', '.doc-signature',
  'tr', 'p',
].join(',');

// A heading alone at the foot of a page, with its table overleaf, reads as a
// mistake. It travels with this much of whatever follows it.
const KEEP_WITH_NEXT = 'h1,h2,h3,.rpt-h,.rpt-sub-h';
const LEAD_PX = 64;

/** A parent that lays out its own children, where a spacer would become a cell. */
const isTracked = (el) => {
  if (!el || el.nodeType !== 1) return true;
  const { display } = getComputedStyle(el);
  return display.includes('flex') || display.includes('grid');
};

/** A spacer between table rows has to be a row itself, or the table breaks. */
function spacerOf(height, before) {
  if (before.tagName !== 'TR') {
    const div = document.createElement('div');
    div.style.cssText = `height:${height}px`;
    return div;
  }
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = before.children.length || 1;
  td.style.cssText = `height:${height}px;padding:0;border:0;background:none`;
  tr.appendChild(td);
  return tr;
}

/**
 * What to move to push `el` down. A row in a table head takes the whole table
 * with it, because a spacer row inside <thead> pulls the header apart; an item
 * in a grid or flex row takes the row, since a spacer there becomes a cell.
 */
function movable(el) {
  if (el.tagName === 'TR' && el.closest('thead')) return el.closest('table') ?? el;
  let target = el;
  while (target.parentNode?.nodeType === 1 && target.parentNode !== document.body
    && isTracked(target.parentNode)) {
    target = target.parentNode;
  }
  return target;
}

/**
 * Inserts spacers into `page` so nothing is cut by a page break. Call it once
 * the page is laid out in the document and the fonts have loaded - it measures,
 * so nothing may move afterwards.
 *
 * @param {HTMLElement} page   the rendered report, already in the DOM
 * @param {number[]} marginMm  html2pdf's margin: [top, right, bottom, left]
 */
export function insertPageBreaks(page, marginMm) {
  const [mTop, mRight, mBottom, mLeft] = marginMm;
  const width = page.getBoundingClientRect().width;
  if (!width) return; // not laid out - leave it to html2pdf rather than guess

  // The page is drawn `width` px across and scaled to the printable width, so
  // one page of height is that scale applied to the mm between the margins.
  const pxPerMm = width / (A4.width - mLeft - mRight);
  const pageHeight = (A4.height - mTop - mBottom) * pxPerMm;
  if (!(pageHeight > 0)) return;

  const topOf = (el) => el.getBoundingClientRect().top - page.getBoundingClientRect().top;

  /** Pushes `el` to the top of the next page if `needs` px will not fit. */
  const push = (el, needs) => {
    const top = topOf(el);
    if (needs <= 0 || needs > pageHeight) return; // cannot help: too tall either way
    const startsOn = Math.floor(top / pageHeight);
    // A hair over the edge is a rounding artefact, not a second page.
    const endsOn = Math.floor((top + needs - 1) / pageHeight);
    if (startsOn === endsOn) return;

    const target = movable(el);
    const parent = target.parentNode;
    if (!parent || parent.nodeType !== 1) return;

    // The whole row is taller than a page, so moving it solves nothing. Push
    // the one item instead: a margin still shifts it inside its own track.
    if (target !== el && target.getBoundingClientRect().height > pageHeight) {
      const gap = (startsOn + 1) * pageHeight - top;
      if (gap > 0) el.style.marginTop = `${gap}px`;
      return;
    }

    const gap = (startsOn + 1) * pageHeight - topOf(target);
    if (gap > 0) parent.insertBefore(spacerOf(gap, target), target);
  };

  // Headings first, each carrying the start of whatever it introduces, so the
  // later keep-whole pass measures what the reader will actually see.
  for (const el of page.querySelectorAll(KEEP_WITH_NEXT)) {
    const next = el.nextElementSibling;
    const lead = next ? Math.min(next.getBoundingClientRect().height, LEAD_PX) : 0;
    push(el, el.getBoundingClientRect().height + lead);
  }

  for (const el of page.querySelectorAll(KEEP_WHOLE)) {
    push(el, el.getBoundingClientRect().height);
  }
}
