/* At-rest encryption module test (pure node). Run with a key in the env:
 *   RHIZOME_ENCRYPTION_KEY=testpass node tests/test-crypto.js
 */
process.env.RHIZOME_ENCRYPTION_KEY = process.env.RHIZOME_ENCRYPTION_KEY || 'test-passphrase-123';
const crypto = require('crypto');
const box = require('../cryptobox');

let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

// a random binary payload (like a real upload / DB file)
const plain = crypto.randomBytes(4096);

assert(box.enabled(), 'encryption is enabled when a key is set');

const enc = box.encrypt(plain);
assert(Buffer.isBuffer(enc) && !enc.equals(plain), 'encrypt() changes the bytes');
assert(enc.subarray(0, 4).toString() === 'RZE1', 'ciphertext carries the RZE1 magic header');
assert(box.isEncrypted(enc) && !box.isEncrypted(plain), 'isEncrypted() distinguishes cipher from plaintext');

const dec = box.decrypt(enc);
assert(Buffer.isBuffer(dec) && dec.equals(plain), 'decrypt(encrypt(x)) round-trips exactly');

// unique IV per call → same input encrypts differently, but both decrypt back
const enc2 = box.encrypt(plain);
assert(!enc.equals(enc2), 'each encryption uses a fresh IV (ciphertexts differ)');
assert(box.decrypt(enc2).equals(plain), 'the second ciphertext also decrypts');

// tamper detection (GCM auth tag)
const tampered = Buffer.from(enc); tampered[tampered.length - 1] ^= 0xff;
let threw = false; try { box.decrypt(tampered); } catch { threw = true; }
assert(threw, 'a tampered ciphertext fails authentication (throws)');

// backward compatibility: plaintext passes through decrypt untouched
assert(box.decrypt(plain).equals(plain), 'pre-encryption plaintext passes through decrypt()');

// a different key cannot decrypt (verified via a child require with a fresh env)
const { execFileSync } = require('child_process');
const script = `const b=require('${require.resolve('../cryptobox')}');` +
  `const buf=Buffer.from(${JSON.stringify([...enc])});` +
  `try{b.decrypt(buf);process.exit(0)}catch{process.exit(3)}`;
let wrongKeyRejected = false;
try { execFileSync(process.execPath, ['-e', script], { env: { ...process.env, RHIZOME_ENCRYPTION_KEY: 'a-totally-different-key' } }); }
catch (e) { wrongKeyRejected = e.status === 3; }
assert(wrongKeyRejected, 'a different key cannot decrypt the data');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nCRYPTO TESTS PASSED');
process.exit(failures ? 1 : 0);
