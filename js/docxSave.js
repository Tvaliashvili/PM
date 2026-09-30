// =============================================================
// Saving a built report as a Word document, to finish by hand.
//
// A PDF is a picture of the page cut into sheets at fixed heights, so where a
// page breaks is settled before anyone sees it. Word lays text out itself: a
// table breaks between its rows, and a page break can be moved, added or taken
// out before the document is printed. So the report is read as it is laid out
// and rebuilt from Word's own parts:
//   tables          → Word tables; header rows repeat on each page, and a row
//                     never splits across two
//   headings, text  → paragraphs, with the weight, size and colour they had
//   anything drawn with CSS - charts, the timeline, tiles, cards, bars - has no
//   Word equivalent, so it goes in as a picture of itself: a line of it at a
//   time where it has lines, so no picture is taller than a page and a page
//   can break between them
// =============================================================
import { pageReady, settleCapitals } from './pdfSave.js';

// Loaded on the first Word export, not with the app: the library is large and
// most visits never use it.
const DOCX_SRC = 'https://cdn.jsdelivr.net/npm/docx@9.8.1/dist/index.iife.min.js';
const HTML2CANVAS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';

// A4 with the PDF's margins (10, 10, 12, 10 mm). The report page is 718 CSS px
// wide, which is the 190 mm between those margins - so a CSS pixel is 15 twips
// (0.75 pt), and every width and size carries straight across.
const TWIPS = 15;
const PAGE = { width: 11906, height: 16838 };
const MARGIN = { top: 567, right: 567, bottom: 680, left: 567 };
// On every Windows machine, and it has all of the Georgian letters.
const FONT = 'Segoe UI';

// Drawn with CSS: no Word part says what these say, so each goes in as a
// picture of itself. Where a thing is made of lines - the timeline, the bar
// lists, the rooms - each line is its own picture, so a page can break between
// them as it does in the PDF.
const PICTURE = [
  '.pdf-header', '.pdf-facts', '[data-signature]', '.doc-signature', 'img', 'svg', 'canvas',
  '.rpt-header', '.rpt-glance', '.rpt-tiles', '.rpt-legend', '.rpt-g-row', '.rpt-hbar',
  '.rpt-chart', '.rpt-activity', '.rpt-card', '.rpt-segbar', '.rpt-room-floor', '.rpt-type-chips',
].join(',');
const HEADING = 'h1, h2, h3, .rpt-h, .rpt-sub-h';

// Pictures are cut from renders of the page this tall at most. A browser hands
// back a blank canvas past about 16 000 px, and at twice actual size that is
// 8 000 px of report.
const BAND_PX = 7000;
const SHOT_SCALE = 2;
const MAX_CANVAS_PX = 14_000;

// How far past its own box a picture reaches for what spills out of it: the
// tail of a signature, a label's descenders. Beyond this it is someone else's.
const SPILL_PX = 48;
// Letters can run a few pixels below their box - more where the line height
// is tight. The PDF never shows this, because the page is drawn whole and they
// land in the space below. A picture cut at its own box loses the bottom of its
// last line, so each one reaches down into the free space under it, as far as
// this and never into what comes next.
const BLEED_PX = 10;

// A line of a few words laid out side by side - a date and its weather, a
// swatch and its label - is one paragraph, not a table of cells.
const ONE_LINE_PX = 48;
// A badge, swatch or icon leading a line: no wider than this.
const MARKER_PX = 40;

/**
 * @param {HTMLElement} page   the built report, laid out in the document
 * @param {string} filename    including the .docx
 * @param {string} title       stored as the document's title
 */
export async function saveDocx(page, filename, { title = '' } = {}) {
  await pageReady(page);
  settleCapitals(page);
  await Promise.all([load(DOCX_SRC), window.html2canvas ? null : load(HTML2CANVAS_SRC)]);
  const D = window.docx;

  const pageWidth = page.getBoundingClientRect().width;
  const ctx = { D, shots: await shoot(page), maxWidth: pageWidth, inCell: false };
  const children = await flow(page, ctx);

  const doc = new D.Document({
    title,
    creator: 'CPMG PM',
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 18 },
          paragraph: { spacing: { before: 0, after: 0 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE.width, height: PAGE.height, orientation: D.PageOrientation.PORTRAIT },
          margin: MARGIN,
        },
      },
      children: children.length ? children : [new D.Paragraph({})],
    }],
  });
  download(await D.Packer.toBlob(doc), filename);
}

// ---------- Loading ----------
const loading = new Map();
function load(src) {
  if (!loading.has(src)) {
    loading.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => {
        loading.delete(src); // let the next click try again
        reject(new Error('Could not load the Word exporter - check the connection and try again.'));
      };
      document.head.appendChild(script);
    }));
  }
  return loading.get(src);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- Reading the page ----------
const css = (el) => getComputedStyle(el);
const px = (v) => parseFloat(v) || 0;
// A margin as Word paragraph spacing, in twips: capped, since Word adds its own
// line spacing on top, and never below nothing.
const space = (v) => Math.round(Math.min(Math.max(px(v), 0), 12) * TWIPS);
const INLINE = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid']);
const isInline = (el) => el.tagName === 'BR' || INLINE.has(css(el).display);
const isFlexy = (el) => /flex|grid/.test(css(el).display);

function isShown(el) {
  const s = css(el);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

const shownChildren = (el) => [...el.children].filter((c) => c.tagName === 'BR' || isShown(c));

/** Text and nothing else all the way down: no picture, table or heading in it. */
const textOnly = (el) => !el.matches(PICTURE) && el.tagName !== 'TABLE' && !el.matches(HEADING)
  && !el.querySelector(`${PICTURE}, table, ${HEADING}`);

/**
 * A flex or grid item set on the same line as the item before it. The browser
 * calls these blocks, but they read as the next words on the line.
 */
function onSameLine(el) {
  const parent = el.parentElement;
  if (!parent || !isFlexy(parent)) return false;
  let prev = el.previousElementSibling;
  while (prev && !isShown(prev)) prev = prev.previousElementSibling;
  if (!prev) return /flex/.test(css(parent).display) && /row/.test(css(parent).flexDirection);
  return Math.abs(prev.getBoundingClientRect().top - el.getBoundingClientRect().top) < 4;
}

/** Two or more of these share a line on the page. */
function sideBySide(kids) {
  const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top));
  return tops.some((t, i) => tops.some((u, j) => i !== j && Math.abs(t - u) < 4));
}

/** "rgb(…)" or "rgba(…)" as Word's "RRGGBB", laid over white; null when see-through. */
function hex(color) {
  const m = /rgba?\(([^)]+)\)/.exec(color || '');
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (!(a > 0)) return null;
  const over = (c) => Math.round(c * a + 255 * (1 - a));
  return [r, g, b].map((c) => over(c).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function alignOf(el, D) {
  return {
    center: D.AlignmentType.CENTER,
    right: D.AlignmentType.RIGHT,
    end: D.AlignmentType.RIGHT,
    justify: D.AlignmentType.JUSTIFIED,
  }[css(el).textAlign] ?? D.AlignmentType.LEFT;
}

function border(width, style, color, D) {
  if (!(px(width) > 0) || style === 'none' || style === 'hidden') {
    return { style: D.BorderStyle.NONE, size: 0, color: 'auto' };
  }
  return {
    style: style === 'dashed' ? D.BorderStyle.DASHED : style === 'dotted' ? D.BorderStyle.DOTTED : D.BorderStyle.SINGLE,
    size: Math.max(2, Math.round(px(width) * 6)), // eighths of a point
    color: hex(color) ?? 'auto',
  };
}

const bordersOf = (el, D) => {
  const s = css(el);
  return {
    top: border(s.borderTopWidth, s.borderTopStyle, s.borderTopColor, D),
    bottom: border(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor, D),
    left: border(s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor, D),
    right: border(s.borderRightWidth, s.borderRightStyle, s.borderRightColor, D),
  };
};

const NO_BORDERS = (D) => {
  const none = { style: D.BorderStyle.NONE, size: 0, color: 'auto' };
  return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
};

const fillOf = (el, D) => {
  const fill = hex(css(el).backgroundColor);
  return fill ? { type: D.ShadingType.CLEAR, color: 'auto', fill } : undefined;
};

// ---------- Pictures ----------
/**
 * Every picture the document will hold, cut from renders of the page. The page
 * is drawn a band at a time rather than once per picture: each render copies
 * the whole app, and a timeline alone can be forty pictures.
 */
async function shoot(page) {
  const shots = new Map();
  const base = page.getBoundingClientRect();
  const items = [...page.querySelectorAll(PICTURE)]
    .filter((el) => !el.parentElement.closest(PICTURE) && isShown(el))
    .map((el) => ({ el, ...reach(el, base) }))
    .sort((a, b) => a.top - b.top);
  for (const it of items) {
    const bottom = it.top + it.height;
    const room = Math.max(0, Math.min(BLEED_PX, nextTop(it.el, page, base, bottom) - bottom));
    it.height += room;
    it.bleed = room;
  }

  // Text that goes into Word as text is drawn by Word. Drawn into the renders
  // as well, the bottom of a line set just above a picture - html2canvas puts
  // it a few pixels low - turns up again along the picture's top edge.
  hideLooseText();
  page.classList.add('docx-shooting');
  for (const it of items) it.el.classList.add('docx-shot');
  try {
    await drawAll(page, items, shots);
  } finally {
    page.classList.remove('docx-shooting');
    for (const it of items) it.el.classList.remove('docx-shot');
  }
  return shots;
}

/** Renders the page a band at a time and cuts every picture out of its band. */
async function drawAll(page, items, shots) {
  for (let i = 0; i < items.length;) {
    const top = Math.floor(items[i].top);
    let bottom = Math.ceil(items[i].top + items[i].height);
    let j = i + 1;
    while (j < items.length && Math.ceil(items[j].top + items[j].height) - top <= BAND_PX) {
      bottom = Math.max(bottom, Math.ceil(items[j].top + items[j].height));
      j += 1;
    }
    const height = bottom - top;
    const scale = Math.min(SHOT_SCALE, MAX_CANVAS_PX / height);
    const band = await drawBand(page, top, height, scale);
    for (const it of items.slice(i, j)) shots.set(it.el, await cut(band, it, top, scale));
    i = j;
  }
}

/**
 * While the pictures are taken, the text of everything that is not one - and
 * holds none - is made see-through. Its boxes, fills and lines stay: the frame
 * of the timeline is drawn by its container, round the rows that are pictures.
 */
function hideLooseText() {
  if (document.getElementById('docx-shooting-style')) return;
  const style = document.createElement('style');
  style.id = 'docx-shooting-style';
  style.textContent = '.docx-shooting :not(.docx-shot):not(.docx-shot *):not(:has(.docx-shot))'
    + ' { color: transparent !important; text-decoration-color: transparent !important; }';
  document.head.appendChild(style);
}

/**
 * Where a picture is, relative to the page: its box, stretched to take in
 * anything that spills out of it - an image hung below its line, text whose
 * letters run past a tight line height. Cut at the box alone, those came out
 * with their bottoms missing. Text is measured by its glyphs, which an
 * element's box does not cover.
 */
function reach(el, base) {
  const own = el.getBoundingClientRect();
  let { left, top, right, bottom } = own;
  const take = (r) => {
    if (!r.width || !r.height) return;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  };
  for (const d of el.querySelectorAll('*')) take(d.getBoundingClientRect());
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    range.selectNodeContents(n);
    take(range.getBoundingClientRect());
  }
  left = Math.max(left, own.left - SPILL_PX, base.left);
  right = Math.min(right, own.right + SPILL_PX, base.right);
  top = Math.max(top, own.top - SPILL_PX);
  bottom = Math.min(bottom, own.bottom + SPILL_PX);
  return {
    left: Math.floor(left - base.left),
    top: Math.floor(top - base.top),
    width: Math.ceil(right - left),
    height: Math.ceil(bottom - top),
  };
}

/**
 * Where the next thing under a picture starts, relative to the page: the first
 * element after it on the page that sits below its bottom and across the same
 * stretch of the page. Something beside it - the next card in a row - is not
 * under it, and is passed over.
 */
function nextTop(el, page, base, bottom) {
  const own = el.getBoundingClientRect();
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = el;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (el.contains(n)) continue;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.top - base.top < bottom - 1) continue;
    if (r.right <= own.left || r.left >= own.right) continue;
    return r.top - base.top;
  }
  return bottom + BLEED_PX; // nothing below it on the page
}

/**
 * Draws one band of the page: the page is clipped in a frame the band's height
 * and slid up to it. html2canvas has crop options of its own, but on a page
 * parked off-screen they crop the wrong place and hand back white.
 */
async function drawBand(page, top, height, scale) {
  const frame = document.createElement('div');
  frame.style.cssText = `position:relative;overflow:hidden;width:${page.offsetWidth}px;height:${height}px`;
  const { marginTop } = page.style;
  page.before(frame);
  frame.appendChild(page);
  page.style.marginTop = `${-top}px`;
  try {
    return await window.html2canvas(frame, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false });
  } finally {
    page.style.marginTop = marginTop;
    frame.replaceWith(page);
  }
}

/** One picture out of a band: photos as JPEG, everything with text in it as PNG. */
function cut(band, it, bandTop, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(it.width * scale));
  canvas.height = Math.max(1, Math.round(it.height * scale));
  canvas.getContext('2d').drawImage(
    band,
    Math.round(it.left * scale), Math.round((it.top - bandTop) * scale), canvas.width, canvas.height,
    0, 0, canvas.width, canvas.height,
  );
  const photo = it.el.tagName === 'IMG';
  return new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
    if (!blob) return reject(new Error('Could not draw part of the report for Word.'));
    resolve({ data: await blob.arrayBuffer(), type: photo ? 'jpg' : 'png', width: it.width, height: it.height, bleed: it.bleed });
  }, photo ? 'image/jpeg' : 'image/png', 0.9));
}

function picture(el, ctx) {
  const { D } = ctx;
  const shot = ctx.shots.get(el);
  if (!shot) return new D.Paragraph({});
  let { width, height } = shot;
  if (width > ctx.maxWidth) {
    height *= ctx.maxWidth / width;
    width = ctx.maxWidth;
  }
  return new D.Paragraph({
    children: [new D.ImageRun({
      type: shot.type,
      data: shot.data,
      transformation: { width: Math.round(width), height: Math.round(height) },
    })],
    alignment: el.parentElement ? alignOf(el.parentElement, D) : D.AlignmentType.LEFT,
    spacing: { after: ctx.inCell ? 0 : space(px(css(el).marginBottom) - (shot.bleed || 0)) },
    keepLines: true,
  });
}

// ---------- Text ----------
// Georgian has no capitals to speak of; upper-casing it in JavaScript turns it
// into Mtavruli, which most fonts cannot draw. Only the rest is raised.
const upper = (text) => text.replace(/\P{Script=Georgian}+/gu, (t) => t.toUpperCase());

/**
 * The fill of a chip or badge the text sits in, if it sits in one: anything
 * with a background between the text and the paragraph's own element, whose
 * fill (like a table cell's) is Word's to draw, not the text's.
 */
function chipFill(el, root, D) {
  for (let e = el; e && e !== root && root?.contains(e); e = e.parentElement) {
    const fill = hex(css(e).backgroundColor);
    if (fill) return { type: D.ShadingType.CLEAR, color: 'auto', fill };
  }
  return undefined;
}

function textRun(text, el, root, D) {
  const s = css(el);
  return new D.TextRun({
    text: s.textTransform === 'uppercase' ? upper(text) : text,
    font: FONT,
    size: Math.max(2, Math.round(px(s.fontSize) * 1.5)), // half-points
    bold: parseInt(s.fontWeight, 10) >= 600,
    italics: s.fontStyle === 'italic',
    color: hex(s.color) ?? undefined,
    // .rpt-was draws its line itself, for html2canvas; here Word can do it.
    strike: Boolean(el.closest('.rpt-was')) || s.textDecorationLine.includes('line-through'),
    shading: chipFill(el, root, D),
  });
}

/**
 * The runs of some inline content, as the browser would set it: white space
 * collapsed except where the page keeps it, a line break at each <br> and at
 * the edges of anything that sits on a line of its own.
 */
function runsOf(nodes, D, root) {
  const out = [];
  let last = '\n'; // how the text so far ends; a line start swallows a space
  const brk = () => {
    if (last !== '\n' && out.length) {
      out.push(new D.TextRun({ break: 1 }));
      out.at(-1).isBreak = true;
    }
    last = '\n';
  };
  const text = (value, el) => {
    if (!value) return;
    out.push(textRun(value, el, root, D));
    last = value.at(-1);
  };
  // A gap the page makes with a margin - between the Georgian and the English
  // beside it, or between the pieces of a line laid out with flex - is a space.
  const gap = (el) => {
    if (last !== '\n' && last !== ' ') text(' ', el);
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const el = node.parentElement;
      const ws = css(el).whiteSpace;
      if (ws.startsWith('pre') || ws === 'break-spaces') {
        node.textContent.split('\n').forEach((line, i) => {
          if (i) brk();
          text(ws === 'pre-line' ? line.replace(/[ \t]+/g, ' ') : line, el);
        });
        return;
      }
      let value = node.textContent.replace(/\s+/g, ' ');
      if (last === '\n' || last === ' ') value = value.replace(/^ /, '');
      text(value, el);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') {
      out.push(new D.TextRun({ break: 1 }));
      out.at(-1).isBreak = true;
      last = '\n';
      return;
    }
    if (!isShown(node)) return;
    // A swatch: an empty coloured box beside a label. Kept as a coloured square.
    if (!node.textContent.trim()) {
      const fill = hex(css(node).backgroundColor);
      if (fill && !node.querySelector('img, svg, canvas')) {
        out.push(new D.TextRun({ text: '■ ', font: FONT, color: fill, size: 16 }));
        last = ' ';
      }
      return;
    }
    const block = !isInline(node) && !onSameLine(node);
    if (block) brk();
    else if (!isInline(node) || px(css(node).marginLeft) >= 2) gap(node);
    node.childNodes.forEach(walk);
    if (block) brk();
    else if (px(css(node).marginRight) >= 2) gap(node);
  };
  nodes.forEach(walk);
  while (out.length && out.at(-1).isBreak) out.pop(); // an empty last line
  return out;
}

/** One paragraph of inline content. `box` carries the element's own fill and borders. */
function paragraph(el, nodes, ctx, { box = false } = {}) {
  const { D } = ctx;
  const children = runsOf(nodes, D, el);
  if (!children.length) return null;
  const s = css(el);
  return new D.Paragraph({
    children,
    alignment: alignOf(el, D),
    spacing: ctx.inCell ? { before: 0, after: 0 } : {
      before: box ? space(s.marginTop) : 0,
      after: space(s.marginBottom),
    },
    shading: box ? fillOf(el, D) : undefined,
    border: box ? bordersOf(el, D) : undefined,
    indent: box && px(s.paddingLeft) ? { left: Math.round(px(s.paddingLeft) * TWIPS) } : undefined,
    keepLines: true,
  });
}

function heading(el, ctx) {
  const { D } = ctx;
  const s = css(el);
  const level = el.matches('h1') ? D.HeadingLevel.HEADING_1
    : el.matches('h3, .rpt-sub-h') ? D.HeadingLevel.HEADING_3
      : D.HeadingLevel.HEADING_2;

  let children;
  let tabStops;
  const note = el.matches('.rpt-h') ? el.querySelector('.rpt-h-note') : null;
  if (el.matches('.rpt-h')) {
    // A section heading, with its figure at the right-hand end of the line.
    children = runsOf([el.querySelector('h2')].filter(Boolean), D, el);
    if (note) {
      children.push(new D.TextRun({ children: [new D.Tab()] }), ...runsOf([note], D, el));
      tabStops = [{ type: D.TabStopType.RIGHT, position: Math.round(el.getBoundingClientRect().width * TWIPS) }];
    }
  } else {
    children = runsOf([...el.childNodes], D, el);
  }
  const bottom = border(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor, D);
  return new D.Paragraph({
    heading: level,
    children,
    tabStops,
    alignment: alignOf(el, D),
    // A heading goes with what it introduces, never alone at the foot of a page.
    keepNext: true,
    keepLines: true,
    spacing: {
      before: ctx.inCell ? 0 : level === D.HeadingLevel.HEADING_3 ? 160 : 280,
      after: space(Math.max(px(s.marginBottom), px(s.paddingBottom))),
    },
    border: bottom.style === D.BorderStyle.NONE ? undefined : { bottom: { ...bottom, space: 4 } },
  });
}

/** A badge, swatch or icon at the head of a line. */
const isMarker = (el) => el.getBoundingClientRect().width <= MARKER_PX;

/**
 * Side-by-side items that are a few words each: one line of text. A badge
 * leading the line hangs in the margin, so that everything after it - the
 * English under the Georgian included - lines up past it, as on the page.
 */
function joined(el, kids, ctx) {
  const { D } = ctx;
  const children = [];
  // Two items pushed to either end of the line: the second sits at a right tab.
  const ends = kids.length === 2 && css(el).justifyContent === 'space-between';
  const hang = kids.length === 2 && isMarker(kids[0])
    ? Math.round((kids[1].getBoundingClientRect().left - el.getBoundingClientRect().left) * TWIPS)
    : 0;
  kids.forEach((k, i) => {
    if (i) {
      children.push(ends || hang ? new D.TextRun({ children: [new D.Tab()] }) : new D.TextRun({ text: ' ', font: FONT }));
    }
    children.push(...runsOf([k], D, el));
  });
  const s = css(el);
  return new D.Paragraph({
    children,
    alignment: alignOf(el, D),
    indent: hang ? { left: hang, hanging: hang } : undefined,
    tabStops: ends ? [{ type: D.TabStopType.RIGHT, position: Math.round(el.getBoundingClientRect().width * TWIPS) }] : undefined,
    spacing: ctx.inCell ? { before: 0, after: 0 } : { after: space(px(s.marginBottom) + px(s.paddingBottom)) },
    keepLines: true,
  });
}

// ---------- Structure ----------
/** An element's children, in order, as Word blocks. Loose text becomes paragraphs. */
async function flow(el, ctx) {
  const out = [];
  let group = [];
  const flush = () => {
    const p = group.length ? paragraph(el, group, ctx) : null;
    if (p) out.push(p);
    group = [];
  };
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim() || group.length) group.push(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node.tagName !== 'BR' && !isShown(node)) continue;
    if (isInline(node) && !node.matches(PICTURE)) {
      group.push(node);
      continue;
    }
    flush();
    out.push(...await convert(node, ctx));
  }
  flush();
  return out;
}

async function convert(el, ctx) {
  if (el.matches(PICTURE)) return [picture(el, ctx)];
  if (el.tagName === 'TABLE') return table(el, ctx);
  if (el.matches(HEADING)) return [heading(el, ctx)];

  const kids = shownChildren(el);
  if (isFlexy(el) && kids.length > 1 && sideBySide(kids)) {
    // A few words side by side, or a badge and the text it marks - however
    // many lines that text runs to - is one paragraph. In cells of their own
    // the badge lost its colour and the text its place beside it.
    const marked = kids.length === 2 && isMarker(kids[0]);
    if (kids.every(textOnly) && (marked || el.getBoundingClientRect().height <= ONE_LINE_PX)) {
      return [joined(el, kids, ctx)];
    }
    return layout(el, kids, ctx);
  }
  // Nothing but inline content: the element is the paragraph, box and all.
  if (!isFlexy(el) && kids.every((k) => isInline(k) && !k.matches(PICTURE))) {
    const p = paragraph(el, [...el.childNodes], ctx, { box: true });
    return p ? [p] : [];
  }
  return flow(el, ctx);
}

/**
 * A cell's content. A table cell's own fill and borders are the Word cell's,
 * so what is in it goes in without a box of its own. Word will not accept a
 * cell with nothing in it.
 */
async function cellContent(el, ctx) {
  const blocks = el.tagName === 'TD' || el.tagName === 'TH' ? await flow(el, ctx) : await convert(el, ctx);
  return blocks.length ? blocks : [new ctx.D.Paragraph({})];
}

/**
 * A table, cell for cell. Header rows repeat at the top of each page, and no
 * row is split between two - the same promise the PDF's page breaks keep.
 */
async function table(el, ctx) {
  const { D } = ctx;
  const rows = [...el.rows].filter(isShown);
  if (!rows.length) return [];
  const span = (tr) => [...tr.cells].reduce((n, c) => n + c.colSpan, 0);
  const cols = Math.max(...rows.map(span));
  const model = rows.find((tr) => tr.cells.length === cols);
  const box = el.getBoundingClientRect();
  const widths = (model ? [...model.cells].map((c) => c.getBoundingClientRect().width) : Array(cols).fill(box.width / cols))
    .map((w) => Math.round(w * TWIPS));

  const out = [];
  for (const tr of rows) {
    const cells = [];
    let col = 0;
    for (const td of tr.cells) {
      const width = widths.slice(col, col + td.colSpan).reduce((a, b) => a + b, 0);
      col += td.colSpan;
      const s = css(td);
      cells.push(new D.TableCell({
        children: await cellContent(td, { ...ctx, inCell: true, maxWidth: td.getBoundingClientRect().width - px(s.paddingLeft) - px(s.paddingRight) }),
        columnSpan: td.colSpan > 1 ? td.colSpan : undefined,
        width: { size: width, type: D.WidthType.DXA },
        shading: fillOf(td, D),
        verticalAlign: s.verticalAlign === 'top' ? D.VerticalAlign.TOP : s.verticalAlign === 'bottom' ? D.VerticalAlign.BOTTOM : D.VerticalAlign.CENTER,
        margins: {
          top: Math.round(px(s.paddingTop) * TWIPS),
          bottom: Math.round(px(s.paddingBottom) * TWIPS),
          left: Math.round(px(s.paddingLeft) * TWIPS),
          right: Math.round(px(s.paddingRight) * TWIPS),
        },
        borders: bordersOf(td, D),
      }));
    }
    out.push(new D.TableRow({ children: cells, tableHeader: tr.parentElement.tagName === 'THEAD', cantSplit: true }));
  }
  // Laid out like the browser's automatic tables: the widths it chose, except
  // that a column widens to fit its longest word rather than break it. Bold
  // Georgian is a shade wider in Word's font than on the page, and a word that
  // only just fitted would otherwise be split across two lines.
  const fixed = css(el).tableLayout === 'fixed';
  const blocks = [new D.Table({
    rows: out,
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: D.WidthType.DXA },
    layout: fixed ? D.TableLayoutType.FIXED : D.TableLayoutType.AUTOFIT,
    borders: NO_BORDERS(D),
  })];
  // Word runs the next paragraph straight into a table's bottom edge.
  if (!ctx.inCell) blocks.push(new D.Paragraph({ spacing: { after: space(css(el).marginBottom) } }));
  return blocks;
}

/**
 * Things laid out side by side - two panels, a grid of cards - as a table with
 * no lines, one cell each, so they keep their places across the page.
 */
async function layout(el, kids, ctx) {
  const { D } = ctx;
  const rows = [];
  for (const k of kids) {
    const top = Math.round(k.getBoundingClientRect().top);
    const row = rows.find((r) => Math.abs(r.top - top) < 4);
    if (row) row.kids.push(k);
    else rows.push({ top, kids: [k] });
  }
  for (const r of rows) r.kids.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const cols = Math.max(...rows.map((r) => r.kids.length));

  // Each column runs from its item's left edge to the next one's, so the gap
  // between items stays, as the cell's right-hand margin.
  const box = el.getBoundingClientRect();
  const lead = rows.find((r) => r.kids.length === cols).kids.map((k) => k.getBoundingClientRect());
  const edges = lead.map((r, i) => (i ? r.left - box.left : 0));
  const widthsPx = edges.map((x, i) => (i + 1 < edges.length ? edges[i + 1] : box.width) - x);
  const gaps = lead.map((r, i) => (i + 1 < lead.length ? lead[i + 1].left - r.right : 0));
  const widths = widthsPx.map((w) => Math.round(w * TWIPS));
  const none = NO_BORDERS(D);
  const cellBorders = { top: none.top, bottom: none.bottom, left: none.left, right: none.right };
  const rowGap = px(css(el).rowGap);

  const out = [];
  for (const r of rows) {
    const cells = [];
    for (let i = 0; i < cols; i += 1) {
      const k = r.kids[i];
      cells.push(new D.TableCell({
        children: k
          ? await cellContent(k, { ...ctx, inCell: true, maxWidth: Math.min(k.getBoundingClientRect().width, widthsPx[i] - gaps[i]) })
          : [new D.Paragraph({})],
        width: { size: widths[i], type: D.WidthType.DXA },
        verticalAlign: D.VerticalAlign.TOP,
        margins: { top: 0, left: 0, right: Math.round(gaps[i] * TWIPS), bottom: Math.round(rowGap * TWIPS) },
        borders: cellBorders,
      }));
    }
    out.push(new D.TableRow({ children: cells, cantSplit: true }));
  }
  const blocks = [new D.Table({
    rows: out,
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: D.WidthType.DXA },
    layout: D.TableLayoutType.FIXED,
    borders: none,
  })];
  if (!ctx.inCell) blocks.push(new D.Paragraph({ spacing: { after: space(css(el).marginBottom) } }));
  return blocks;
}
