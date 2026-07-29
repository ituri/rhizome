// One-off: vendor Google Fonts locally so the app loads no external fonts and runs self-contained.
// Fetches the CSS2 for Inter + Newsreader, keeps the latin / latin-ext subsets, downloads each
// woff2 into public/fonts/, and writes public/fonts/fonts.css pointing at the local files.
import { mkdir, writeFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700'
  + '&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400;1,6..72,500&display=swap';
const KEEP = new Set(['latin', 'latin-ext']);
const OUT = new URL('../public/fonts/', import.meta.url);

const css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text();
await mkdir(OUT, { recursive: true });

// each face is preceded by a "/* subset */" comment
const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)];
const out = [];
const seen = new Set();
for (const [, subset, block] of blocks) {
  if (!KEEP.has(subset)) continue;
  const fam = /font-family:\s*'([^']+)'/.exec(block)[1];
  const style = /font-style:\s*(\w+)/.exec(block)[1];
  const weight = /font-weight:\s*([\d ]+)/.exec(block)[1].trim();
  const range = /unicode-range:\s*([^;]+);/.exec(block)[1].trim();
  const url = /url\(([^)]+)\)/.exec(block)[1];
  const file = `${fam}-${weight.replace(/ /g, '_')}-${style}-${subset}.woff2`.toLowerCase().replace(/\s+/g, '');
  if (!seen.has(file)) {
    seen.add(file);
    const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
    await writeFile(new URL(file, OUT), buf);
    console.log(`  ${file}  (${(buf.length / 1024).toFixed(1)} KB)`);
  }
  out.push(`/* ${fam} ${weight} ${style} — ${subset} */\n@font-face {\n  font-family: '${fam}';\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(/fonts/${file}) format('woff2');\n  unicode-range: ${range};\n}`);
}
const header = '/* Self-hosted fonts (Inter, Newsreader — SIL OFL). Vendored from Google Fonts so the\n'
  + '   app loads no external resources. Regenerate with: node tools/vendor-fonts.mjs */\n\n';
await writeFile(new URL('fonts.css', OUT), header + out.join('\n\n') + '\n');
console.log(`\nwrote public/fonts/fonts.css with ${out.length} @font-face rules, ${seen.size} files`);
