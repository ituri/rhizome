'use strict';
/*
 * At-rest encryption for the artifacts that leave the machine — backups (shipped to
 * the Hetzner Storage Box) and uploaded files. AES-256-GCM with a server-held key
 * derived from RHIZOME_ENCRYPTION_KEY. Zero dependencies (node:crypto only).
 *
 * The live SQLite DB stays plaintext on purpose: FTS5 needs a plaintext index and
 * node:sqlite can't open an encrypted file. This module protects the *copies* — a
 * stolen backup or files/ directory is ciphertext without the key, which is not in
 * the DATA_DIR volume (so it never rides along in a backup).
 *
 * Format:  "RZE1" magic (4) | iv (12) | authTag (16) | ciphertext.
 * decrypt() and isEncrypted() pass plaintext through untouched, so turning the key
 * on for the first time keeps every pre-existing plaintext backup/file readable, and
 * new writes get encrypted going forward.
 */
const crypto = require('crypto');

const MAGIC = Buffer.from('RZE1');
const PASS = process.env.RHIZOME_ENCRYPTION_KEY || '';
// Derive a 32-byte key from the passphrase. A fixed salt only domain-separates here;
// the secret is the passphrase itself, which never leaves the server.
const KEY = PASS ? crypto.scryptSync(PASS, 'rhizome-at-rest-v1', 32) : null;

function enabled() { return !!KEY; }

function isEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 32 && buf.subarray(0, 4).equals(MAGIC);
}

function encrypt(plain) {
  const buf = Buffer.isBuffer(plain) ? plain : Buffer.from(plain);
  if (!KEY) return buf; // encryption off → write plaintext, exactly as before
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

function decrypt(buf) {
  if (!isEncrypted(buf)) return buf; // plaintext artifact (pre-encryption, or key off)
  if (!KEY) throw new Error('RHIZOME_ENCRYPTION_KEY is required to decrypt this data');
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const ct = buf.subarray(32);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]); // throws on a wrong key / tampering
}

module.exports = { enabled, isEncrypted, encrypt, decrypt };

// CLI restore helper:  RHIZOME_ENCRYPTION_KEY=… node cryptobox.js <in.enc> <out>
if (require.main === module) {
  const [, , inFile, outFile] = process.argv;
  if (!inFile || !outFile) { console.error('usage: RHIZOME_ENCRYPTION_KEY=… node cryptobox.js <in> <out>'); process.exit(2); }
  if (!KEY) { console.error('set RHIZOME_ENCRYPTION_KEY'); process.exit(2); }
  const fs = require('fs');
  fs.writeFileSync(outFile, decrypt(fs.readFileSync(inFile)));
  console.log(`decrypted ${inFile} → ${outFile}`);
}
