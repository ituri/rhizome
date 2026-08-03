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
  // a share view roots at the shared node — there IS no 'root', and no pages
  if (!doc || !doc.nodes[ROOT]) return [];
  return kidsOf(ROOT).filter(id => !isCalRoot(id));
}

// a page only COUNTS as created once it holds content (a bullet or a note) — typing
// [[Test]] materialises the target node (links need an id) but the page stays out of
// the sidebar/All Pages and its links render dimmed until someone actually writes in it
window.pageHasContent = function pageHasContent(id) {
  const cid = contentIdOf(id);
  return !!(kidsOf(cid).length || N(cid)?.note);
};

// alias (lowercased) -> pageId, gathered from each page's `Aliases:: a, b, c` child block
function pageAliasMap() {
  const map = new Map();
  for (const pid of pagesOf()) {
    for (const cid of kidsOf(contentIdOf(pid))) {
      const attr = window.parseAttribute(cid);
      if (!attr || attr.key.toLowerCase() !== 'aliases') continue;
      for (const raw of attr.value.split(',')) {
        const a = raw.replace(/^\[\[|\]\]$/g, '').trim().toLowerCase();
        if (a && !map.has(a)) map.set(a, pid);
      }
      break; // one Aliases block per page
    }
  }
  return map;
}
window.pageAliasMap = pageAliasMap;

function findPageByTitle(title) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  return pagesOf().find(id => plainOf(N(id).text).trim().toLowerCase() === want)
    || pageAliasMap().get(want) || null;
}

/* ---------------- Namespaces (Roam-style "Foo/Bar" page titles) ---------------- */
// A namespaced title "Foo/Bar" (or multi-level "A/B/C") is still ONE flat page — the slash is a
// naming convention. We surface it: the display shows only the leaf, with the prefix kept for
// dimming/hiding via CSS, and the top-level segment drives sidebar/All-Pages grouping.
function splitNamespace(title) {
  const s = (title || '').trim();
  const last = s.lastIndexOf('/');
  if (last <= 0 || last >= s.length - 1) return null;         // no slash, or leading/trailing slash
  return { prefix: s.slice(0, last + 1), leaf: s.slice(last + 1), top: s.slice(0, s.indexOf('/')).trim() };
}
window.splitNamespace = splitNamespace;

// set a page link's label with namespace-aware markup (prefix + leaf spans) so CSS can dim or hide
// the prefix; falls back to a plain title when there's no namespace.
function setPageLabel(a, title) {
  const ns = splitNamespace(title);
  if (!ns) { a.textContent = title; return; }
  a.classList.add('ns-ref');
  a.setAttribute('data-ns', ns.prefix);
  a.textContent = '';
  const pre = document.createElement('span'); pre.className = 'ns-prefix'; pre.textContent = ns.prefix;
  const leaf = document.createElement('span'); leaf.className = 'ns-leaf'; leaf.textContent = ns.leaf;
  a.append(pre, leaf);
}
window.setPageLabel = setPageLabel;

// pages append at the top level; callers wrap in snapshot()
function createPage(title) {
  const id = makeNode(escHtml(title.trim()));
  insertAt(ROOT, kidsOf(ROOT).length, id);
  return id;
}

// "July 14th, 2026" → "2026-07-14", else null
function parseRoamDate(title) {
  const m = title.trim().match(/^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th), (\d{4})$/);
  if (!m) return null;
  const mon = MONTHS_LONG.indexOf(m[1]) + 1;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

function getOrCreatePage(title) {
  const iso = parseRoamDate(title);          // a date resolves to its calendar day page,
  if (iso) return window.ensureDayId(iso);   // never a duplicate top-level page
  return findPageByTitle(title) || createPage(title);
}

// an anchor for a page reference: a plain link, or a tag pill when a #/@ sigil is given
window.makePageAnchor = function makePageAnchor(pageId, label, sigil) {
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + pageId);
  a.setAttribute('rel', 'noopener');
  if (sigil) {
    a.className = sigil === '@' ? 'tag mention' : 'tag';
    a.setAttribute('data-tag', sigil + label);
    a.textContent = sigil + label;
  } else {
    a.textContent = label;
  }
  return a;
};

// true when node `id` (a top-level page or a day page) now carries a title that
// already belongs to another page — used to block a colliding rename
window.pageTitleCollides = function pageTitleCollides(id) {
  const n = N(id);
  if (!n) return false;
  const isPage = kidsOf(ROOT).includes(id) || n.cal === 'day';
  if (!isPage) return false;
  const title = plainOf(n.text).trim().toLowerCase();
  if (!title) return false;
  const iso = parseRoamDate(title);
  if (iso) { const day = findDay(iso); return !!day && day !== id; } // a date belongs to its day page
  return pagesOf().some(p => p !== id && plainOf(N(p).text).trim().toLowerCase() === title);
};
window.getOrCreatePage = getOrCreatePage;

// the page containing a node: the node itself when top-level, ROOT for ROOT
function pageOf(id) {
  const chain = ancestorsOf(id);
  if (!chain.length) return id;
  return chain.length > 1 ? chain[1] : id;
}

// the page used for version history: a journal day (cal:'day') is its own page; otherwise the
// top-level page (child of root, not the calendar root). Mirrors the server's pageIdOf, so the
// history menu asks for the right key (pageOf would return the calendar root for a journal day).
function historyPageOf(id) {
  let cur = id;
  while (cur) {
    if (N(cur)?.cal === 'day') return cur;
    const p = parentOf(cur);
    if (!p) return null;
    if (p === ROOT) return N(cur)?.cal === 'root' ? null : cur;
    cur = p;
  }
  return null;
}
window.historyPageOf = historyPageOf;

/* ---------------- Location pages: coords → OSM mini-map + reverse-geocoded title -------------- */
// A location page carries a "lat, lon" coordinate (from the iOS geo button). We render an OSM
// mini-map for it and, the first time we see one whose TITLE is still raw coordinates, reverse-
// geocode it: move the coordinates into a first bullet and rename the page to the address.
const COORD_RE = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;

function parseCoords(s) {
  const m = (s || '').match(COORD_RE);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// the whole string is ONE bare coordinate pair (not just numbers somewhere inside it)
const BARE_COORD_RE = /^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/;
function bareCoords(s) {
  return BARE_COORD_RE.test((s || '').trim()) ? parseCoords(s) : null;
}

// a page's coordinates from its ATTRIBUTES only: any Location:: value that IS a bare
// coordinate pair (Location:: is polymorphic — text geocodes, coordinates are the cache),
// with legacy Coordinates:: still read (but no longer written)
function pageAttrCoords(id) {
  const attrs = window.attrsOf(id);
  for (const key of ['location', 'coordinates']) {
    const a = attrs.get(key);
    if (!a) continue;
    for (const v of a.values) {
      const c = key === 'coordinates' ? parseCoords(v.value) : bareCoords(v.value);
      if (c) return c;
    }
  }
  return null;
}

// a page's coordinate — attributes first, then the anchored legacy fallbacks
// (a first bullet / title that IS a bare coordinate pair, nothing looser)
function pageCoords(id) {
  if (!N(id)) return null;
  const ac = pageAttrCoords(id);
  if (ac) return ac;
  const first = kidsOf(id)[0];
  return (first && bareCoords(plainOf(N(first).text))) || bareCoords(plainOf(N(id).text));
}

let leafletLoading;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('leaflet failed to load'));
    document.head.appendChild(s);
  });
  return leafletLoading;
}

let geoMap = null;
const geocoding = new Set();

// Norwegian coordinates render on Kartverket's own topo tiles (what sotl.as uses there).
// Two boxes approximate mainland Norway so Kartverket's blank out-of-coverage tiles never
// show — outside them the caller keeps its default layer.
function inNorway(lat, lon) {
  return (lat >= 57.9 && lat < 65 && lon >= 4.5 && lon <= 14.5)
    || (lat >= 65 && lat <= 71.4 && lon >= 11 && lon <= 31.5);
}
function norwayTopoLayer(lat, lon) {
  if (!inNorway(lat, lon)) return null;
  return L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
    { maxZoom: 18, attribution: '© Kartverket' });
}

// render (or clear) the mini-map for the current page, and kick off geocoding when the title is
// still raw coordinates. Called from renderPage.
window.renderGeo = function renderGeo() {
  const el = document.getElementById('zoom-map');
  if (!el) return;
  const coords = state.zoom !== ROOT ? pageCoords(state.zoom) : null;
  const key = coords ? `${coords.lat},${coords.lon}` : '';
  if (el.dataset.coords !== key) {
    el.dataset.coords = key;
    if (geoMap) { geoMap.remove(); geoMap = null; }
    el.innerHTML = '';
    el.hidden = !coords;
    if (coords) {
      loadLeaflet().then(() => {
        if (el.dataset.coords !== key) return;   // navigated away while Leaflet loaded
        geoMap = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false })
          .setView([coords.lat, coords.lon], inNorway(coords.lat, coords.lon) ? 11 : 16);
        (norwayTopoLayer(coords.lat, coords.lon) || L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '© OpenStreetMap contributors',
        })).addTo(geoMap);
        L.circleMarker([coords.lat, coords.lon], {
          radius: 8, weight: 2, color: '#bf562f', fillColor: '#bf562f', fillOpacity: 0.85,
        }).addTo(geoMap);
        setTimeout(() => geoMap && geoMap.invalidateSize(), 60);
      }).catch(() => { el.hidden = true; });
    }
  }
  // auto-geocode a still-raw coordinate title — unless the page is flagged geo:"raw"
  // (the user tagged it coordinates-only, e.g. via the iOS location button's long-press)
  if (coords && N(state.zoom).geo !== 'raw' && parseCoords(plainOf(N(state.zoom).text)) && !geocoding.has(state.zoom)) {
    geocodeAndRetitle(state.zoom, coords);
  }
  // roam-atlas flow: a page whose Location:: is an address (text) and has no coordinates
  // yet is forward-geocoded once — a second "Location:: lat, lon" line then IS the cache
  if (!coords && state.zoom !== ROOT && !state.readOnly && !geocoding.has(state.zoom)) {
    const loc = window.attrsOf(state.zoom).get('location');
    const q = loc && loc.values.map(v => v.value).find(v => !bareCoords(v));
    if (q) forwardGeocodePage(state.zoom, q);
  }
};

// resolve a Location:: address to coordinates (server /api/geocode?q=…) and cache them in
// the graph as a second Location:: attribute line — one geocoder query per place, ever
async function forwardGeocodePage(pageId, q) {
  geocoding.add(pageId);
  try {
    const r = await fetch('/api/geocode?q=' + encodeURIComponent(q));
    const hit = r.ok ? (await r.json()).result : null;
    if (!hit || !N(pageId) || pageAttrCoords(pageId)) return;
    snapshot();
    insertAt(pageId, kidsOf(pageId).length, makeNode(escHtml(`Location:: ${hit.lat}, ${hit.lon}`)));
    markDirty();
    renderPage();
  } finally {
    geocoding.delete(pageId);
  }
}

async function geocodeAndRetitle(pageId, coords) {
  if (state.readOnly || N(pageId)?.geo === 'raw') return;   // coordinates-only page → never retitle
  geocoding.add(pageId);
  try {
    const r = await fetch(`/api/geocode?lat=${coords.lat}&lon=${coords.lon}`);
    const address = r.ok ? (await r.json()).address : '';
    // bail if the page vanished or its title changed meanwhile (e.g. a concurrent edit)
    if (!address || !N(pageId) || !parseCoords(plainOf(N(pageId).text))) return;
    // a second geo capture at the same place gets a fresh coordinate title (GPS jitter),
    // so find-or-create can't match it — and both geocode to the same address. Renaming
    // would silently duplicate the title; fold into the existing page instead.
    const existing = findPageByTitle(address);
    if (existing && existing !== pageId) { mergeLocationPage(pageId, existing, address); return; }
    snapshot();
    // keep the raw coords in the page — as a Location:: attribute (the ONE geo attribute;
    // legacy bare-coords first bullets and Coordinates:: stay readable but aren't written)
    const first = kidsOf(pageId)[0];
    if (!pageAttrCoords(pageId) && !(first && bareCoords(plainOf(N(first).text)))) {
      insertAt(pageId, 0, makeNode(escHtml(`Location:: ${coords.lat}, ${coords.lon}`)));
    }
    recOld(pageId);
    N(pageId).text = escHtml(address);
    N(pageId).m = Date.now();
    // re-label existing links whose text is still the raw coordinates → the address, so the
    // journal (and any other reference) shows the place name instead of "52.52, 13.40"
    const needle = `#/n/${pageId}"`;
    for (const k of Object.keys(doc.nodes)) {
      const t = doc.nodes[k].text;
      if (!t || !t.includes(needle)) continue;
      const relabeled = relabelCoordLinks(t, pageId, address);
      if (relabeled !== t) { recOld(k); doc.nodes[k].text = relabeled; N(k).m = Date.now(); }
    }
    markDirty();
    renderPage();
  } catch { /* offline / geocoder down — leave the raw-coords title as-is, retry next visit */ }
  finally { geocoding.delete(pageId); }
}

// fold a freshly geocoded coordinate page into the page that already carries the address:
// move its bullets over, re-point (and relabel) every link, then trash the empty duplicate.
// The fresh GPS fix is dropped — the target page keeps its own coords bullet.
function mergeLocationPage(pageId, target, address) {
  snapshot();
  for (const kid of [...kidsOf(pageId)]) moveNode(kid, target, kidsOf(target).length);
  const needle = `#/n/${pageId}"`;
  for (const k of Object.keys(doc.nodes)) {
    const t = doc.nodes[k].text;
    if (!t || !t.includes(needle)) continue;
    recOld(k);
    doc.nodes[k].text = relabelCoordLinks(t.replaceAll(needle, `#/n/${target}"`), target, address);
    N(k).m = Date.now();
  }
  markDirty();
  if (state.zoom === pageId) location.hash = '#/n/' + target;
  opDelete(pageId, { toast: false });
  showToast(`Merged into the existing “${address}” page`);
}

// the coordinate of the first location page a text links to, else null
function firstLinkedCoords(html) {
  if (!html.includes('#/n/')) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const a of tpl.content.querySelectorAll('a[href^="#/n/"]')) {
    const c = pageCoords(a.getAttribute('href').slice(4));
    if (c) return c;
  }
  return null;
}

// a small, non-interactive map under any bullet that links to a location page — so a place
// referenced in the journal (or anywhere) shows its map inline, without opening the page.
// The map element is cached per node so re-renders (indent/outdent, edits) REUSE it instead of
// rebuilding Leaflet, which would make the tiles flash.
const geoMiniCache = new Map(); // nodeId → { el, map, key }
window.buildGeoMini = function buildGeoMini(n) {
  const coords = firstLinkedCoords(n.text || '');
  const cached = geoMiniCache.get(n.id);
  if (!coords) {
    if (cached) { try { cached.map?.remove(); } catch { /* noop */ } geoMiniCache.delete(n.id); }
    return null;
  }
  const key = `${coords.lat},${coords.lon}`;
  if (cached && cached.key === key) {
    if (cached.map) requestAnimationFrame(() => cached.map.invalidateSize()); // fix size after re-attach
    return cached.el; // reuse the live map element — no flash
  }
  if (cached) { try { cached.map?.remove(); } catch { /* noop */ } }
  const el = document.createElement('div');
  el.className = 'geo-mini';
  const entry = { el, map: null, key };
  geoMiniCache.set(n.id, entry);
  loadLeaflet().then(() => {
    if (!el.isConnected) return;
    entry.map = L.map(el, {
      zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, touchZoom: false,
    }).setView([coords.lat, coords.lon], inNorway(coords.lat, coords.lon) ? 11 : 15);
    (norwayTopoLayer(coords.lat, coords.lon)
      || L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })).addTo(entry.map);
    L.circleMarker([coords.lat, coords.lon], { radius: 6, weight: 2, color: '#bf562f', fillColor: '#bf562f', fillOpacity: 0.85 }).addTo(entry.map);
    setTimeout(() => entry.map.invalidateSize(), 60);
  }).catch(() => { el.remove(); geoMiniCache.delete(n.id); });
  return el;
};

/* ---------------- SOTA summit references ---------------- */
// a typed reference like LA/FM-178 autolinks to sotl.as (resolveEditSource) and gets the
// same inline mini map as geocoordinates. Coordinates come from the SOTA API
// (api2.sota.org.uk, CORS *) and are cached persistently — one fetch per summit, ever.
const SOTA_HREF_RE = /https:\/\/sotl\.as\/summits\/([A-Z0-9]{1,3}\/[A-Z]{2}-\d{3})/;
let sotaCoords = {};
try { sotaCoords = JSON.parse(localStorage.getItem('sota-coords') || '{}'); } catch { /* fresh */ }
const sotaPending = new Map();
function sotaLookup(ref) {
  if (sotaCoords[ref]) return Promise.resolve(sotaCoords[ref]);
  if (sotaPending.has(ref)) return sotaPending.get(ref);
  const p = fetch('https://api2.sota.org.uk/api/summits/' + ref)
    .then(r => { if (!r.ok) throw new Error('sota ' + r.status); return r.json(); })
    .then(j => {
      const c = { lat: j.latitude, lon: j.longitude };
      sotaCoords[ref] = c;
      try { localStorage.setItem('sota-coords', JSON.stringify(sotaCoords)); } catch { /* full */ }
      return c;
    })
    .finally(() => sotaPending.delete(ref));
  sotaPending.set(ref, p);
  return p;
}
const sotaMiniCache = new Map(); // nodeId → { el, map, key }
window.buildSotaMini = function buildSotaMini(n) {
  const ref = (SOTA_HREF_RE.exec(n.text || '') || [])[1];
  const cached = sotaMiniCache.get(n.id);
  if (!ref) {
    if (cached) { try { cached.map?.remove(); } catch { /* noop */ } sotaMiniCache.delete(n.id); }
    return null;
  }
  if (cached && cached.key === ref) {
    if (cached.map) requestAnimationFrame(() => cached.map.invalidateSize());
    return cached.el; // reuse the live map element — no flash
  }
  if (cached) { try { cached.map?.remove(); } catch { /* noop */ } }
  const el = document.createElement('div');
  el.className = 'geo-mini sota-mini';
  const entry = { el, map: null, key: ref };
  sotaMiniCache.set(n.id, entry);
  Promise.all([loadLeaflet(), sotaLookup(ref)]).then(([, c]) => {
    if (!el.isConnected || sotaMiniCache.get(n.id) !== entry) return;
    entry.map = L.map(el, {
      zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, touchZoom: false,
    }).setView([c.lat, c.lon], 11);   // wide terrain context, like the sotl.as summit view
    // topo styles like sotl.as uses: Norwegian coordinates get Kartverket (see
    // norwayTopoLayer), everywhere else OpenTopoMap is the closest keyless topo look
    (norwayTopoLayer(c.lat, c.lon)
      || L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 })).addTo(entry.map);
    // a summit gets a peak triangle instead of the location dot
    L.marker([c.lat, c.lon], { interactive: false, icon: L.divIcon({
      className: 'sota-peak',
      html: '<svg viewBox="0 0 24 22" width="22" height="20"><path d="M12 2 L23 20 H1 Z" fill="#bf562f" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>',
      iconSize: [22, 20], iconAnchor: [11, 10],
    }) }).addTo(entry.map);
    setTimeout(() => entry.map.invalidateSize(), 60);
  }).catch(() => { el.remove(); sotaMiniCache.delete(n.id); });
  return el;
};

// Renaming a page updates the visible label of every link to it whose text still equals
// the old title — custom labels stay untouched; #/@ tag pills follow along (text + data-tag).
// Called per title commit, so mid-edit commits chain (old → intermediate → final) and labels
// never detach. Mutations journal ops via recOld, or force a PUT when no txn is open.
window.relabelPageLinks = function relabelPageLinks(pageId, oldTitle, newTitle) {
  oldTitle = (oldTitle || '').trim();
  newTitle = (newTitle || '').trim();
  if (!oldTitle || !newTitle || oldTitle === newTitle) return;
  for (const id of Object.keys(doc.nodes)) {
    if (id === pageId) continue;
    const n = doc.nodes[id];
    if (!n.text || !n.text.includes(`#/n/${pageId}`)) continue;
    const tpl = document.createElement('template');
    tpl.innerHTML = n.text;
    let changed = false;
    for (const a of tpl.content.querySelectorAll(`a[href="#/n/${pageId}"]`)) {
      if (a.classList.contains('tag')) {
        const sig = (a.dataset.tag || '#')[0];
        if (a.textContent.trim() === sig + oldTitle) {
          a.textContent = sig + newTitle;
          a.dataset.tag = sig + newTitle;
          changed = true;
        }
      } else if (a.textContent.trim() === oldTitle) {
        a.textContent = newTitle;
        changed = true;
      }
    }
    if (changed) {
      recOld(id);
      n.text = tpl.innerHTML;
      touch(id);
      if (!undoTxn) uncommittedNodeEdit = true;
      syncMirrorRows(id);
    }
  }
  markDirty();
};

// in an HTML string, replace the visible text of links to `pageId` whose label is still raw
// coordinates with `label` (the address). Leaves custom labels and #/@ tag pills untouched.
function relabelCoordLinks(html, pageId, label) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  let changed = false;
  for (const a of tpl.content.querySelectorAll(`a[href="#/n/${pageId}"]`)) {
    if (!a.classList.contains('tag') && parseCoords(a.textContent)) { a.textContent = label; changed = true; }
  }
  return changed ? tpl.innerHTML : html;
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
// migrations mutate the doc inside the shared afterDocLoad snapshot() (so recOld
// journals them → ops are emitted → they actually persist) and return whether they
// changed anything; afterDocLoad does the single markDirty()/renderPage()
function migrateDayLabels() {
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
  return changed;
}

// merge duplicate top-level pages titled like a date into their calendar day node
// (created before getOrCreatePage became date-aware)
function migrateDupDatePages() {
  let changed = false;
  for (const id of pagesOf()) {
    const n = N(id);
    if (n.cal) continue;
    const iso = parseRoamDate(plainOf(n.text).trim());
    if (!iso) continue;
    const day = window.ensureDayId(iso);
    if (day === id) continue;
    recOld(id); recOld(day);
    for (const c of [...kidsOf(id)]) moveNode(c, day, kidsOf(day).length);
    // re-point every link that aimed at the duplicate to the real day page
    // (match the closing quote so "#/n/abc" never clobbers "#/n/abcdef")
    const from = `#/n/${id}"`, to = `#/n/${day}"`;
    for (const k of Object.keys(doc.nodes)) {
      const t = doc.nodes[k].text;
      if (t && t.includes(from)) { recOld(k); doc.nodes[k].text = t.split(from).join(to); }
    }
    detach(id);
    delete doc.nodes[id];
    changed = true;
  }
  return changed;
}

/* ---------------- Daily Notes view ---------------- */

function dailyViewActive() {
  return state.view === 'daily' && state.zoom === ROOT && !SHARE_TOKEN && !searchActive();
}
window.dailyViewActive = dailyViewActive;

let dailyLoaded = 4;      // day sections currently mounted
const DAILY_STEP = 4;
const DAILY_CAP = 60;     // beyond this, a Load-more button bounds per-edit re-render cost

// all days worth showing, newest first: any day with content, plus today
function dailyDayList() {
  const root = calRoot(false);
  if (!root) return [];
  const today = todayStr();
  const out = [];
  for (const y of kidsOf(root)) {
    if (N(y).cal !== 'year') continue;
    for (const m of kidsOf(y)) {
      if (N(m).cal !== 'month') continue;
      for (const d of kidsOf(m)) {
        const n = N(d);
        if (n.cal === 'day' && n.cd && (hasKids(d) || n.cd === today)) out.push({ id: d, cd: n.cd });
      }
    }
  }
  out.sort((a, b) => b.cd.localeCompare(a.cd));
  return out;
}

// re-render with more sections when the sentinel scrolls into view
const dailyObserver = new IntersectionObserver(entries => {
  if (!entries.some(e => e.isIntersecting) || !dailyViewActive()) return;
  if (dailyLoaded >= DAILY_CAP) return; // Load-more takes over
  dailyLoaded += DAILY_STEP;
  renderPage();
});

function renderDailyView(frag) {
  dailyObserver.disconnect();
  const days = dailyDayList();
  const today = todayStr();
  const shown = days.slice(0, dailyLoaded);
  // Roam parity: every day section carries its own linked references (one doc scan for all)
  const refMap = collectLinkedRefs(new Set(shown.map(d => d.id)));

  for (const { id, cd } of shown) {
    const sec = document.createElement('section');
    sec.className = 'day-section';
    sec.dataset.day = id;

    // not contenteditable, so editableCtx()/editables() skip it by design
    const h = document.createElement('h2');
    h.className = 'day-title';
    h.textContent = roamDateLabel(cd);
    h.title = 'Open this day';
    h.addEventListener('click', () => zoomTo(id));
    sec.append(h);

    const kids = kidsOf(id).filter(c => shouldShow(c, false));
    for (const c of kids) sec.append(mountItem(c, false));
    if (!kids.length) {
      const ph = document.createElement('div');
      ph.className = 'day-empty';
      ph.textContent = cd === today
        ? "Click here to start writing. Type '/' to see commands."
        : 'Nothing here.';
      if (!state.readOnly) ph.addEventListener('click', () => opNewAt(id, 0));
      sec.append(ph);
    }
    const dayRows = refMap.get(id) || [];
    if (dayRows.length) {
      const box = document.createElement('div');
      box.className = 'day-refs';
      if (renderRefBlock(box, id, dayRows, renderPage)) sec.append(box);
    }
    frag.append(sec);
  }

  if (days.length > dailyLoaded) {
    if (dailyLoaded >= DAILY_CAP) {
      const btn = document.createElement('button');
      btn.className = 'daily-more';
      btn.textContent = `Load ${Math.min(30, days.length - dailyLoaded)} more days`;
      btn.addEventListener('click', () => { dailyLoaded += 30; renderPage(); });
      frag.append(btn);
    } else {
      const sentinel = document.createElement('div');
      sentinel.id = 'daily-sentinel';
      frag.append(sentinel);
      // observe after it lands in the document
      queueMicrotask(() => { const el = document.getElementById('daily-sentinel'); if (el) dailyObserver.observe(el); });
    }
  }
}
window.renderDailyView = renderDailyView;

// entering the daily view guarantees today's page exists (never from renderPage —
// that runs on every SSE echo); also resets the scroll window
window.onViewChange = function onViewChange() {
  if (state.view !== 'daily' || SHARE_TOKEN || state.readOnly || !doc) return;
  dailyLoaded = DAILY_STEP;
  if (!findDay(todayStr())) {
    commitActiveText();
    snapshot();
    ensureDay(todayStr());
    markDirty();
  }
};

/* --- editing-op boundary guards, consulted from app.js --- */

// day sections must not leak items into the calendar hierarchy around them
window.isDayBoundary = p => dailyViewActive() && N(p)?.cal === 'day';

// Backspace/Delete merges never cross from one day section into another
window.crossDayMerge = (aId, bId) => {
  if (!dailyViewActive()) return false;
  const dayOf = id => { let p = id; while (p) { if (N(p)?.cal === 'day') return p; p = parentOf(p); } return null; };
  return dayOf(aId) !== dayOf(bId);
};

// clicks on blank page space create items in today's note, not top-level pages
window.newItemTarget = () => dailyViewActive() ? findDay(todayStr()) : null;

/* ---------------- All Pages view ---------------- */

function pagesViewActive() {
  return state.view === 'pages' && state.zoom === ROOT && !SHARE_TOKEN && !searchActive();
}
window.pagesViewActive = pagesViewActive;

let pagesSort = { key: 'm', dir: -1 };

function renderPagesView(frag) {
  const view = document.createElement('div');
  view.className = 'pages-view';
  const h = document.createElement('h1');
  h.className = 'pages-head';
  h.textContent = 'All Pages';
  view.append(h);

  const rows = pagesOf().filter(id => window.pageHasContent(id)).map(id => {
    const cid = contentIdOf(id);
    const n = N(cid);
    return { id: cid, title: plainOf(n.text).trim() || 'Untitled', c: n.c ?? 0, m: n.m ?? 0 };
  });
  // journal day pages are pages too (Roam lists them in All Pages)
  const root = calRoot(false);
  if (root) {
    for (const y of kidsOf(root)) {
      if (N(y).cal !== 'year') continue;
      for (const mo of kidsOf(y)) {
        if (N(mo).cal !== 'month') continue;
        for (const d of kidsOf(mo)) {
          const n = N(d);
          if (n.cal === 'day') rows.push({ id: d, title: plainOf(n.text).trim() || 'Untitled', c: n.c ?? 0, m: n.m ?? 0 });
        }
      }
    }
  }
  const { key, dir } = pagesSort;
  rows.sort((a, b) => key === 'title'
    ? a.title.localeCompare(b.title) * dir
    : (a[key] - b[key]) * dir);

  const table = document.createElement('table');
  table.className = 'pages-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [k, label] of [['title', 'Title'], ['c', 'Created'], ['m', 'Updated']]) {
    const th = document.createElement('th');
    th.textContent = label + (key === k ? (dir > 0 ? ' ↑' : ' ↓') : '');
    th.addEventListener('click', () => {
      pagesSort = { key: k, dir: pagesSort.key === k ? -pagesSort.dir : (k === 'title' ? 1 : -1) };
      renderPage();
    });
    headRow.append(th);
  }
  headRow.append(document.createElement('th')); // delete column
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  let lastTop = null;   // for namespace grouping when sorted by title
  for (const r of rows) {
    const ns = splitNamespace(r.title);
    // group header per top-level namespace (only meaningful when the list is title-sorted)
    if (key === 'title' && ns && ns.top !== lastTop) {
      lastTop = ns.top;
      const gtr = document.createElement('tr');
      gtr.className = 'ns-group';
      const gtd = document.createElement('td');
      gtd.colSpan = 4;
      gtd.textContent = ns.top + '/';
      gtr.append(gtd);
      tbody.append(gtr);
    } else if (key !== 'title' || !ns) {
      lastTop = null;
    }
    const tr = document.createElement('tr');
    if (ns) tr.className = 'ns-child';
    const tdTitle = document.createElement('td');
    const a = document.createElement('a');
    a.href = '#/n/' + r.id;
    setPageLabel(a, r.title);
    tdTitle.append(a);
    const tdC = document.createElement('td');
    tdC.textContent = r.c ? roamDateLabel(isoOf(new Date(r.c))) : '—';
    const tdM = document.createElement('td');
    tdM.textContent = r.m ? roamDateLabel(isoOf(new Date(r.m))) : '—';
    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'pages-del';
    del.title = 'Delete page';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Delete the page “${r.title}” and everything in it? It moves to the trash.`)) return;
      if (state.zoom === r.id) location.hash = '#/';
      opDelete(r.id);
    });
    tdDel.append(del);
    tr.append(tdTitle, tdC, tdM, tdDel);
    tbody.append(tr);
  }
  table.append(tbody);
  view.append(table);

  if (!rows.length) {
    const hint = document.createElement('div');
    hint.className = 'pages-empty';
    hint.textContent = 'No pages yet — press Ctrl+K and type a name to create one.';
    view.append(hint);
  }
  frag.append(view);
}
window.renderPagesView = renderPagesView;

/* ---------------- Map view: every geocoded page as a clickable marker ---------------- */

function mapViewActive() {
  return state.view === 'map' && state.zoom === ROOT && !SHARE_TOKEN && !searchActive();
}
window.mapViewActive = mapViewActive;

let pageMap = null;   // the current Leaflet instance (torn down on every re-render)

function renderMapView(frag) {
  const view = document.createElement('div');
  view.className = 'map-view';
  const h = document.createElement('h1');
  h.className = 'pages-head';
  h.textContent = 'Map';
  view.append(h);

  // collect every page carrying a coordinate — from its first bullet OR its title (pageCoords
  // handles both storage styles: coord-titled pages and address-titled pages with a coords bullet)
  const points = [];
  for (const pid of pagesOf()) {
    const coords = pageCoords(pid);
    if (coords) points.push({ id: pid, coords, title: plainOf(N(pid).text).trim() || 'Untitled' });
  }

  if (!points.length) {
    const hint = document.createElement('div');
    hint.className = 'pages-empty';
    hint.textContent = 'No geocoded pages yet — capture a location (iOS location button) to see it here.';
    view.append(hint);
    frag.append(view);
    return;
  }

  const canvas = document.createElement('div');
  canvas.className = 'map-canvas';
  view.append(canvas);
  frag.append(view);

  if (pageMap) { try { pageMap.remove(); } catch { /* noop */ } pageMap = null; }
  loadLeaflet().then(() => {
    if (!canvas.isConnected) return;   // navigated away while Leaflet loaded
    pageMap = L.map(canvas, { zoomControl: true, attributionControl: true, scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(pageMap);
    const latlngs = [];
    for (const p of points) {
      latlngs.push([p.coords.lat, p.coords.lon]);
      L.circleMarker([p.coords.lat, p.coords.lon], {
        radius: 7, weight: 2, color: '#bf562f', fillColor: '#bf562f', fillOpacity: 0.85,
      })
        .bindTooltip(p.title)
        .on('click', () => { location.hash = '#/n/' + p.id; })
        .addTo(pageMap);
    }
    if (latlngs.length === 1) pageMap.setView(latlngs[0], 14);
    else pageMap.fitBounds(latlngs, { padding: [30, 30] });
    setTimeout(() => pageMap && pageMap.invalidateSize(), 60);
  }).catch(() => {
    canvas.textContent = 'Map failed to load.';
  });
}
window.renderMapView = renderMapView;

/* ---------------- sidebar: Daily Notes / All Pages / Shortcuts / page list --- */

// the page (top-level page or journal day) a node belongs to, for recency
function recencyPageId(id) {
  const chain = [...ancestorsOf(id), id]; // [root, …, id] — ancestorsOf excludes id itself
  for (let i = chain.length - 1; i >= 1; i--) if (N(chain[i])?.cal === 'day') return chain[i];
  const top = chain.length > 1 ? chain[1] : null;
  return top && !isCalRoot(top) ? top : null;
}

/* ---------------- breadcrumbs: a trail of recently visited pages ---------------- */

// Ids only (titles resolve live at render, so renames stay correct). Session-scoped.
let crumbTrail = [];
try { crumbTrail = JSON.parse(sessionStorage.getItem('rz-crumbs') || '[]').filter(x => typeof x === 'string'); } catch { /* fresh */ }
let crumbCurrent = null;   // the page we're on now — it joins the trail when we leave it

function updateCrumbs() {
  const el = document.getElementById('visit-crumbs');
  if (!el) return;
  // settings: the trail can be switched off, and its length tuned
  el.style.display = settings.crumbs === false ? 'none' : '';
  if (settings.crumbs === false) { el.innerHTML = ''; return; }
  // the Daily-Notes view is not a page but should leave a trail entry too ('@daily')
  const cur = state.zoom !== ROOT ? recencyPageId(state.zoom)
    : state.view === 'daily' ? '@daily' : null;
  if (cur !== crumbCurrent) {
    // the page we're leaving becomes the newest crumb
    if (crumbCurrent && (crumbCurrent === '@daily' || N(crumbCurrent))) {
      crumbTrail = crumbTrail.filter(id => id !== crumbCurrent);
      crumbTrail.push(crumbCurrent);
      crumbTrail = crumbTrail.slice(-12);
      try { sessionStorage.setItem('rz-crumbs', JSON.stringify(crumbTrail)); } catch { /* full */ }
    }
    crumbCurrent = cur;
  }
  const items = crumbTrail.filter(id => id !== cur && (id === '@daily' || N(id)))
    .slice(-(parseInt(settings.crumbCount, 10) || 5));
  el.innerHTML = '';
  items.forEach((id, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'visit-crumb-sep';
      sep.textContent = '›';
      el.append(sep);
    }
    const a = document.createElement('a');
    a.className = 'visit-crumb';
    a.href = id === '@daily' ? '#/' : '#/n/' + id;
    a.textContent = id === '@daily' ? 'Daily Notes' : (plainOf(N(id).text).trim() || 'Untitled');
    el.append(a);
  });
}
window.updateCrumbs = updateCrumbs;

// pageId -> most recent edit time anywhere in its subtree (uses each node's `m`)
function pageRecency() {
  const rec = Object.create(null);
  for (const id in doc.nodes) {
    if (id === ROOT) continue;
    const pg = recencyPageId(id);
    if (!pg) continue;
    const m = doc.nodes[id].m || 0;
    if (rec[pg] === undefined || m > rec[pg]) rec[pg] = m; // register even brand-new (m=0) pages
  }
  return rec;
}

// sidebar page list: pinned first, then most-recently-edited (pages + journal days)
function sidebarPageList() {
  const pins = (meta().pins || []).filter(id => doc.nodes[id]);
  const pinnedSet = new Set(pins);
  const rec = pageRecency();
  // empty pages don't exist yet (journal days are exempt; pins are deliberate and stay)
  const recent = Object.keys(rec)
    .filter(id => !pinnedSet.has(id) && (N(id)?.cal === 'day' || window.pageHasContent(id)))
    .sort((a, b) => rec[b] - rec[a]);
  return { list: [...pins, ...recent.slice(0, 18)], pinnedSet, rec };
}

// compact "time since" for the sidebar: now / 5min / 4h / 9d / 2w / 3mo / 1y
function relTime(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'now';
  const min = s / 60;      if (min < 60) return Math.round(min) + 'min';
  const h = min / 60;      if (h < 24) return Math.round(h) + 'h';
  const d = h / 24;        if (d < 7) return Math.round(d) + 'd';
  const w = d / 7;         if (w < 4.35) return Math.round(w) + 'w';
  const mo = d / 30.44;    if (mo < 12) return Math.round(mo) + 'mo';
  return Math.round(d / 365) + 'y';
}

function togglePin(id) {
  const m = meta();
  const i = m.pins.indexOf(id);
  if (i >= 0) m.pins.splice(i, 1); else m.pins.unshift(id);
  markMetaDirty(); // pins live in doc.meta — force a whole-doc PUT so the server keeps them
  window.renderSidebar();
}
window.togglePin = togglePin;

// replaces the upstream outline-tree sidebar (app2.js keeps its version unused)
window.renderSidebar = function renderSidebar() {
  if (SHARE_TOKEN || !doc) return;
  updateCrumbs();   // runs on every render — navigation always passes through here
  window.renderGraphSwitcher?.();

  $('#side-daily')?.classList.toggle('current', state.zoom === ROOT && state.view === 'daily');
  $('#side-pages-link')?.classList.toggle('current', state.view === 'pages');
  $('#side-assets')?.classList.toggle('current', state.view === 'assets');
  $('#side-map')?.classList.toggle('current', state.view === 'map');
  $('#side-graph')?.classList.toggle('current', state.view === 'graph');

  const starsBox = $('#side-stars');
  const starsSection = $('#side-stars-section');
  const stars = meta().stars;
  starsSection.hidden = !stars.length;
  starsBox.innerHTML = '';
  stars.forEach((s, idx) => {
    if (s.id && !doc.nodes[s.id]) return;
    const row = document.createElement('div');
    row.className = 'side-item';
    const a = document.createElement('a');
    a.href = s.id && s.id !== ROOT ? '#/n/' + s.id : '#/';
    const title = s.id && s.id !== ROOT ? (plainOf(N(s.id).text).trim() || 'Untitled') : 'Daily Notes';
    a.innerHTML = (s.q ? `<span class="side-star-q">“${escHtml(s.q)}”</span>` : '') + escHtml(title);
    a.addEventListener('click', () => { setTimeout(() => setSearch(s.q || ''), 50); });
    const rm = document.createElement('button');
    rm.className = 'side-remove';
    rm.title = 'Remove star';
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      meta().stars.splice(idx, 1);
      markMetaDirty(); // stars live in doc.meta — force a whole-doc PUT so removal reaches the server
      window.renderSidebar();
      window.updateStarBtn();
    });
    row.append(a, rm);
    starsBox.append(row);
  });

  const pagesBox = $('#side-pages');
  if (!pagesBox) return;
  pagesBox.innerHTML = '';
  const currentPage = pageOf(state.zoom);
  const { list, pinnedSet, rec } = sidebarPageList();
  for (const id of list) {
    const cid = contentIdOf(id); // a top-level mirror lists its target's text
    const n = N(cid);
    if (!n) continue;
    if (n.done && !settings.showCompleted) continue;
    const isPinned = pinnedSet.has(id);
    const title = plainOf(n.text).trim() || 'Untitled';
    const ns = splitNamespace(title);
    const row = document.createElement('div');
    row.className = 'side-item side-page' + (isPinned ? ' pinned' : '') + (ns ? ' ns-child' : '');
    if (state.zoom !== ROOT && (currentPage === id || currentPage === cid)) row.classList.add('current');
    const pin = document.createElement('button');
    pin.className = 'side-pin' + (isPinned ? ' on' : '');
    pin.title = isPinned ? 'Unpin' : 'Pin to top';
    pin.textContent = '📌';
    pin.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); togglePin(id); });
    const a = document.createElement('a');
    a.href = '#/n/' + cid;
    setPageLabel(a, title);
    const time = document.createElement('span');
    time.className = 'side-time';
    time.textContent = relTime(rec[id] ?? rec[cid]);   // relative last-edit, greyed on the right
    const del = document.createElement('button');
    del.className = 'side-remove side-del';
    del.title = 'Delete page';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Delete the page “${title}” and everything in it? It moves to the trash.`)) return;
      if (state.zoom === id || state.zoom === cid) location.hash = '#/'; // leave the page we're deleting
      opDelete(id);
    });
    row.append(pin, a, time, del);
    pagesBox.append(row);
  }
  window.renderRightbar?.(); // keep the side-by-side panel live with the main view
};

/* ---------------- Roam-style date-picker calendar ---------------- */

// the calendar popup Roam shows for /Date Picker: ‹ month⇅ year⇅ › steppers
// over a Su–Sa day grid; consumed by buildDatePicker() in app2.js
window.buildRoamCalendar = function buildRoamCalendar(onPick, onEscape) {
  const wrap = document.createElement('div');
  wrap.className = 'dp';
  const view = new Date();
  view.setDate(1);
  const DP_DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  const mk = (cls, label, fn, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's selection
    b.addEventListener('click', fn);
    return b;
  };

  const build = () => {
    wrap.innerHTML = '';
    const step = (unit, dir) => {
      if (unit === 'm') view.setMonth(view.getMonth() + dir);
      else view.setFullYear(view.getFullYear() + dir);
      build();
    };
    const stepper = unit => {
      const s = document.createElement('span');
      s.className = 'dp-step';
      s.append(mk('', '▴', () => step(unit, 1)), mk('', '▾', () => step(unit, -1)));
      return s;
    };
    const label = txt => {
      const s = document.createElement('span');
      s.className = 'dp-label';
      s.textContent = txt;
      return s;
    };

    const head = document.createElement('div');
    head.className = 'dp-head';
    const spacer = document.createElement('span');
    spacer.className = 'dp-spacer';
    head.append(
      mk('dp-nav', '‹', () => step('m', -1), 'Previous month'),
      label(MONTHS_LONG[view.getMonth()]), stepper('m'),
      spacer,
      label(String(view.getFullYear())), stepper('y'),
      mk('dp-nav', '›', () => step('m', 1), 'Next month'),
    );
    wrap.append(head);

    const grid = document.createElement('div');
    grid.className = 'dp-grid';
    for (const d of DP_DOW) {
      const c = document.createElement('span');
      c.className = 'dp-dow';
      c.textContent = d;
      grid.append(c);
    }
    const firstDow = new Date(view.getFullYear(), view.getMonth(), 1).getDay(); // 0 = Su
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement('span');
      blank.className = 'dp-blank';
      grid.append(blank);
    }
    // days whose journal holds SELF-WRITTEN content get a dot. The #daily-template seeds
    // every fresh day (e.g. "#Log"), so template-shaped text doesn't count: a day's text
    // only marks it once it exceeds the template's text multiset (extra or edited lines).
    const journalDays = new Set();
    if (typeof doc !== 'undefined' && doc?.nodes) {
      const tplCounts = new Map();
      const tpl = Object.keys(doc.nodes).find(id => plainOf(doc.nodes[id].text || '').includes('#daily-template'));
      if (tpl) {
        const walkTpl = id => {
          for (const c of kidsOf(id)) {
            const t = plainOf(N(c)?.text || '').trim();
            if (t) tplCounts.set(t, (tplCounts.get(t) || 0) + 1);
            walkTpl(c);
          }
        };
        walkTpl(tpl);
      }
      const hasOwnText = day => {
        const seen = new Map();
        let found = false;
        const walk = id => {
          for (const c of kidsOf(id)) {
            if (found) return;
            const t = plainOf(N(c)?.text || '').trim();
            if (t) {
              const n = (seen.get(t) || 0) + 1;
              seen.set(t, n);
              if (n > (tplCounts.get(t) || 0)) { found = true; return; }
            }
            walk(c);
          }
        };
        walk(day);
        return found;
      };
      for (const id of Object.keys(doc.nodes)) {
        const n = doc.nodes[id];
        if (n.cal === 'day' && n.cd && hasOwnText(id)) journalDays.add(n.cd);
      }
    }
    const today = todayStr();
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoOf(new Date(view.getFullYear(), view.getMonth(), d));
      grid.append(mk('dp-day' + (iso === today ? ' today' : '') + (journalDays.has(iso) ? ' has-journal' : ''),
        String(d), () => onPick(iso)));
    }
    wrap.append(grid);
  };
  build();

  wrap.tabIndex = -1;
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); }
  });
  return wrap;
};

/* ---------------- Roam-style inserts: [[ page search, journal links, slash --- */

// the [[ autocomplete searches pages and day pages, like Roam's page picker
window.searchPages = function searchPages(q, limit = 8) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const scan = (id, day) => {
    const plain = plainOf(N(id).text).trim();
    if (!plain) return;
    const hay = plain.toLowerCase();
    let score = -1;
    if (!terms.length) score = day ? -1 : 0; // empty query: offer pages, not the whole journal
    else if (terms.every(t => hay.includes(t))) score = 100 - hay.indexOf(terms[0]) - (day ? 20 : 0);
    if (score >= 0) out.push({ id, plain, day, score });
  };
  for (const id of pagesOf()) scan(contentIdOf(id), false);
  // aliases resolve to their page but surface under the alias text the user typed
  for (const [alias, pid] of pageAliasMap()) {
    if (out.some(o => o.id === pid)) continue; // already matched by title
    let score = -1;
    if (terms.length && terms.every(t => alias.includes(t))) score = 90 - alias.indexOf(terms[0]);
    if (score >= 0) out.push({ id: pid, plain: alias, day: false, alias: true, score });
  }
  const root = calRoot(false);
  if (root) {
    for (const y of kidsOf(root)) {
      if (N(y).cal !== 'year') continue;
      for (const m of kidsOf(y)) {
        if (N(m).cal !== 'month') continue;
        for (const d of kidsOf(m)) if (N(d).cal === 'day') scan(d, true);
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
};

// find or create a journal day node (caller must have snapshot()ed)
window.ensureDayId = iso => findDay(iso) || ensureDay(iso);

// physically relocate an item under a journal day page (Roam "move to today")
window.moveItemToDay = function moveItemToDay(id, iso) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const day = ensureDayId(iso);
  if (day === id || isAncestor(id, day)) return; // never move a node into itself
  moveNode(id, day, kidsOf(day).length);
  markDirty();
  renderPage();
  showToast('Moved to ' + roamDateLabel(iso), { label: 'Open', fn: () => zoomTo(day) });
};

// convert literal [[Title]] / [[Target|Alias]] wiki-links in a text/HTML string
// into real page links (creating pages), skipping code, existing links and pills.
// Caller must have snapshot()ed. Returns the (possibly unchanged) HTML.
function linkifyWikiLinks(html) {
  if (!html || !html.includes('[[')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  let changed = false;
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue;
        if (!text.includes('[[')) continue;
        const re = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
        const frag = document.createDocumentFragment();
        let m, last = 0, hit = false;
        while ((m = re.exec(text))) {
          hit = true;
          // a # / @ right before [[ makes it a (multi-word) tag rather than a plain link
          const sig = (text[m.index - 1] === '#' || text[m.index - 1] === '@') && m.index - 1 >= last ? text[m.index - 1] : '';
          const preEnd = sig ? m.index - 1 : m.index;
          if (preEnd > last) frag.append(document.createTextNode(text.slice(last, preEnd)));
          frag.append(makePageAnchor(getOrCreatePage(m[1].trim()), (m[2] || m[1]).trim(), sig));
          last = re.lastIndex;
        }
        if (hit) {
          if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
          child.replaceWith(frag);
          changed = true;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE && !['A', 'CODE', 'TIME'].includes(child.tagName)) {
        walk(child);
      }
    }
  };
  walk(tpl.content);
  return changed ? tpl.innerHTML : html;
}

// turn every literal [[wiki-link]] in the doc into a real link. Mutates within the
// caller's snapshot (afterDocLoad or the import handler) and returns whether it
// changed anything; the caller markDirty()/renderPage()s.
window.migrateWikiLinks = function migrateWikiLinks() {
  if (SHARE_TOKEN || state.readOnly || !doc) return false;
  let changed = false;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n.text || !n.text.includes('[[')) continue;
    const linked = linkifyWikiLinks(n.text);
    if (linked !== n.text) { recOld(id); n.text = sanitizeHtml(linked); n.m = Date.now(); changed = true; }
  }
  return changed;
};

// a link element / HTML pointing at a journal day page (creates the day)
window.dayLinkEl = function dayLinkEl(iso) {
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + ensureDayId(iso));
  a.setAttribute('rel', 'noopener');
  a.textContent = roamDateLabel(iso);
  return a;
};
window.dayLinkHtml = iso => `<a href="#/n/${ensureDayId(iso)}" rel="noopener">${escHtml(roamDateLabel(iso))}</a>`;

// insert an internal link to a journal day page at the caret (creates the day)
window.insertJournalLink = function insertJournalLink(ctx, iso, at) {
  if (state.readOnly) return;
  snapshot();
  const day = findDay(iso) || ensureDay(iso);
  focusItem(ctx.id, 'text', at ?? 'end');
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + day);
  a.setAttribute('rel', 'noopener');
  a.textContent = roamDateLabel(iso);
  insertInlineAtCaret(sel, sel.getRangeAt(0), a);
  const el = elById.get(ctx.id)?.querySelector(':scope > .row > .content');
  if (el) scheduleCommit(el);
  markDirty();
};

// extra slash-menu entries, consumed by slashCommands() in app2.js
window.rhizomeSlashCommands = function rhizomeSlashCommands(ctx, popStart) {
  const at = popStart;
  const refocus = () => focusItem(ctx.id, 'text', at ?? 'end');
  return [
    {
      label: 'Page Reference', icon: '⟦⟧', hint: '[[',
      // typing "[[" re-enters the normal autocomplete flow via the input hook
      fn: () => { refocus(); document.execCommand('insertText', false, '[['); },
    },
    {
      label: 'Table', icon: '⊞', hint: '{{table}}',
      fn: () => { refocus(); document.execCommand('insertText', false, '{{table}}'); },
    },
    { label: 'Today', icon: icon('calendar'), fn: () => insertJournalLink(ctx, dateOffset(0), at) },
    { label: 'Tomorrow', icon: icon('calendar'), fn: () => insertJournalLink(ctx, dateOffset(1), at) },
    { label: 'Yesterday', icon: icon('calendar'), fn: () => insertJournalLink(ctx, dateOffset(-1), at) },
    { label: 'Date Picker', icon: icon('calendar'), fn: () => pickDate(nodeAnchor(ctx.id), iso => insertJournalLink(ctx, iso, at)) },
    {
      label: 'Current Time', icon: icon('time'),
      fn: () => {
        refocus();
        const d = new Date();
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        document.execCommand('insertText', false, hhmm + ' ');
      },
    },
  ];
};

/* ---------------- {{table}}: children rendered as a Roam-style table ---------------- */

// Roam semantics: each child of the {{table}} block is a row, each nesting level a column;
// a parent cell spans all its leaf paths (rowspan). The source bullets stay editable below
// (fold the block to see just the table). Cell click focuses/zooms the underlying bullet.
window.buildTableBlock = function buildTableBlock(n) {
  if (!/\{\{table\}\}/.test(n.text || '')) return null;
  const box = document.createElement('div');
  box.className = 'rz-table-block';
  const kids = kidsOf(contentIdOf(n.id));
  if (!kids.length) {
    box.innerHTML = '<div class="ref-none">Add child bullets: each child is a row, each nesting level a column.</div>';
    return box;
  }
  const leaves = id => {
    const k = kidsOf(contentIdOf(id));
    return k.length ? k.reduce((s, c) => s + leaves(c), 0) : 1;
  };
  const rows = [];
  const walk = (id, row) => {
    const cid = contentIdOf(id);
    row.push({ id: cid, span: leaves(cid) });
    const k = kidsOf(cid);
    if (!k.length) { rows.push(row); return; }
    walk(k[0], row);                       // first child continues this row
    for (const rest of k.slice(1)) walk(rest, []);   // siblings open spanned continuation rows
  };
  for (const k of kids) walk(k, []);
  const table = document.createElement('table');
  table.className = 'rz-table';
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const cell of r) {
      const td = document.createElement('td');
      if (cell.span > 1) td.rowSpan = cell.span;
      td.dataset.id = cell.id;
      td.innerHTML = displayHtml(N(cell.id));
      tr.append(td);
    }
    table.append(tr);
  }
  box.append(table);
  box.addEventListener('click', e => {
    if (e.target.closest('a, .tag, time, .attr-key')) return;   // links/tags keep their behaviour
    const td = e.target.closest('td[data-id]');
    if (!td || state.readOnly) return;
    if (editableNode(td.dataset.id)) focusItem(td.dataset.id, 'text', 'end');
    else zoomTo(td.dataset.id);
  });
  return box;
};

// Re-render every mounted table whose subtree contains the changed node — text commits
// don't re-render the page, so without this an edited cell went stale until the next render.
window.refreshTableBlocks = function refreshTableBlocks(changedId) {
  for (const box of treeEl.querySelectorAll('.rz-table-block')) {
    const hostId = box.closest('.item')?.dataset.id;
    if (!hostId || !doc.nodes[hostId]) continue;
    let p = changedId, inside = false;
    while (p) { if (p === hostId) { inside = true; break; } p = parentOf(p); }
    if (!inside) continue;
    const fresh = window.buildTableBlock(N(contentIdOf(hostId)));
    if (fresh) box.replaceWith(fresh);
  }
};

/* ---------------- Linked & Unlinked References ---------------- */

// references from daily notes group under their day page, not the calendar container
function refGroupOf(id) {
  let p = id;
  while (p) { if (N(p)?.cal === 'day') return p; p = parentOf(p); }
  return pageOf(id);
}

// one pass over the doc collecting linked references for every target at once
// (the daily view asks for all visible days in a single scan)
function collectLinkedRefs(targets) {
  const out = new Map(); // target → rows
  const add = (t, row) => { const a = out.get(t) || []; a.push(row); out.set(t, a); };
  // Roam-style: a page also collects #tag / @mention references to its title.
  // Only single-token titles can be tagged (multi-word titles have no tag form).
  const tagRe = new Map();
  const attrTargets = new Map(); // lowercased title → target (a "Key:: …" block references page Key)
  for (const t of targets) {
    const title = plainOf(N(t).text).trim();
    if (title && /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(title)) {
      tagRe.set(t, new RegExp('[#@]' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_\\-/])', 'u'));
    }
    if (title) attrTargets.set(title.toLowerCase(), t);
  }
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (n.mirror && n.mirror !== id && targets.has(n.mirror)) {
      const host = parentOf(id) || id;
      add(n.mirror, { id: host, label: 'mirrored in ' + (plainOf(N(host)?.text || '').trim() || 'Untitled') });
    }
    if (!n.text) continue;
    const seen = new Set();
    for (const m of n.text.matchAll(/#\/n\/([A-Za-z0-9]+)/g)) {
      const t = m[1];
      if (t === id || seen.has(t) || !targets.has(t)) continue;
      seen.add(t);
      add(t, { id, html: n.text });
    }
    for (const [t, re] of tagRe) {
      if (t === id || seen.has(t)) continue;
      if (re.test(n.text)) { seen.add(t); add(t, { id, html: n.text }); }
    }
    if (attrTargets.size) {
      const am = plainOf(n.text).match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]*?)::/u);
      const t = am && attrTargets.get(am[1].trim().toLowerCase());
      if (t && t !== id && !seen.has(t)) { seen.add(t); add(t, { id, html: n.text }); }
    }
  }
  return out;
}

// "Key:: value" at a block's start → { key, value }, else null (foundation for aliases + queries)
window.parseAttribute = function parseAttribute(node) {
  const m = plainOf(N(node).text).match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]*?)::\s?([\s\S]*)$/u);
  return m ? { key: m[1].trim(), value: m[2].trim() } : null;
};

// A node's attributes, Roam-style: every direct child of the form "Key:: value" becomes an
// entry (case-insensitive). The node's own text counts too, so a bullet "Location:: Kokelv"
// IS its own attribute. A key may appear several times (e.g. Location:: address + the cached
// Location:: coordinates) — `value`/`node` are the first occurrence, `values` holds them all.
// Returns Map lowerKey → { key, value, node, values: [{ value, node }, …] }.
window.attrsOf = function attrsOf(id) {
  const out = new Map();
  const take = nid => {
    const a = N(nid) && window.parseAttribute(nid);
    if (!a || !a.value) return;
    const k = a.key.toLowerCase();
    const e = out.get(k);
    if (e) e.values.push({ value: a.value, node: nid });
    else out.set(k, { ...a, node: nid, values: [{ value: a.value, node: nid }] });
  };
  take(id);
  for (const c of kidsOf(id)) take(c);
  return out;
};

/* ---------------- Live queries: {{query: {and:…}{or:…}{not:…}{between:…}}} ---------------- */

// parse a query block into an AST. Page refs come from anchors (#/n/id) or literal
// [[Name]] / #tag; a [[date]] becomes a date leaf (for {between}). Returns a clause or null.
window.parseLiveQuery = function parseLiveQuery(raw) {
  const qm = (raw || '').match(/\{\{query:([\s\S]*)\}\}/);
  if (!qm) return null;
  // {view:…}{group:…}{sort:…} are rendering hints, not match clauses — pull them out before parsing.
  const body = qm[1].replace(/\{(?:view|group|sort)\s*:[^}]*\}/gi, ' ');
  const tokens = [];
  const FIELD = 'is|has|text|highlight|attr|changed|created|in|on|link|namespace|date-before|date-after|day-of-week|date';
  const re = new RegExp(
    '\\{(and|or|not|between)\\s*:' +                                  // 1: boolean group
    '|\\{(' + FIELD + ')\\s*:\\s*([^}]*)\\}' +                        // 2: field op, 3: value
    '|(\\})' +                                                        // 4: close
    '|<a[^>]*href="#/n/([A-Za-z0-9]+)"[^>]*>[\\s\\S]*?</a>' +         // 5: anchor id
    '|\\[\\[([^\\]]+)\\]\\]' +                                        // 6: [[name]]
    '|#\\[\\[([^\\]]+)\\]\\]' +                                       // 7: #[[name]]
    '|#([\\p{L}\\p{N}_][\\p{L}\\p{N}_\\-/]*)',                        // 8: #tag
    'gu');
  let m;
  while ((m = re.exec(body))) {
    if (m[1]) { tokens.push({ t: 'open', op: m[1] }); continue; }
    if (m[2]) { // a field filter like {is:todo}, {created:7d}, {date:this week}
      const kind = m[2].toLowerCase() === 'text' ? 'textfmt' : m[2].toLowerCase();
      tokens.push({ t: 'filter', cond: { neg: false, kind, value: (m[3] || '').trim().toLowerCase() } });
      continue;
    }
    if (m[4]) { tokens.push({ t: 'close' }); continue; }
    if (m[5]) { // an existing anchor: a day node is a date, anything else a page
      const cd = N(m[5]) && N(m[5]).cd;
      tokens.push(cd ? { t: 'date', iso: cd } : { t: 'page', id: m[5] });
      continue;
    }
    const name = (m[6] || m[7] || m[8] || '').trim();
    if (!name) continue;
    const iso = parseRoamDate(name);
    if (iso) { tokens.push({ t: 'date', iso }); continue; }
    const id = findPageByTitle(name);
    if (id) tokens.push({ t: 'page', id });
  }
  let i = 0;
  const parse = () => {
    const tok = tokens[i];
    if (!tok) return null;
    if (tok.t === 'page') { i++; return { op: 'ref', id: tok.id }; }
    if (tok.t === 'date') { i++; return { op: 'date', iso: tok.iso }; }
    if (tok.t === 'filter') { i++; return { op: 'filter', cond: tok.cond }; }
    if (tok.t === 'open') {
      i++;
      const children = [];
      while (tokens[i] && tokens[i].t !== 'close') { const c = parse(); if (c) children.push(c); else i++; }
      i++; // consume the matching }
      return { op: tok.op, children };
    }
    i++;
    return null;
  };
  return parse();
};

// evaluate a query AST → array of matching block ids (selfId excluded)
window.evalLiveQuery = function evalLiveQuery(ast, selfId) {
  if (!ast) return [];
  const isResult = id => {
    const n = doc.nodes[id];
    return id !== selfId && n && n.text && !isCalRoot(id)
      && plainOf(n.text).trim() && !/\{\{query:/.test(n.text); // query blocks aren't results
  };
  const universe = () => Object.keys(doc.nodes).filter(isResult);
  const refMatches = pageId => {
    const set = new Set();
    const title = plainOf(N(pageId).text).trim();
    const tagRe = /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(title)
      ? new RegExp('[#@]' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_\\-/])', 'u') : null;
    for (const id of Object.keys(doc.nodes)) {
      if (!isResult(id)) continue;
      const n = doc.nodes[id];
      // a block matches a page ref if it links/tags the page, or lives on it (not the title itself)
      if (n.text.includes('#/n/' + pageId) || (tagRe && tagRe.test(n.text)) || (refGroupOf(id) === pageId && id !== pageId)) set.add(id);
    }
    return set;
  };
  const inter = sets => sets.reduce((a, s) => new Set([...a].filter(x => s.has(x))));
  const ev = node => {
    if (node.op === 'ref') return refMatches(node.id);
    if (node.op === 'date') return new Set(); // only meaningful inside {between}
    if (node.op === 'filter') { // a search-DSL field condition, e.g. {is:todo} {created:7d}
      const set = new Set();
      for (const id of universe()) if (window.nodeMatchesCond(id, node.cond)) set.add(id);
      return set;
    }
    if (node.op === 'between') {
      const isos = node.children.map(c => c.iso).filter(Boolean).sort();
      const [a, b] = isos;
      const set = new Set();
      if (!a || !b) return set;
      for (const id of Object.keys(doc.nodes)) {
        if (!isResult(id)) continue;
        const cd = N(refGroupOf(id)) && N(refGroupOf(id)).cd;
        if (cd && cd >= a && cd <= b) set.add(id);
      }
      return set;
    }
    const pos = (node.children || []).filter(c => c.op !== 'not');
    const negs = (node.children || []).filter(c => c.op === 'not');
    let acc;
    if (node.op === 'or') { acc = new Set(); for (const c of pos) for (const x of ev(c)) acc.add(x); if (!pos.length) acc = new Set(universe()); }
    else if (node.op === 'not') { acc = new Set(universe()); for (const x of ev(node.children[0] || {})) acc.delete(x); return acc; }
    else acc = pos.length ? inter(pos.map(ev)) : new Set(universe()); // and (default)
    for (const ng of negs) for (const x of ev(ng.children[0] || {})) acc.delete(x);
    return acc;
  };
  const res = ev(ast);
  res.delete(selfId);
  return [...res];
};

// which result view a {{query}} block asked for via a {view:…} hint (list is the default)
function queryView(text) {
  const m = (text || '').match(/\{view:\s*(list|table|board|kanban|calendar)\s*\}/i);
  const v = m && m[1].toLowerCase();
  return v === 'kanban' ? 'board' : (v || 'list');
}

// a representative ISO date for a result block: the day page it lives under, else its first date pill
function blockDate(id) {
  const g = N(refGroupOf(id));
  if (g && g.cal === 'day' && g.cd) return g.cd;
  const pills = (typeof pillDates === 'function') ? pillDates(N(contentIdOf(id)).text || '') : [];
  return pills.sort()[0] || null;
}

// the source-page title + id a result belongs to (for the Page column / board columns)
function resultPage(id) {
  const gid = refGroupOf(id);
  return { id: gid, title: (plainOf(N(gid)?.text || '').trim()) || 'Untitled' };
}

// ---- result views ----
function buildQueryTable(ids) {
  const table = document.createElement('table');
  table.className = 'query-table';
  table.innerHTML = '<thead><tr><th>Text</th><th>Page</th><th>Date</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const id of ids) {
    const tr = document.createElement('tr');
    const tdText = document.createElement('td');
    tdText.className = 'qt-text';
    tdText.innerHTML = decorate(N(contentIdOf(id)).text || '');
    tdText.addEventListener('click', e => { if (!e.target.closest('a')) zoomTo(id); });
    const tdPage = document.createElement('td');
    const pg = resultPage(id);
    const a = document.createElement('a'); a.href = '#/n/' + pg.id; a.textContent = pg.title;
    tdPage.append(a);
    const tdDate = document.createElement('td');
    tdDate.className = 'qt-date'; tdDate.textContent = blockDate(id) || '';
    tr.append(tdText, tdPage, tdDate);
    tb.append(tr);
  }
  table.append(tb);
  return table;
}

function buildQueryBoard(ids) {
  const cols = new Map(); // pageId → { title, ids[] }
  for (const id of ids) {
    const pg = resultPage(id);
    const col = cols.get(pg.id) || { title: pg.title, ids: [] };
    col.ids.push(id); cols.set(pg.id, col);
  }
  const board = document.createElement('div');
  board.className = 'query-board';
  for (const [pid, col] of cols) {
    const c = document.createElement('div'); c.className = 'qb-col';
    const h = document.createElement('a'); h.className = 'qb-col-head'; h.href = '#/n/' + pid;
    h.textContent = `${col.title} (${col.ids.length})`;
    c.append(h);
    for (const id of col.ids) {
      const card = document.createElement('div'); card.className = 'qb-card';
      card.innerHTML = decorate(N(contentIdOf(id)).text || '');
      card.addEventListener('click', e => { if (!e.target.closest('a')) zoomTo(id); });
      c.append(card);
    }
    board.append(c);
  }
  return board;
}

function buildQueryCalendar(ids) {
  const wrap = document.createElement('div');
  wrap.className = 'query-calendar';
  const byDay = new Map(); const undated = [];
  for (const id of ids) { const d = blockDate(id); if (d) (byDay.get(d) || byDay.set(d, []).get(d)).push(id); else undated.push(id); }
  // the month to show: the earliest result's month, else the current month
  const anchor = [...byDay.keys()].sort()[0] || isoOf(new Date());
  const [ay, am] = anchor.split('-').map(Number);
  const first = new Date(ay, am - 1, 1);
  const weekStart = (settings.weekStart === 'sun') ? 0 : 1;
  const lead = (first.getDay() - weekStart + 7) % 7;
  const days = new Date(ay, am, 0).getDate();
  const head = document.createElement('div');
  head.className = 'qc-head';
  head.textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  wrap.append(head);
  const grid = document.createElement('div');
  grid.className = 'qc-grid';
  const dow = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  for (let i = 0; i < 7; i++) { const d = document.createElement('div'); d.className = 'qc-dow'; d.textContent = dow[(weekStart + i) % 7]; grid.append(d); }
  for (let i = 0; i < lead; i++) { const e = document.createElement('div'); e.className = 'qc-cell qc-empty'; grid.append(e); }
  for (let day = 1; day <= days; day++) {
    const iso = `${ay}-${String(am).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = document.createElement('div'); cell.className = 'qc-cell';
    const num = document.createElement('div'); num.className = 'qc-num'; num.textContent = String(day); cell.append(num);
    for (const id of (byDay.get(iso) || [])) {
      const chip = document.createElement('div'); chip.className = 'qc-chip';
      chip.textContent = plainOf(N(contentIdOf(id)).text || '').slice(0, 40);
      chip.addEventListener('click', () => zoomTo(id));
      cell.append(chip);
    }
    grid.append(cell);
  }
  wrap.append(grid);
  if (undated.length) {
    const u = document.createElement('div'); u.className = 'qc-undated';
    u.textContent = `${undated.length} without a date`;
    wrap.append(u);
  }
  return wrap;
}

// the live result list appended under a {{query:…}} block (re-runs on every render)
window.buildQueryResults = function buildQueryResults(n) {
  if (!/\{\{query:/.test(n.text || '')) return null;
  const box = document.createElement('div');
  box.className = 'query-block';
  const ast = window.parseLiveQuery(n.text);
  if (!ast) { box.innerHTML = '<div class="ref-none">Invalid query.</div>'; return box; }
  const ids = window.evalLiveQuery(ast, n.id).filter(id => doc.nodes[id]);
  const view = queryView(n.text);
  const head = document.createElement('div');
  head.className = 'query-head';
  head.textContent = `${ids.length} result${ids.length === 1 ? '' : 's'}` + (view !== 'list' ? ` · ${view}` : '');
  box.append(head);
  if (!ids.length) {
    const none = document.createElement('div'); none.className = 'ref-none'; none.textContent = 'No matches.';
    box.append(none);
    return box;
  }
  if (view === 'table') box.append(buildQueryTable(ids));
  else if (view === 'board') box.append(buildQueryBoard(ids));
  else if (view === 'calendar') box.append(buildQueryCalendar(ids));
  else {
    const built = buildRefGroups(null, ids.map(id => ({ id, html: N(contentIdOf(id)).text })));
    if (built) box.append(built.el);
    else { const none = document.createElement('div'); none.className = 'ref-none'; none.textContent = 'No matches.'; box.append(none); }
  }
  return box;
};

// grouped DOM for one target's rows; null when nothing survives the self-filter
function buildRefGroups(target, rows) {
  const groups = new Map();
  let count = 0;
  for (const r of rows) {
    const gid = refGroupOf(r.id);
    if (gid === target) continue; // references from inside the page aren't backlinks
    const g = groups.get(gid) || [];
    if (g.length >= 30) continue;
    g.push(r);
    groups.set(gid, g);
    count++;
  }
  if (!count) return null;
  const el = document.createDocumentFragment();
  for (const [gid, gRows] of groups) {
    const gEl = document.createElement('div');
    gEl.className = 'ref-group';
    const title = document.createElement('a');
    title.className = 'ref-page';
    title.href = '#/n/' + gid;
    title.textContent = plainOf(N(gid)?.text || '').trim() || 'Untitled';
    gEl.append(title);
    for (const r of gRows) {
      const row = document.createElement('div');
      row.className = 'ref-row';
      if (r.html != null) {
        row.innerHTML = decorate(r.html);
        row.addEventListener('click', e => { if (!e.target.closest('a')) zoomTo(r.id); });
      } else {
        const a = document.createElement('a');
        a.href = '#/n/' + r.id;
        a.textContent = r.label;
        row.append(a);
      }
      gEl.append(row);
    }
    el.append(gEl);
  }
  return { el, count };
}

// replaces the upstream flat "Linked from" list with Roam-style sections:
// linked references grouped by their containing page, plus a lazy
// unlinked-references scan with a one-click Link action
// whole-outline search results, grouped by page (reuses the reference layout)
window.renderSearchResults = function renderSearchResults(frag) {
  const matched = [...(state.matchSet || [])]
    .filter(id => doc.nodes[id] && plainOf(N(contentIdOf(id)).text).trim()); // skip empty rows (bare mirrors, dividers)
  // a real page (top-level page or journal day) vs a bullet that merely mentions one
  const isPageHit = id => (kidsOf(ROOT).includes(id) && !isCalRoot(id)) || N(id)?.cal === 'day';
  const pages = matched.filter(isPageHit);
  const mentions = matched.filter(id => !isPageHit(id));

  // plain queries also surface pages by TITLE SUBSTRING and by ALIAS — the FTS candidate
  // pass tokenizes words, so "HA" would neither reach "HomeAssistant" nor its Aliases:: HA
  const rawQ = (state.search || '').trim().toLowerCase();
  if (rawQ && rawQ.length >= 2 && !/[:"]/.test(rawQ)) {
    const have = new Set(pages);
    let extras = 0;
    for (const pid of pagesOf()) {
      if (extras >= 6) break;
      if (have.has(pid) || !window.pageHasContent(pid)) continue;
      if (plainOf(N(pid).text).trim().toLowerCase().includes(rawQ)) { pages.push(pid); have.add(pid); extras++; }
    }
    for (const [alias, pid] of pageAliasMap()) {
      if (extras >= 8) break;
      if (have.has(pid)) continue;
      if (alias === rawQ || alias.startsWith(rawQ)) { pages.push(pid); have.add(pid); extras++; }
    }
  }

  const view = document.createElement('div');
  view.className = 'search-results';

  // real pages first, highlighted, with a type chip — they're the primary hit
  if (pages.length) {
    const sec = document.createElement('div');
    sec.className = 'search-pages';
    for (const id of pages) {
      const a = document.createElement('a');
      a.className = 'search-page';
      a.href = '#/n/' + id;
      const title = plainOf(N(id).text).trim() || 'Untitled';
      a.innerHTML = `<span class="sp-title">${escHtml(title)}</span>` +
        `<span class="chip accent">${N(id).cal === 'day' ? 'Journal' : 'Page'}</span>`;
      sec.append(a);
    }
    view.append(sec);
  }

  // the mentions, grouped by their page (as before)
  const built = mentions.length ? buildRefGroups(null, mentions.map(id => ({ id, html: N(contentIdOf(id)).text }))) : null;
  if (built) {
    if (pages.length) {
      const h = document.createElement('div');
      h.className = 'search-mentions-head';
      h.textContent = 'Mentions';
      view.append(h);
    }
    view.append(built.el);
  } else if (!pages.length) {
    view.innerHTML = '<div class="ref-none">Nothing matches.</div>';
  }
  frag.append(view);
};

// Roam-style filter for a Linked References section. Each tag/page-link that appears among the
// referencing blocks becomes a tri-state chip: 1st click = include (block must contain it), 2nd =
// exclude (must not), 3rd = clear. Includes are AND-combined. Filters are view-only, kept per
// target so several day sections in the daily view can each have their own, and cleared on
// navigation (window.resetRefFilters, called from applyHash).
const refFilters = new Map(); // targetId -> { state: Map<token,'include'|'exclude'>, open: bool }
window.resetRefFilters = () => refFilters.clear();

// the filterable tokens a reference block carries: page-links (id:<id>) and #tag/@mention (tag:<#x>)
function refRowTokens(html) {
  const toks = new Set();
  for (const m of (html || '').matchAll(/#\/n\/([A-Za-z0-9]+)/g)) toks.add('id:' + m[1]);
  for (const m of plainOf(html).matchAll(/(^|[\s(])([#@][\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu)) toks.add('tag:' + m[2]);
  return toks;
}

// Render the References block for `target` (header + funnel + chip bar + filtered groups) into
// `container`. `rerender` rebuilds the view in place when a chip/funnel is toggled. Returns true
// if the target actually has backlinks (so a caller can skip an empty section).
function renderRefBlock(container, target, rows, rerender) {
  let f = refFilters.get(target);
  if (!f) { f = { state: new Map(), open: false }; refFilters.set(target, f); }
  const sel = f.state;
  const hasBacklinks = rows.some(r => refGroupOf(r.id) !== target);

  // tally the tokens available to filter on, skipping the page's own link/tag form (always present)
  const selfTitle = plainOf(N(target).text).trim();
  const skip = new Set(['id:' + target, 'tag:#' + selfTitle, 'tag:@' + selfTitle]);
  const tally = new Map(); // token -> { label, count }
  for (const r of rows) {
    if (r.html == null) continue;
    for (const tok of refRowTokens(r.html)) {
      if (skip.has(tok)) continue;
      const cur = tally.get(tok);
      if (cur) { cur.count++; continue; }
      const label = tok.startsWith('id:') ? (plainOf(N(tok.slice(3))?.text || '').trim() || 'Untitled') : tok.slice(4);
      tally.set(tok, { label, count: 1 });
    }
  }

  // apply the active filter to the rows
  const inc = [], exc = [];
  for (const [tok, mode] of sel) (mode === 'include' ? inc : exc).push(tok);
  const filtered = (inc.length || exc.length)
    ? rows.filter(r => {
        if (r.html == null) return inc.length === 0;   // mirror rows carry no tags
        const toks = refRowTokens(r.html);
        return inc.every(t => toks.has(t)) && !exc.some(t => toks.has(t));
      })
    : rows;
  const built = buildRefGroups(target, filtered);

  const head = document.createElement('div');
  head.className = 'ref-head';
  const h = document.createElement('h3');
  const n = built ? built.count : 0;
  h.textContent = n ? `${n} Linked Reference${n === 1 ? '' : 's'}` : 'Linked References';
  head.append(h);
  if (tally.size) {
    const btn = document.createElement('button');
    btn.className = 'ref-filter-btn' + (sel.size ? ' active' : '');
    btn.innerHTML = icon('filter');
    btn.title = 'Filter references by tag';
    btn.addEventListener('click', () => { f.open = !f.open; rerender(); });
    head.append(btn);
  }
  container.append(head);

  if (f.open && tally.size) {
    const bar = document.createElement('div');
    bar.className = 'ref-filter-bar';
    for (const [tok, info] of [...tally.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 30)) {
      const chip = document.createElement('button');
      const mode = sel.get(tok);
      chip.className = 'ref-filter-chip' + (mode ? ' ' + mode : '');
      chip.textContent = info.label;
      const c = document.createElement('span');
      c.className = 'rfc-count';
      c.textContent = info.count;
      chip.append(c);
      chip.addEventListener('click', () => {
        const cur = sel.get(tok);
        if (!cur) sel.set(tok, 'include');
        else if (cur === 'include') sel.set(tok, 'exclude');
        else sel.delete(tok);
        rerender();
      });
      bar.append(chip);
    }
    container.append(bar);
  }

  if (!built) {
    const none = document.createElement('div');
    none.className = 'ref-none';
    none.textContent = sel.size ? 'No references match the filter.' : 'No linked references yet.';
    container.append(none);
  } else {
    container.append(built.el);
  }
  return hasBacklinks;
}

window.renderBacklinks = function renderBacklinks() {
  if (!doc || state.zoom === HOME || searchActive()) { backlinksEl.hidden = true; return; }
  const target = state.zoom;
  const rows = collectLinkedRefs(new Set([target])).get(target) || [];
  backlinksEl.hidden = false;
  backlinksEl.innerHTML = '';
  renderRefBlock(backlinksEl, target, rows, renderBacklinks);
  renderUnlinkedSection(target);
};

// the page's alias names (Aliases:: a, b, c — child attribute), min 2 chars each
function pageAliases(target) {
  const out = [];
  const a = window.attrsOf(target).get('aliases');
  if (!a) return out;
  for (const v of a.values) {
    for (const raw of v.value.split(',')) {
      const s = raw.replace(/^\[\[|\]\]$/g, '').trim();
      if (s.length >= 2) out.push(s);
    }
  }
  return out;
}

function renderUnlinkedSection(target) {
  const title = plainOf(N(target).text).trim();
  if (title.length < 3 && !pageAliases(target).length) return; // too short to mean anything in a text scan
  const box = document.createElement('div');
  box.className = 'unlinked-box';
  const head = document.createElement('h3');
  head.className = 'unlinked-head';
  head.innerHTML = '<span class="unlinked-caret">▸</span> Unlinked References';
  const body = document.createElement('div');
  body.className = 'unlinked-body';
  body.hidden = true;
  let scanned = false;
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.classList.toggle('open', !body.hidden);
    if (!scanned && !body.hidden) { scanned = true; fillUnlinked(body, target, title); }
  });
  box.append(head, body);
  backlinksEl.append(box);
}

// the O(doc) plain-text scan only runs when the section is expanded. Besides the page
// title (substring, as before), every Aliases:: name counts as a mention too — matched
// on WORD BOUNDARIES so a short alias like "HA" doesn't fire inside "Haben".
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const boundaryRe = s => new RegExp(`(^|[^\\p{L}\\p{N}])(${reEsc(s)})($|[^\\p{L}\\p{N}])`, 'iu');
function fillUnlinked(body, target, title) {
  const needle = title.toLowerCase();
  const aliasRes = pageAliases(target).map(a => ({ alias: a, re: boundaryRe(a) }));
  const rows = [];
  for (const id of Object.keys(doc.nodes)) {
    if (rows.length >= 50) break;
    if (id === target || isAncestor(target, id)) continue;
    const n = doc.nodes[id];
    if (n.mirror || n.cal) continue; // calendar titles ("July 14th, 2026") are noise, not mentions
    if ((n.text || '').includes('#/n/' + target)) continue; // already linked
    const plain = plainOf(n.text || '');
    let via = null;
    if (title.length >= 3 && plain.toLowerCase().includes(needle)) via = { needle: title, boundary: false };
    else {
      const hit = aliasRes.find(x => x.re.test(plain));
      if (hit) via = { needle: hit.alias, boundary: true };
    }
    if (!via) continue;
    rows.push({ id, plain: plain.trim(), via });
  }
  body.innerHTML = '';
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'ref-none';
    none.textContent = 'No unlinked mentions.';
    body.append(none);
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ref-row unlinked-row';
    const span = document.createElement('span');
    span.className = 'unlinked-text';
    span.textContent = r.plain.slice(0, 120);
    span.addEventListener('click', () => zoomTo(r.id));
    if (r.via.boundary) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = r.via.needle;   // which alias matched
      row.append(span, chip);
    } else {
      row.append(span);
    }
    const btn = document.createElement('button');
    btn.className = 'unlinked-link-btn';
    btn.textContent = 'Link';
    btn.addEventListener('click', () => {
      if (!linkifyMatch(r.id, target, r.via.needle, r.via.boundary)) showToast('Could not link this mention automatically');
    });
    row.append(btn);
    body.append(row);
  }
}

// wrap the first plain-text occurrence of the page title (or an alias — matched on word
// boundaries) in an internal link; the visible label keeps the original casing
function linkifyMatch(nodeId, pageId, needle, boundary = false) {
  const n = N(nodeId);
  if (!n || state.readOnly) return false;
  const tpl = document.createElement('template');
  tpl.innerHTML = n.text || '';
  const lower = needle.toLowerCase();
  const bre = boundary ? boundaryRe(needle) : null;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  let hit = null;
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t.parentElement?.closest('a')) continue; // never nest inside an existing link
    if (boundary) {
      const m = bre.exec(t.nodeValue);
      if (m) { hit = { t, idx: m.index + m[1].length }; break; }
    } else {
      const idx = t.nodeValue.toLowerCase().indexOf(lower);
      if (idx >= 0) { hit = { t, idx }; break; }
    }
  }
  if (!hit) return false; // e.g. the mention spans inline markup — leave it to the user
  snapshot();
  const rest = hit.t.splitText(hit.idx);
  rest.splitText(needle.length);
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + pageId);
  a.setAttribute('rel', 'noopener');
  a.textContent = rest.nodeValue; // keeps the original casing
  rest.replaceWith(a);
  recOld(nodeId);
  n.text = sanitizeHtml(tpl.innerHTML);
  touch(nodeId);
  markDirty();
  renderPage(); // the row migrates from Unlinked to Linked
  return true;
}

// one-time upgrade of legacy single-date <time> pills to real day-page links
// (date ranges keep their pill — they span days, not a single page)
function migrateDatePills() {
  let changed = false;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n.text || !n.text.includes('<time')) continue;
    const tpl = document.createElement('template');
    tpl.innerHTML = n.text;
    let touched = false;
    tpl.content.querySelectorAll('time[datetime]').forEach(t => {
      const dt = t.getAttribute('datetime');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return; // ranges (iso/iso2) stay pills
      t.replaceWith(dayLinkEl(dt));
      touched = true;
    });
    if (touched) { recOld(id); n.text = sanitizeHtml(tpl.innerHTML); n.m = Date.now(); changed = true; }
  }
  return changed;
}

// init() (app2.js) is async and still awaiting the doc when this file runs.
// One shared snapshot() wraps all migrations so recOld journals them and the ops
// actually persist (a snapshot-less mutation emits no op → is lost under opSync).
/* ---------------- Right sidebar: shift-click opens pages/blocks side-by-side ---------------- */

const RB_KEY = 'rhizome-rightbar';
const RB_OPEN_KEY = 'rhizome-rightbar-open';
function saveRb() {
  try {
    localStorage.setItem(RB_KEY, JSON.stringify(state.rightbar || []));
    localStorage.setItem(RB_OPEN_KEY, state.rightbarOpen ? '1' : '');
  } catch { /* private mode */ }
}

function rbTitle(id) {
  const n = N(id);
  if (n && n.cd) return roamDateLabel(n.cd);
  return plainOf(n?.text || '').trim() || 'Untitled';
}

// a page pane shows its title as a header + its children; a block pane shows the block itself
// (its text + subtree). Panes are FULLY editable — they reuse mountItem() and the shared editing
// machinery (see the shell-level listeners + the mountingSidebar elById guard in app.js).
function rbIsPage(id) {
  const n = N(id);
  return !!(n && (n.cal === 'day' || parentOf(id) === ROOT));
}

function rbEntry(id) {
  const box = document.createElement('div');
  box.className = 'rb-entry';
  const isPage = rbIsPage(id);

  const head = document.createElement('div');
  head.className = 'rb-head';
  const title = document.createElement('a');
  title.className = 'rb-title';
  title.href = '#/n/' + id;
  // page pane → its own title; block pane → the page it lives on, as context (the block text
  // itself is shown editable in the body, so repeating it in the header would be redundant)
  const ctxId = isPage ? id : (historyPageOf(id) || pageOf(id));
  title.textContent = rbTitle(ctxId && doc.nodes[ctxId] ? ctxId : id);
  const x = document.createElement('button');
  x.className = 'rb-x';
  x.title = 'Remove from sidebar';
  x.textContent = '×';
  x.addEventListener('click', () => closeInRightbar(id));
  head.append(title, x);
  box.append(head);

  const body = document.createElement('div');
  body.className = 'tree rb-tree';
  if (!settings.showCompleted) body.classList.add('hide-done');   // match the main view
  const mountIds = isPage ? kidsOf(contentIdOf(id)) : [id];
  for (const c of mountIds) body.append(mountItem(c, false));
  box.append(body);
  return box;
}

window.openInRightbar = function openInRightbar(id) {
  id = contentIdOf(id);
  if (!doc.nodes[id]) return;
  if (!Array.isArray(state.rightbar)) state.rightbar = [];
  if (!state.rightbar.includes(id)) state.rightbar.unshift(id);
  state.rightbarOpen = true;
  saveRb();
  window.renderRightbar();
};

// the top-right toggle: show/hide the sidebar (entries are kept when collapsed)
window.toggleRightbar = function toggleRightbar() {
  state.rightbarOpen = !state.rightbarOpen;
  saveRb();
  window.renderRightbar();
};

function closeInRightbar(id) {
  state.rightbar = (state.rightbar || []).filter(r => r !== id);
  saveRb();
  window.renderRightbar();
}

window.renderRightbar = function renderRightbar() {
  let bar = document.getElementById('right-sidebar');
  if (!bar) {
    bar = document.createElement('aside');
    bar.id = 'right-sidebar';
    bar.className = 'rightbar';
    document.querySelector('.shell')?.append(bar);
  }
  const ids = (state.rightbar || []).filter(id => doc && doc.nodes[id]);
  state.rightbar = ids;
  const open = !!state.rightbarOpen && !SHARE_TOKEN;
  document.body.classList.toggle('rightbar-open', open);
  const btn = document.getElementById('btn-rightbar');
  if (btn) { btn.classList.toggle('active', open); btn.setAttribute('aria-pressed', open ? 'true' : 'false'); }
  bar.innerHTML = '';
  if (!open) return;
  const head = document.createElement('div');
  head.className = 'rb-bar-head';
  const label = document.createElement('span');
  label.textContent = 'Sidebar';
  const collapse = document.createElement('button');
  collapse.className = 'rb-x';
  collapse.title = 'Close sidebar';
  collapse.textContent = '×';
  collapse.addEventListener('click', () => { state.rightbarOpen = false; saveRb(); window.renderRightbar(); });
  head.append(label, collapse);
  bar.append(head);
  if (!ids.length) {
    const empty = document.createElement('div');
    empty.className = 'rb-empty';
    empty.textContent = 'Shift-click a page link, block reference, or bullet to open it here.';
    bar.append(empty);
    return;
  }
  // mountItem() registers each row in the global elById map; the guard in app.js keeps a node's
  // MAIN-tree element authoritative while mountingSidebar is set, then we re-point elById at the
  // sidebar element for any node NOT currently in #tree, so caret restore after an edit/op lands
  // in the pane the user is actually typing in.
  window.mountingSidebar = true;
  try {
    for (const id of ids) bar.append(rbEntry(id));
  } finally {
    window.mountingSidebar = false;
  }
  const tree = document.getElementById('tree');
  for (const it of bar.querySelectorAll('.item[data-id]')) {
    const nid = it.dataset.id;
    if (!tree || !tree.querySelector(`.item[data-id="${nid}"]`)) elById.set(nid, it);
  }
};

// shift-click a page link or bullet → open it in the right sidebar instead of navigating
document.addEventListener('click', e => {
  if (!e.shiftKey || SHARE_TOKEN || !doc) return;
  const a = e.target.closest('a[href^="#/n/"]');
  const bullet = e.target.closest('.bullet');
  let id = null;
  if (a) { const m = a.getAttribute('href').match(/#\/n\/([A-Za-z0-9]+)/); id = m && m[1]; }
  else if (bullet) { id = bullet.closest('.item')?.dataset.id || null; }
  if (!id || !doc.nodes[id]) return;
  e.preventDefault();
  e.stopPropagation();
  window.openInRightbar(id);
}, true);

(function afterDocLoad() {
  if (!doc) { setTimeout(afterDocLoad, 100); return; }
  if (SHARE_TOKEN || state.readOnly) return;
  try { state.rightbar = JSON.parse(localStorage.getItem(RB_KEY) || '[]').filter(id => doc.nodes[id]); } catch { state.rightbar = []; }
  try { state.rightbarOpen = !!localStorage.getItem(RB_OPEN_KEY); } catch { state.rightbarOpen = false; }
  document.getElementById('btn-rightbar')?.addEventListener('click', () => window.toggleRightbar());
  window.renderRightbar();
  snapshot();
  let changed = false;
  changed = migrateDayLabels() || changed;
  changed = migrateDatePills() || changed;
  changed = migrateDupDatePages() || changed;
  changed = migrateWikiLinks() || changed;
  if (changed) { markDirty(); renderPage(); }
})();
