/* Quick-capture with file attachments: a shared PDF/image lands as a node carrying node.files,
   with optional "Quelle: <link>" inline-HTML sub-bullets (used by the iOS share sheet). */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const PORT = 3286, base = `http://localhost:${PORT}`, AGENT = 't';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-cf-'));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = { Authorization: 'Bearer ' + AGENT, 'Content-Type': 'application/json' };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_AGENT_TOKEN: AGENT }, stdio: ['ignore', 'ignore', 'inherit'] });

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }

  // a shared PDF: file attached, no caption, no sub-bullets
  const pdf = await J('/api/capture', { method: 'POST', headers: H, body: JSON.stringify({
    text: '', files: [{ url: '/files/deadbeef-report.pdf', name: 'report.pdf', type: 'application/pdf', size: 4096 }],
  }) });
  ok(pdf.body.captured === 1, 'PDF capture returns captured:1');

  // a shared web image: image attached + a "Quelle: <link>" source sub-bullet
  const img = await J('/api/capture', { method: 'POST', headers: H, body: JSON.stringify({
    text: '',
    files: [{ url: '/files/cafe1234-photo.jpg', name: 'photo.jpg', type: 'image/jpeg', size: 2048 }],
    children: ['Quelle: <a href="https://ex.com/pic.jpg" rel="noopener">ex.com</a><script>evil()</script>'],
  }) });
  ok(img.body.captured === 1, 'image capture returns captured:1');

  // a bad file url is rejected (safeFileUrl filters it) → nothing captured
  const bad = await J('/api/capture', { method: 'POST', headers: H, body: JSON.stringify({
    text: '', files: [{ url: 'javascript:alert(1)', name: 'x' }],
  }) });
  ok(bad.body.captured === 0, 'file with an unsafe url captures nothing');

  const doc = (await J('/api/v1/doc', { headers: H })).body.doc;
  const nodes = doc.nodes;
  const findByFileUrl = u => Object.values(nodes).find(n => (n.files || []).some(f => f.url === u));

  const pdfNode = findByFileUrl('/files/deadbeef-report.pdf');
  ok(pdfNode && pdfNode.files.length === 1, 'PDF node carries node.files');
  ok(pdfNode && pdfNode.files[0].name === 'report.pdf' && pdfNode.files[0].type === 'application/pdf', 'PDF file metadata preserved');

  const imgNode = findByFileUrl('/files/cafe1234-photo.jpg');
  ok(imgNode && imgNode.files.length === 1, 'image node carries node.files');
  const child = imgNode && (imgNode.children || []).map(id => nodes[id]).find(n => /Quelle:/.test(n.text || ''));
  ok(child && /<a href="https:\/\/ex\.com\/pic\.jpg"/.test(child.text), 'image has a "Quelle: <link>" sub-bullet');
  ok(child && !/<script/i.test(child.text), 'sub-bullet HTML is sanitized (no <script>)');

  // both attachment nodes live under the Inbox bullet of today's journal
  const inbox = Object.values(nodes).find(n => (n.text || '').replace(/<[^>]+>/g, '').trim() === 'Inbox');
  ok(inbox && inbox.children.includes(pdfNode?.id) && inbox.children.includes(imgNode?.id), 'attachments land under Inbox');

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll capture-files tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
