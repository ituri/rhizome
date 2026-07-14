'use strict';
// The client is two <script> files (app.js, app2.js) sharing ONE global scope —
// no imports/exports. So every top-level name in one file is a global the other
// may reference. We extract them here (recomputed each lint run, never stale) so
// `no-undef` understands the cross-file globals instead of false-flagging them.
const fs = require('fs');
const path = require('path');

function topLevelNames(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const names = new Set();
  // column-0 declarations + window.X = … exports
  const re = /^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)|^window\.([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = re.exec(src))) names.add(m[1] || m[2]);
  return names;
}

const shared = new Set([...topLevelNames('public/app.js'), ...topLevelNames('public/app2.js'), ...topLevelNames('public/pages.js')]);
module.exports = Object.fromEntries([...shared].map(n => [n, 'writable']));
