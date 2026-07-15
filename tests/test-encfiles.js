/* At-rest encryption integration test (pure node). Start the server with:
 *   RHIZOME_ENCRYPTION_KEY=<same> RHIZOME_BACKUP_EVERY_MS=0 PORT=3219 DATA_DIR=<fresh>
 * and run this with the SAME key + DATA_DIR in the env.
 */
process.env.RHIZOME_ENCRYPTION_KEY = process.env.RHIZOME_ENCRYPTION_KEY || 'enc-integration-key';
const fs = require('fs');
const path = require('path');
const box = require('../cryptobox');

const base = `http://localhost:${process.env.PORT || 3219}`;
const DATA = process.env.DATA_DIR;
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  assert(box.enabled(), 'the test runs with encryption enabled');

  // --- upload: the stored file must be ciphertext on disk, but serve plaintext ---
  const payload = 'top secret payload \u{1F510} ' + 'x'.repeat(500);
  const up = await fetch(base + '/api/upload?name=secret.txt', { method: 'POST', body: payload });
  assert(up.status === 200, 'upload accepted');
  const stored = path.basename(decodeURIComponent((await up.json()).url));

  const onDisk = fs.readFileSync(path.join(DATA, 'files', stored));
  assert(box.isEncrypted(onDisk), 'the uploaded file is encrypted at rest (RZE1 on disk)');
  assert(!onDisk.toString('utf8').includes('secret payload'), 'the plaintext does not appear on disk');

  const served = await fetch(base + '/files/' + encodeURIComponent(stored));
  assert(served.status === 200, 'the file is served back');
  assert((await served.text()) === payload, 'served bytes decrypt back to the original');

  // --- backup: a commit triggers an at-rest-encrypted snapshot that decrypts to a real DB ---
  const cap = await fetch(base + '/api/capture', { method: 'POST', body: 'encbackup marker' });
  assert(cap.status === 200, 'capture (which triggers a backup) succeeds');
  await sleep(300);
  const backupDir = path.join(DATA, 'graphs', 'default', 'backups');
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.endsWith('.db')) : [];
  assert(backups.length > 0, 'a backup snapshot was written');
  if (backups.length) {
    const raw = fs.readFileSync(path.join(backupDir, backups[0]));
    assert(box.isEncrypted(raw), 'the backup is encrypted at rest');
    const plain = box.decrypt(raw);
    assert(plain.subarray(0, 16).toString() === 'SQLite format 3\0', 'the decrypted backup is a valid SQLite database');
  }
  assert(!fs.existsSync(path.join(backupDir, path.basename(backups[0] || 'x') + '.plain')), 'no plaintext temp is left behind');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nENC-FILES TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
