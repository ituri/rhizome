/* Off-thread JSON serialization. The main thread posts a payload; the worker stringifies
   it (the potentially-large, blocking part) and posts the string back — so exporting a
   100k-node document doesn't freeze the UI during serialization.
   (Route B already moved the interactive *save* body off the whole-doc path — it sends ops
   — so this worker is for the remaining user-initiated whole-doc serialize: export.) */
self.onmessage = e => {
  const { id, payload, indent } = e.data || {};
  try {
    self.postMessage({ id, json: JSON.stringify(payload, null, indent || 0) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
