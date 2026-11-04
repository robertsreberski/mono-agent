// Qualification identity without importing provider, auth or credential code.
import { readFileSync } from 'node:fs';
import { hash } from './tool-result-clearing-reference.mjs';
export function qualificationIdentity() {
  const version = JSON.parse(readFileSync(new URL('../../packages/turn/node_modules/@earendil-works/pi-ai/package.json', import.meta.url), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('INPUT');
  // Bind the fixture builder, diff contract and reference mapper, not a copied fixture.
  const fixtureDigest = hash(['../../packages/turn/scripts/tool-result-clearing-qualify.mjs', './tool-result-clearing-reference.mjs', './tool-result-clearing-qualification-id.mjs']
    .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n'));
  return { piAiVersion: version, fixtureDigest };
}
export function qualifiedEntry(report, api) {
  const expected = qualificationIdentity();
  return report?.piAiVersion === expected.piAiVersion && report?.fixtureDigest === expected.fixtureDigest
    ? (Array.isArray(report.routes) ? report.routes.find(r => r.api === api) : undefined) : undefined;
}
