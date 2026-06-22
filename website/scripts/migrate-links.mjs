// One-off: rewrite relative `*.md` links -> root-relative Starlight routes, in place.
//   ](install.md)            from getting-started/  -> ](/getting-started/install/)
//   ](../config/index.md)                            -> ](/config/)
//   ](../feature-registry.md)                        -> ](/reference/feature-registry/)  (moved file)
// Absolute (http/mailto), in-page anchors, and root-relative links are left as-is.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const SKIP_DIRS = new Set(['superpowers', 'skills']);

// Files that moved out of docs/ root into a section directory: map their old
// docs-relative path to the new route so inbound links resolve correctly.
const RENAME = { 'feature-registry.md': '/reference/feature-registry/' };

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

function toRoute(docsRel) {
  if (RENAME[docsRel]) return RENAME[docsRel];
  let p = docsRel.replace(/\.md$/, '');
  p = p.replace(/(^|\/)index$/, '$1'); // index -> directory root
  let route = '/' + p;
  if (!route.endsWith('/')) route += '/';
  return route.replace(/\/{2,}/g, '/');
}

function rewriteLine(line, fileDir, onHit) {
  return line.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (whole, url, title) => {
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) return whole; // external / anchor / absolute
    const hashIdx = url.indexOf('#');
    const pathPart = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
    if (!pathPart.endsWith('.md')) return whole;
    const base = fileDir === '.' ? '' : fileDir;
    const docsRel = posix.normalize(posix.join(base, pathPart));
    onHit();
    return `](${toRoute(docsRel)}${hash}${title})`;
  });
}

function transform(text, fileDocsRel) {
  const fileDir = posix.dirname(fileDocsRel);
  let count = 0;
  let fence = false;
  const out = text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    return fence ? line : rewriteLine(line, fileDir, () => count++);
  });
  return { text: out.join('\n'), count };
}

let files = 0;
let links = 0;
for (const file of walk(DOCS)) {
  const rel = relative(DOCS, file).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  const { text: next, count } = transform(text, rel);
  if (count > 0 && next !== text) {
    writeFileSync(file, next);
    files++;
    links += count;
  }
}
console.log(`links: rewrote ${links} link(s) across ${files} file(s)`);
