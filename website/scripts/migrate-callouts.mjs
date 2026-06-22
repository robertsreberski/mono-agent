// One-off: convert just-the-docs Kramdown callouts -> Starlight asides, in place.
// The marker `{: .note }` sits AFTER the paragraph it styles, e.g.
//     Some text.
//     {: .warning }
// becomes
//     :::caution
//     Some text.
//     :::
// Markers inside fenced code blocks are left untouched.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const SKIP_DIRS = new Set(['superpowers', 'skills']);
const TYPE = { note: 'note', tip: 'tip', warning: 'caution', important: 'danger' };
const MARKER = /^\{:\s*\.(note|tip|warning|important)\s*\}\s*$/;

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

function transform(text) {
  const out = [];
  let fence = false;
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(MARKER);
    if (m) {
      const block = [];
      while (out.length && out[out.length - 1].trim() !== '') block.unshift(out.pop());
      out.push(`:::${TYPE[m[1]]}`, ...block, ':::');
      count++;
    } else {
      out.push(line);
    }
  }
  return { text: out.join('\n'), count };
}

let files = 0;
let callouts = 0;
for (const file of walk(DOCS)) {
  const text = readFileSync(file, 'utf8');
  const { text: next, count } = transform(text);
  if (count > 0 && next !== text) {
    writeFileSync(file, next);
    files++;
    callouts += count;
  }
}
console.log(`callouts: converted ${callouts} aside(s) across ${files} file(s)`);
