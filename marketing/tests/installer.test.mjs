import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = name => readFileSync(new URL(name, import.meta.url));
test('installer is a byte-exact static file, not an HTML page fallback', () => {
  const source = read('../public/install.sh');
  assert.deepEqual(read('../dist/install.sh'), source);
  assert.match(source.toString(), /^#!\/bin\/sh\n/);
  assert.ok(!existsSync(new URL('../dist/install.sh/index.html', import.meta.url)));
  const checksum = `${createHash('sha256').update(source).digest('hex')}  install.sh\n`;
  assert.equal(read('../dist/install.sh.sha256').toString(), checksum);
});
test('extension routes keep exact plain-text security/cache headers without redirects or rewrites', () => {
  const config = JSON.parse(read('../vercel.json'));
  for (const source of ['/install.sh', '/install.sh.sha256']) {
    const entry = config.headers.find(item => item.source === source);
    assert.ok(entry);
    const headers = Object.fromEntries(entry.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    assert.equal(headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['cache-control'], 'public, max-age=0, must-revalidate');
  }
  assert.equal(config.trailingSlash, true);
  assert.deepEqual(config.redirects ?? [], []);
  assert.deepEqual(config.rewrites ?? [], []);
});
