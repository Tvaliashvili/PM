// =============================================================
// Phones and tablets
// - Tables become cards on a phone: each cell is labelled with its column's
//   heading (data-label), which the stylesheet shows beside the value.
// - The bottom bar's More opens the full menu.
// - The app can be installed on the home screen (sw.js, manifest.webmanifest).
// =============================================================

/** Gives every cell of a table the heading of its column, for the phone's card view. */
function labelTable(table) {
  const headRow = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!headRow) return;
  // Column index → heading, counting colspans.
  const heads = [];
  for (const th of headRow.cells) {
    const text = th.textContent.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < (th.colSpan || 1); i++) heads.push(text);
  }
  for (const section of [...table.tBodies, table.tFoot].filter(Boolean)) {
    for (const row of section.rows) {
      let col = 0;
      for (const cell of row.cells) {
        const label = cell.colSpan > 1 ? '' : heads[col] ?? '';
        if (cell.dataset.label !== label) cell.dataset.label = label;
        col += cell.colSpan || 1;
      }
    }
  }
}

let pending = false;
function labelAll() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    document.querySelectorAll('table.data-table').forEach(labelTable);
  });
}

export function initMobile({ openMenu }) {
  labelAll();
  new MutationObserver(labelAll).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('[data-open-menu]').forEach((b) => b.addEventListener('click', openMenu));

  // Installable: the browser offers "Add to Home screen" once this is in place.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app works without it */ });
  }
}
