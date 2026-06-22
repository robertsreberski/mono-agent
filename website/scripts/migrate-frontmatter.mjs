// One-off: convert just-the-docs front-matter -> Starlight schema, in place.
//   - keep `title`
//   - `nav_order: N` -> `sidebar: { order: N }` (index.md pages -> order 0, so the
//     section overview sorts first; section ordering itself comes from astro.config)
//   - drop `parent`, `has_children`, `permalink`
// Idempotent: files already carrying a `sidebar:` key are skipped.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const SKIP_DIRS = new Set(['superpowers', 'skills']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function transform(text, file) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return null;
  const fmLines = lines.slice(1, end);
  if (fmLines.some((l) => /^sidebar:/.test(l))) return null; // already migrated
  const body = lines.slice(end + 1).join('\n');

  let title = null;
  let navOrder = null;
  for (const line of fmLines) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'title') title = m[2];
    else if (m[1] === 'nav_order') navOrder = parseInt(m[2], 10);
    // parent / has_children / permalink are intentionally dropped
  }

  const order = basename(file) === 'index.md' ? 0 : navOrder;
  const fm = ['---'];
  if (title !== null) fm.push(`title: ${title}`);
  if (Number.isInteger(order)) fm.push('sidebar:', `  order: ${order}`);
  fm.push('---');
  return fm.join('\n') + '\n' + body;
}

let changed = 0;
for (const file of walk(DOCS)) {
  const text = readFileSync(file, 'utf8');
  const next = transform(text, file);
  if (next && next !== text) {
    writeFileSync(file, next);
    changed++;
  }
}
console.log(`front-matter: rewrote ${changed} file(s)`);
