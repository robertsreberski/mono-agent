import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = name => readFileSync(new URL(name, import.meta.url));
const CANONICAL_URL = 'https://mono-agent.dev/schema.json';

test('config schema is a byte-exact static JSON file, not an HTML page fallback', () => {
  const source = read('../public/schema.json');
  assert.deepEqual(read('../dist/schema.json'), source);
  assert.ok(!existsSync(new URL('../dist/schema.json/index.html', import.meta.url)));
  const schema = JSON.parse(source.toString());
  assert.equal(schema.$id, CANONICAL_URL);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.properties.$schema, { type: 'string' }, 'any $schema string, including the former URL, stays valid');
});

test('hosted schema mirrors the generated app schema byte for byte', () => {
  assert.deepEqual(
    read('../public/schema.json'),
    read('../../packages/app/schema/mono-agent.config.schema.json'),
    'run `pnpm run generate:config-reference` from the repository root',
  );
});

test('schema route keeps exact JSON, CORS, security and cache headers without redirects or rewrites', () => {
  const config = JSON.parse(read('../vercel.json'));
  const entry = config.headers.find(item => item.source === '/schema.json');
  assert.ok(entry);
  const headers = Object.fromEntries(entry.headers.map(({ key, value }) => [key.toLowerCase(), value]));
  assert.deepEqual(headers, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=0, must-revalidate',
  });
  assert.equal(config.trailingSlash, true);
  assert.deepEqual(config.redirects ?? [], []);
  assert.deepEqual(config.rewrites ?? [], []);
});
