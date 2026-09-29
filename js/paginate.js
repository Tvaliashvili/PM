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

// The one thing that must never happen is a line of text cut through the
// middle, because half a line of Georgian reads as different letters. So this
// list is small units of writing - a row, a heading, a paragraph, a tile - and
// nothing larger. A table or a timetable longer than a page has to break
// somewhere; protecting its rows is what keeps the break between the lines
// rather than through them.
const KEEP_WHOLE = [
  'tr', 'p', 'li',
  'h1', 'h2', 'h3', '.rpt-h', '.rpt-sub-h',
  '.rpt-tile', '.rpt-hbar', '.rpt-g-row', '.rpt-card', '.rpt-legend-item',
  '.pdf-facts > div', '.doc-signature',
].join(',');

// Anything taller than this is a block, not a line of writing. Moving one
// wholesale buys a tidy edge at the price of half a blank page, so it is left
// to break and its rows are kept whole instead.
const KEEP_WHOLE_LIMIT = 0.3;

// A heading is no use at the foot of a page with its table overleaf, so it
// travels with roughly the first two rows of whatever it introduces.
const KEEP_WITH_NEXT = 'h1,h2,h3,.rpt-h,.rpt-sub-h';
const LEAD_PX = 110;

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

  /** Pushes `el` to the top of the next page if `needs` px will not fit.
   *  Returns true when it moved something. */
  const push = (el, needs) => {
    const top = topOf(el);
    if (needs <= 0 || needs > pageHeight) return false; // too tall either way
    const startsOn = Math.floor(top / pageHeight);
    // A hair over the edge is a rounding artefact, not a second page.
    const endsOn = Math.floor((top + needs - 1) / pageHeight);
    if (startsOn === endsOn) return false;

    const target = movable(el);
    const parent = target.parentNode;
    if (!parent || parent.nodeType !== 1) return false;

    // The whole row is taller than a page, so moving it solves nothing. Push
    // the one item instead: a margin still shifts it inside its own track.
    if (target !== el && target.getBoundingClientRect().height > pageHeight) {
      const gap = (startsOn + 1) * pageHeight - top;
      if (gap <= 0) return false;
      el.style.marginTop = `${parseFloat(el.style.marginTop || 0) + gap}px`;
      return true;
    }

    const gap = (startsOn + 1) * pageHeight - topOf(target);
    if (gap <= 0) return false;
    parent.insertBefore(spacerOf(gap, target), target);
    return true;
  };

  // How much of the page this element needs: its own height, and for a heading
  // the start of whatever it introduces, so the two cannot be parted.
  const limit = pageHeight * KEEP_WHOLE_LIMIT;
  const needsOf = (el) => {
    const { height } = el.getBoundingClientRect();
    if (!el.matches(KEEP_WITH_NEXT)) {
      return height > limit ? 0 : height; // a block, not a line: let it break
    }
    // Walk on until the heading has real content under it, not just the legend
    // or the one-line note that so often sits between a heading and its table.
    let lead = 0;
    for (let next = el.nextElementSibling; next && lead < LEAD_PX; next = next.nextElementSibling) {
      lead += next.getBoundingClientRect().height;
    }
    return height + Math.min(lead, LEAD_PX);
  };

  // One pass in document order, because moving an element only ever moves what
  // follows it. Then again, until nothing needs moving: a push can carry the
  // next heading's table off the page it was measured against. It settles in
  // two or three rounds, and the cap is there so a layout that cannot settle
  // gives up rather than hangs.
  const selector = `${KEEP_WHOLE},${KEEP_WITH_NEXT}`;
  for (let round = 0; round < 4; round += 1) {
    let moved = false;
    for (const el of page.querySelectorAll(selector)) {
      if (push(el, needsOf(el))) moved = true;
    }
    if (!moved) return;
  }
}
