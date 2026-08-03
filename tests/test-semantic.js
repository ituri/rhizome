/* Semantic search: local embedding index + cosine ranking.
   Runs against a MOCK embedder (a tiny deterministic bag-of-words vectoriser) so the suite
   stays hermetic — the real embedder is a llama.cpp container. Self-spawning server. */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3241, EMB_PORT = 3242;
const base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-sem-'));
let fl = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* A mock embedder: each of DIMS concept buckets is a keyword group; a text's vector counts
   how many words of each group it contains. Semantically related texts share buckets, so
   cosine ranking behaves like the real thing without any model. */
const BUCKETS = [
  ['akku', 'batterie', 'speicher', 'strom', 'solar', 'balkonkraftwerk', 'b2500'],
  ['hütte', 'unterkunft', 'übernachtung', 'hotel', 'norwegen', 'rasjahytta', 'kokelv'],
  ['funk', 'antenne', 'sota', 'gipfel', 'efhw', 'amateurfunk'],
  ['kochen', 'rezept', 'essen', 'nudeln', 'pizza'],
];
let docEmbeds = 0;   // document embeddings only — queries carry the query prefix
const vectorize = t => {
  const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const v = BUCKETS.map(b => words.filter(w => b.includes(w)).length);
  v.push(0.01); // keep the zero vector out of the index
  return v;
};
const embSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const input = (JSON.parse(body || '{}').input || []);
    docEmbeds += input.filter(t => !t.startsWith('query: ')).length;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: vectorize(t) })) }));
  });
});

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1',
    RHIZOME_EMBEDDINGS_URL: `http://127.0.0.1:${EMB_PORT}`, RHIZOME_EMBED_QUERY_PREFIX: 'query: ' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const J = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json().catch(() => null) }; };

(async () => {
  await new Promise(r => embSrv.listen(EMB_PORT, r));
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/me'); break; } catch { await sleep(200); } }

  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['p1', 'p2', 'p3'] },
    p1: { id: 'p1', text: 'Energie', children: ['n1', 'n2'] },
    n1: { id: 'n1', text: 'B2500 Speicher am Balkonkraftwerk angeschlossen', children: [] },
    n2: { id: 'n2', text: 'Solar Ertrag war heute mies', children: [] },
    p2: { id: 'p2', text: 'Reise', children: ['n3'] },
    n3: { id: 'n3', text: 'Übernachtung in der Hütte bei Kokelv gebucht', children: [] },
    p3: { id: 'p3', text: 'Hobby', children: ['n4', 'n5'] },
    n4: { id: 'n4', text: 'EFHW Antenne für den SOTA Gipfel gebaut', children: [] },
    n5: { id: 'n5', text: 'kurz', children: [] },   // too short → never indexed
  } };
  await J('/api/g/default/doc', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc }) });

  // the index arms itself ~4s after a commit; wait for it to settle
  let indexed = 0;
  for (let i = 0; i < 40; i++) {
    const r = await J('/api/g/default/semantic?q=');
    indexed = r.body?.indexed || 0;
    if (indexed >= 4) break;
    await sleep(500);
  }
  // exactly the four bullets with enough text; short titles/bullets are skipped by design
  ok(indexed === 4, `the index builds itself after a commit (${indexed} vectors)`);
  const afterFirst = docEmbeds;

  // meaning, not keywords: none of these query words appear in the target text
  let r = await J('/api/g/default/semantic?q=Akku%20Batterie&limit=3');
  ok(r.status === 200 && r.body.results[0]?.id === 'n1',
    `"Akku Batterie" finds the B2500 note (${r.body.results?.map(x => x.id).join(',')})`);

  // a query unrelated to everything indexed returns NOTHING — cosine always ranks something
  // first, so the score floor is what keeps noise out of the results
  r = await J('/api/g/default/semantic?q=Steuererkl%C3%A4rung%20Finanzamt&limit=3');
  ok(r.body.results.length === 0, `an unrelated query returns no results (${r.body.results.length})`);
  r = await J('/api/g/default/semantic?q=Unterkunft&limit=3');
  ok(r.body.results[0]?.id === 'n3', `"Unterkunft" finds the Hütte note (${r.body.results?.map(x => x.id).join(',')})`);

  r = await J('/api/g/default/semantic?q=Amateurfunk&limit=3');
  ok(r.body.results[0]?.id === 'n4', `"Amateurfunk" finds the antenna note (${r.body.results?.map(x => x.id).join(',')})`);

  ok(r.body.results.every(x => typeof x.score === 'number'), 'results carry a similarity score');
  ok(!r.body.results.some(x => x.id === 'n5'), 'very short bullets stay out of the index');

  // incremental: re-indexing without changes must not call the embedder again
  await J('/api/g/default/semantic', { method: 'POST' });
  await sleep(1200);
  ok(docEmbeds === afterFirst, `re-index of unchanged content embeds nothing (${docEmbeds - afterFirst} extra document calls)`);

  // a changed node is re-embedded, a deleted one drops out
  const doc2 = JSON.parse(JSON.stringify(doc));
  doc2.nodes.n2.text = 'Pizza mit Nudeln gekocht, Rezept notiert';
  delete doc2.nodes.n4;
  doc2.nodes.p3.children = ['n5'];
  await J('/api/g/default/doc', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: doc2 }) });
  for (let i = 0; i < 40; i++) { await sleep(500); const c = (await J('/api/g/default/semantic?q=')).body.indexed; if (c === 5) break; }
  r = await J('/api/g/default/semantic?q=Rezept%20essen&limit=2');
  ok(r.body.results[0]?.id === 'n2', `the edited node re-embeds to its new meaning (${r.body.results?.map(x => x.id).join(',')})`);
  r = await J('/api/g/default/semantic?q=Amateurfunk&limit=5');
  ok(!r.body.results.some(x => x.id === 'n4'), 'a deleted node leaves the index');

  console.log(fl ? `\n${fl} SEMANTIC TESTS FAILING` : '\nSEMANTIC TESTS PASSED');
  srv.kill(); embSrv.close();
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); embSrv.close(); process.exit(2); });
