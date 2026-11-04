#!/usr/bin/env node
// Offline request-builder qualification, not a runtime mapper or wire probe.
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fauxProvider } from '@earendil-works/pi-ai';
import { APIS, hash, bytes, mapReference, renderStub } from '../../../scripts/lib/tool-result-clearing-reference.mjs';

export function fixture(api) {
  const model = { ...fauxProvider({ models: [{ id: 'fixture' }] }).getModel(), id: 'fictional-model',
    provider: 'fictional-provider', api, baseUrl: 'https://fixture.invalid/v1', input: ['text', 'image'], reasoning: true };
  const reasoning = { type: 'reasoning', id: 'rs_fictional', summary: [{ type: 'summary_text', text: 'Fictional reasoning.' }], encrypted_content: 'fictional-encrypted-🧭' };
  const thinkingSignature = api === 'anthropic-messages' ? 'fictional-signed-🧭' : JSON.stringify(reasoning);
  const callId = n => api.includes('responses') ? `call_${n}|fc_${n}` : `call_${n}`;
  const messages = [{ role: 'user', content: 'Fictional earlier input.', timestamp: 0 }];
  const selections = new Map();
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'assistant', provider: model.provider, api, model: model.id, stopReason: 'toolUse', timestamp: i * 2 + 1,
      content: [...(i === 0 ? [{ type: 'thinking', thinking: 'Fictional signed thought.', thinkingSignature },
          ...(api === 'anthropic-messages' ? [{ type: 'thinking', thinking: '', redacted: true, thinkingSignature: 'fictional-opaque-signed' }] : [])] : []),
        { type: 'toolCall', id: callId(i), name: 'Read', arguments: { query: `Fictional ${i} 🧭 é` } }] });
    const text = `Fictional result ${i}: 🧭 é \\ \" newline\n`;
    const image = { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };
    const message = { role: 'toolResult', toolCallId: callId(i), toolName: 'Read', isError: i === 5, timestamp: i * 2 + 2,
      content: i === 2 ? [image] : i === 3 ? [{ type: 'text', text }, image]
        : i === 4 ? [{ type: 'opaque', data: 'fictional-extension' }] : [{ type: 'text', text }] };
    const record = { record_id: `chr1_fictional_${i}`, original_bytes: bytes(text), retained_bytes: bytes(text), text_sha256: hash(text),
      retained_text: text, finalized: 1, state: 'committed', tombstone_reason: null, redacted: 0, truncated: 0 };
    if (i < 2) selections.set(messages.length, { record, state: { completed: true, returned: true, placed: true } });
    messages.push(message);
  }
  messages.push({ role: 'user', content: 'Fictional current input.', timestamp: 20 });
  return { model, messages, selections, reasoning, thinkingSignature };
}
export function diffPaths(a, b, path = []) {
  if (isDeepStrictEqual(a, b)) return [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return [path.join('.')];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => diffPaths(a[k], b[k], [...path, k]));
}
function targetedPaths(payload, api, selected) {
  const paths = [];
  if (api === 'anthropic-messages') payload.messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach((b, j) => {
      if (b.type !== 'tool_result' || !selected.has(b.tool_use_id)) return;
      if (typeof b.content === 'string') paths.push(`messages.${i}.content.${j}.content`);
      else b.content.forEach((c, k) => { if (c.type === 'text') paths.push(`messages.${i}.content.${j}.content.${k}.text`); });
    });
  });
  else if (api.includes('responses')) payload.input.forEach((item, i) => {
    if (item.type !== 'function_call_output' || !selected.has(item.call_id)) return;
    if (typeof item.output === 'string') paths.push(`input.${i}.output`);
    else item.output.forEach((c, j) => { if (c.type === 'input_text') paths.push(`input.${i}.output.${j}.text`); });
  });
  else payload.messages.forEach((m, i) => {
    if (m.role === 'tool' && selected.has(m.tool_call_id)) paths.push(`messages.${i}.content`);
  });
  return paths.sort();
}
const at = (object, path) => path.split('.').reduce((value, key) => value[key], object);
export function comparePayloads(before, after, api, messages, selections) {
  const targets = new Map([...selections].map(([i, s]) => [messages[i].toolCallId.split('|')[0], s]));
  const allowed = targetedPaths(before, api, targets), actual = diffPaths(before, after).sort();
  if (allowed.length !== selections.size || !isDeepStrictEqual(actual, allowed)) return false;
  const replacements = [...selections].map(([i, s]) => [messages[i].content[0].text, renderStub(messages[i], s.record)]);
  return actual.every(path => replacements.some(([original, stub]) => at(before, path) === original && at(after, path) === stub));
}
export async function qualify(api, inspect) {
  const adapter = await import(`@earendil-works/pi-ai/api/${api}`);
  const f = fixture(api), mapped = mapReference(f.messages, f.selections);
  const apiKey = api === 'openai-codex-responses'
    ? `fictional.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fictional-account' } })).toString('base64url')}.fictional`
    : 'synthetic-test-value';
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('OFFLINE_ONLY'); };
  try {
    const capture = async messages => {
      let payload;
      await adapter.stream(f.model, { systemPrompt: 'Fictional system.', messages }, { apiKey, maxRetries: 0,
        onPayload(value) { payload = structuredClone(value); throw new Error('OFFLINE_CAPTURE_STOP'); } }).result();
      if (!payload) throw new Error('NO_PAYLOAD');
      return payload;
    };
    const before = await capture(f.messages), after = await capture(mapped);
    const repeat = isDeepStrictEqual(before, await capture(f.messages)) && isDeepStrictEqual(after, await capture(mapped));
    const preserved = repeat && networkAttempts === 0 && comparePayloads(before, after, api, f.messages, f.selections);
    inspect?.({ ...f, mapped, before, after, networkAttempts });
    return { api, status: preserved ? 'payload-preserving' : 'fails', unintendedDifferences: preserved ? 0 : 1,
      targetedTextChanges: f.selections.size, ...(api === 'openai-codex-responses' ? { wire: 'wire-unproven (transport)', verdict: 'DEFER' } : {}) };
  } finally { globalThis.fetch = originalFetch; }
}
export async function qualifyAll() {
  const routes = [];
  for (const api of APIS) {
    try { routes.push(await qualify(api)); } catch { routes.push({ api, status: 'fails', unintendedDifferences: 1 }); }
  }
  return { routes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await qualifyAll();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.routes.some(r => r.status === 'fails') ? 1 : 0;
}
