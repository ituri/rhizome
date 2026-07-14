'use strict';
/* ============================================================================
   Rhizome — the page layer.

   Roam-style conventions on top of the tendril tree: direct children of the
   root are discrete pages, the calendar subtree stores the daily notes.
   Loaded after app.js/app2.js in the same global scope; the view renderers
   (daily notes, all pages, references) live here so the upstream files keep
   small, mergeable diffs.
   ========================================================================= */

/* ---------------- page conventions ---------------- */

const isCalRoot = id => N(id)?.cal === 'root';

// every direct child of the root except the calendar container is a page
function pagesOf() {
  return kidsOf(ROOT).filter(id => !isCalRoot(id));
}

function findPageByTitle(title) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  return pagesOf().find(id => plainOf(N(id).text).trim().toLowerCase() === want) || null;
}

// pages append at the top level; callers wrap in snapshot()
function createPage(title) {
  const id = makeNode(escHtml(title.trim()));
  insertAt(ROOT, kidsOf(ROOT).length, id);
  return id;
}

function getOrCreatePage(title) {
  return findPageByTitle(title) || createPage(title);
}
window.getOrCreatePage = getOrCreatePage;

// the page containing a node: the node itself when top-level, ROOT for ROOT
function pageOf(id) {
  const chain = ancestorsOf(id);
  if (!chain.length) return id;
  return chain.length > 1 ? chain[1] : id;
}

/* ---------------- Roam-style day labels ---------------- */

const ordinal = n => {
  const h = n % 100;
  const t = n % 10;
  return n + (h >= 11 && h <= 13 ? 'th' : t === 1 ? 'st' : t === 2 ? 'nd' : t === 3 ? 'rd' : 'th');
};

function roamDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${ordinal(d)}, ${y}`;
}
window.roamDateLabel = roamDateLabel;

// one-time relabel of day nodes created before the fork ("Mon, Jul 14")
const OLD_DAY_RE = new RegExp(`^(${DOW_SHORT.join('|')}), (${MONTHS_SHORT.join('|')}) \\d{1,2}$`);
function migrateDayLabels() {
  if (SHARE_TOKEN || state.readOnly || !doc) return;
  let changed = false;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (n.cal === 'day' && n.cd && OLD_DAY_RE.test(plainOf(n.text).trim())) {
      recOld(id);
      n.text = escHtml(roamDateLabel(n.cd));
      n.m = Date.now();
      changed = true;
    }
  }
  if (changed) { markDirty(); renderPage(); }
}

// init() (app2.js) is async and still awaiting the doc when this file runs
(function afterDocLoad() {
  if (doc) migrateDayLabels();
  else setTimeout(afterDocLoad, 100);
})();
