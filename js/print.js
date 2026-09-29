// =============================================================
// Printing a generated document.
//
// The browser's own print engine lays the pages out, so the CSS in the @media
// print block is what decides where the breaks fall - no measuring, no canvas,
// and the text stays text rather than becoming a picture of text.
//
// The report is moved into #print-root and the rest of the app is hidden for
// the duration, which is what makes the report the whole printed document.
// =============================================================

/**
 * Prints `page` on its own. Chrome and Edge name the saved file after the
 * document title, so `filename` is put there for the length of the dialog.
 * Resolves once the dialog has been dealt with.
 *
 * @param {HTMLElement} page      the built report (it is copied, not moved)
 * @param {string} filename       without the .pdf - the browser adds that
 */
export async function printDocument(page, filename) {
  const root = document.getElementById('print-root');
  root.replaceChildren(page.cloneNode(true));

  // Awaited with the report already in the page, so the Georgian glyphs it
  // uses are what the browser is being asked to finish loading.
  await document.fonts?.ready;

  // A photo still loading would print as a blank frame.
  await Promise.all([...root.querySelectorAll('img')].map((img) => (
    img.complete ? img.decode().catch(() => {}) : new Promise((done) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    })
  )));

  const title = document.title;
  document.title = filename;
  document.body.classList.add('is-printing');

  await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('afterprint', finish);
      document.body.classList.remove('is-printing');
      document.title = title;
      root.replaceChildren();
      done();
    };
    window.addEventListener('afterprint', finish);
    // Safari does not always fire afterprint, and print() returns once the
    // dialog closes there, so a late sweep clears up either way.
    setTimeout(finish, 60_000);
    window.print();
  });
}
