// EXHAUSTIVE typing stress test: drives the editor with REAL keystrokes across many scenarios
// (fast/slow typing, saves firing mid-word, multi-bullet bursts, edits, blur, split, notes,
// unicode, punctuation) and asserts that what reached the SERVER equals what was typed — i.e. no
// character is ever lost. Fresh server + real Chrome (headless).
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-ts-')); const PORT = 3284; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, pass = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); c ? pass++ : fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const plainOf = h => h == null ? null : h.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

(async () => {
  let ck, gid, p, b;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;

  b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/outline', { waitUntil: 'domcontentloaded' }); await sleep(1200);

  // ---- helpers ----
  const fetchDoc = async () => (await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json()).doc;
  const docText = async id => {
    const d = await fetchDoc();
    return plainOf(d.nodes[id]?.text ?? null);
  };
  const childOf = (doc, parent, child) => (doc.nodes[parent]?.children || []).includes(child);
  const settle = async () => {
    await p.evaluate(() => doSave());
    for (let i = 0; i < 60; i++) {
      const st = await p.evaluate(() => ({ d: dirty, q: pendingOps.length, s: saving }));
      if (!st.d && st.q === 0 && !st.s) break;
      await sleep(100);
    }
    await sleep(120);
  };
  // create a fresh empty bullet at the top of the current page, focused with the caret at the end
  const newBullet = async () => p.evaluate(() => {
    const nid = opNewAt(state.zoom, 0);
    const el = document.querySelector(`.item[data-id="${nid}"] .content`);
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return nid;
  });
  const focusEnd = async id => p.evaluate(i => {
    const el = document.querySelector(`.item[data-id="${i}"] .content`);
    el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, id);
  const activeId = async () => p.evaluate(() => document.activeElement?.closest('.item')?.dataset.id || null);

  // type into a fresh bullet, settle, assert stored == typed
  const scenario = async (name, text, opts = {}) => {
    const id = await newBullet();
    if (opts.forceEvery) {
      for (let i = 0; i < text.length; i++) {
        await p.keyboard.type(text[i], { delay: opts.delay || 0 });
        if ((i + 1) % opts.forceEvery === 0) await p.evaluate(() => doSave());
      }
    } else {
      await p.keyboard.type(text, { delay: opts.delay || 0 });
    }
    if (opts.blurNow) { await p.evaluate(() => document.getElementById('zoom-title')?.focus()); }
    await settle();
    const stored = await docText(id);
    ok(stored === text, `${name}: stored ${JSON.stringify(stored)} === typed ${JSON.stringify(text)}`);
    return id;
  };

  // ---- 1. basic lengths & speeds ----
  await scenario('single char', 'A');
  await scenario('short word (instant)', 'Queries', { delay: 0 });
  await scenario('short word (30ms/key)', 'Queries', { delay: 30 });
  await scenario('sentence w/ spaces', 'The quick brown fox jumps over the lazy dog', { delay: 5 });
  await scenario('100 chars', 'x'.repeat(100));
  await scenario('mixed case + digits', 'AbC123xyzQWERTY7890', { delay: 10 });

  // ---- 2. the killer: a save fires mid-word ----
  await scenario('force save after EVERY char', 'Queries', { forceEvery: 1 });
  await scenario('force save every char (long)', 'abcdefghijklmnopqrst', { forceEvery: 1 });
  await scenario('force save every 2 chars', 'DatalossMustNeverHappen', { forceEvery: 2, delay: 5 });
  await scenario('force save every 3 chars', 'The quick brown fox', { forceEvery: 3, delay: 5 });

  // ---- 3. slow typing so the 600ms debounce fires naturally between keystrokes ----
  await scenario('slow typing (700ms/key)', 'sync', { delay: 700 });
  await scenario('slow typing longer (650ms)', 'persist', { delay: 650 });

  // ---- 4. append / edit existing bullets ----
  {
    const id = await scenario('base for append', 'hello');
    await focusEnd(id); await p.keyboard.type(' world', { delay: 5 }); await settle();
    ok(await docText(id) === 'hello world', 'append to existing: "hello world"');
    // append again with a forced save each char (letters — avoid the "!!" date shortcut)
    await focusEnd(id);
    for (const c of 'DONE') { await p.keyboard.type(c); await p.evaluate(() => doSave()); }
    await settle();
    ok(await docText(id) === 'hello worldDONE', 'append w/ save each char: "hello worldDONE"');
  }

  // ---- 5. prepend + middle insert ----
  {
    const id = await scenario('base for prepend', 'world');
    await p.evaluate(i => { const el = document.querySelector(`.item[data-id="${i}"] .content`); el.focus(); const r = document.createRange(); r.setStart(el.firstChild || el, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, id);
    await p.keyboard.type('hello ', { delay: 5 }); await settle();
    ok(await docText(id) === 'hello world', 'prepend: "hello world"');
  }

  // ---- 6. backspace edits ----
  {
    const id = await scenario('base for backspace', 'hellothere');
    await focusEnd(id);
    for (let i = 0; i < 5; i++) await p.keyboard.press('Backspace');
    await settle();
    ok(await docText(id) === 'hello', 'backspace 5: "hello"');
  }

  // ---- 7. type then IMMEDIATELY blur (no wait) ----
  await scenario('type then blur immediately', 'BlurFlushWorks', { blurNow: true });

  // ---- 8. Enter split: type, Enter (new bullet), type in the new one ----
  {
    const id1 = await newBullet();
    await p.keyboard.type('firstline', { delay: 5 });
    await p.keyboard.press('Enter');
    await sleep(150);
    const id2 = await activeId();
    await p.keyboard.type('secondline', { delay: 5 });
    await settle();
    ok(await docText(id1) === 'firstline', 'split: first bullet intact "firstline"');
    ok(id2 && await docText(id2) === 'secondline', 'split: second bullet "secondline"');
  }

  // ---- 9. rapid multi-bullet burst: create + type 6 bullets with NO settle between ----
  {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const ids = [];
    for (const w of words) { const id = await newBullet(); await p.keyboard.type(w, { delay: 2 }); ids.push([id, w]); }
    await settle();
    for (const [id, w] of ids) ok(await docText(id) === w, `rapid burst: "${w}" intact`);
  }

  // ---- 10. note field ----
  {
    const id = await scenario('bullet for note', 'has a note');
    await p.evaluate(i => { window.__noteId = i; opAddNote(editableCtx(document.querySelector(`.item[data-id="${i}"] .content`))); }, id);
    await sleep(200);
    const noteEl = await p.$(`.item[data-id="${id}"] .note`);
    if (noteEl) {
      await noteEl.focus();
      await p.keyboard.type('a detailed annotation', { delay: 5 });
      await settle();
      const d = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
      ok((d.doc.nodes[id]?.note || '') === 'a detailed annotation', 'note field: text synced');
    } else { ok(false, 'note field: could not open note'); }
  }

  // ---- 11. unicode / emoji / punctuation ----
  await scenario('unicode + accents', 'café über ñoño Grüße');
  await scenario('cjk', '日本語のテキスト 中文字符');
  await scenario('emoji', 'ship it 🚀🔥✅ done');
  await scenario('punctuation', "It's a test, right? (yes!) 50% — a/b + c");

  // ---- 12. HTML-special chars (must round-trip, escaped in storage but same plain) ----
  await scenario('angle brackets & amp', 'a < b && c > d');

  // ---- 12b. nesting: build parent → child → grandchild with Tab (indent), text must survive ----
  {
    const pid = await newBullet(); await p.keyboard.type('parent node', { delay: 3 });
    await p.keyboard.press('Enter'); await sleep(120);
    await p.keyboard.press('Tab'); await sleep(120);           // indent → child of parent
    const cid = await activeId(); await p.keyboard.type('child node', { delay: 3 });
    await p.keyboard.press('Enter'); await sleep(120);
    await p.keyboard.press('Tab'); await sleep(120);           // indent → grandchild
    const g2 = await activeId(); await p.keyboard.type('grandchild node', { delay: 3 });
    await settle();
    ok(await docText(pid) === 'parent node', 'nest: parent text intact');
    ok(await docText(cid) === 'child node', 'nest: child text intact');
    ok(await docText(g2) === 'grandchild node', 'nest: grandchild text intact');
    let d = await fetchDoc();
    ok(childOf(d, pid, cid), 'nest: child is under parent');
    ok(childOf(d, cid, g2), 'nest: grandchild is under child');

    // outdent the grandchild (Shift+Tab) → becomes a child of parent; text must survive the move
    await p.evaluate(i => { const el = document.querySelector(`.item[data-id="${i}"] .content`); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, g2);
    await p.keyboard.down('Shift'); await p.keyboard.press('Tab'); await p.keyboard.up('Shift'); await sleep(150);
    await settle();
    d = await fetchDoc();
    ok(await docText(g2) === 'grandchild node', 'outdent: text intact after outdent');
    ok(childOf(d, pid, g2) && !childOf(d, cid, g2), 'outdent: moved up to parent');

    // append to a child AFTER structural ops (regression: edits after move must still sync)
    await p.evaluate(i => { const el = document.querySelector(`.item[data-id="${i}"] .content`); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, cid);
    await p.keyboard.type(' EDITED', { delay: 3 }); await settle();
    ok(await docText(cid) === 'child node EDITED', 'edit after structural ops still syncs');
  }

  // ---- 12c. delete a bullet, then add a new one and type ----
  {
    const del = await newBullet(); await p.keyboard.type('to be deleted', { delay: 3 }); await settle();
    ok(await docText(del) === 'to be deleted', 'delete: bullet created');
    await p.evaluate(i => opDelete(i), del); await settle();
    let d = await fetchDoc();
    ok(!d.nodes[del] || (d.trash || []).some(t => t.id === del) || !childOf(d, d.nodes[del]?.parent, del), 'delete: gone from the live tree');
    // re-add and type — must sync cleanly
    const re = await newBullet(); await p.keyboard.type('re-added after delete', { delay: 3 }); await settle();
    ok(await docText(re) === 're-added after delete', 'delete then re-add: new bullet syncs');
  }

  // ---- 12d. indent an existing bullet with content, then keep typing ----
  {
    const a = await newBullet(); await p.keyboard.type('anchor', { delay: 3 });
    await p.keyboard.press('Enter'); await sleep(120);
    const bId = await activeId(); await p.keyboard.type('will indent', { delay: 3 });
    await p.keyboard.press('Tab'); await sleep(150);                     // indent under 'anchor'
    await p.keyboard.type(' and more', { delay: 3 });                   // keep typing after indent
    await settle();
    const d = await fetchDoc();
    ok(await docText(bId) === 'will indent and more', 'indent-then-type: full text synced');
    ok(childOf(d, a, bId), 'indent-then-type: nested under anchor');
  }

  // ---- 13. reload persistence: everything above must survive a fresh load ----
  {
    const before = await scenario('survives reload', 'ReloadProof');
    await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500);
    ok(await docText(before) === 'ReloadProof', 'reload: bullet still on server');
  }

  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? 'DATA-LOSS / FAILURES DETECTED' : 'All typing-stress scenarios passed — no data loss');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
