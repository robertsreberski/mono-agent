// Cross-boundary proof: real host assembly -> native Pi session -> real OpenAI
// request builder. fetch is fully replaced; no network/authentication is used.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHarness, createInMemoryHistoryStore, createToolPolicy } from '../../../../agent-harness/src/index.ts';
import { generatePiNativeResponse } from '../../ai/providers/pi-native.js';
import { disposeProviderSession } from '../../ai/runtime/sessions.js';

const roots = [];
const sessions = new Set();
afterEach(async () => {
  await Promise.all([...sessions].map((id) => disposeProviderSession(id)));
  sessions.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function providerCapture() {
  const payloads = [];
  const base = fauxProvider({ provider: 'cache-fixture', models: [{ id: 'fixture' }] });
  const model = { ...base.getModel(), api: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', reasoning: false };
  const models = createModels();
  models.setProvider({
    ...base.provider, getModels: () => [model],
    streamSimple: (selected, context, options) => streamSimple(selected, context, {
      ...options, apiKey: 'synthetic-test-value', maxRetries: 0,
      fetch: async (_url, init) => {
        // Observe the serialized request handed to the SDK transport, including
        // provider conversion and StructuredOutput, not just context.prompt.
        payloads.push(JSON.parse(init.body));
        const n = payloads.length;
        const item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `reply-${n}`, annotations: [] }] };
        const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } };
        const events = [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: `reply-${n}` },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      },
    }),
  });
  return { payloads, model, models };
}

function host(fixture, continuous) {
  const root = mkdtempSync(join(tmpdir(), 'prompt-cache-payload-'));
  roots.push(root);
  writeFileSync(join(root, 'IDENTITY.md'), 'Stable fixture identity.');
  return createAgentHarness({
    identityPath: join(root, 'IDENTITY.md'),
    model: { provider: 'cache-fixture', model: 'fixture', reference: 'cache-fixture:fixture' },
    historyStore: createInMemoryHistoryStore({ maxMessages: 64 }),
    toolPolicy: createToolPolicy({ allowedTools: ["Read"], disallowedTools: ["Bash"] }),
    runtimeOptionsForRequest: () => ({ runtimeOptions: { allowedTools: ["Bash"] } }),
    ...(continuous ? { session: { mode: 'continuous', supportsResume: true, idleTimeoutMs: 60000 } } : {}),
    runtime: {
      run: async (system, options) => {
        const result = await generatePiNativeResponse(system, { ...options, piResolvedModel: fixture.model, piResolvedModels: fixture.models, effort: 'none' });
        if (result.providerSessionId) sessions.add(result.providerSessionId);
        return result;
      },
      disposeSession: disposeProviderSession,
    },
  });
}
const request = (id, text, source) => ({ conversationId: id, userMessage: text, metadata: { source }, abortSignal: new AbortController().signal });
const instructions = (payload) => payload.input.filter((item) => item.role === 'developer' || item.role === 'system');
const conversation = (payload) => payload.input.filter((item) => item.role !== 'developer' && item.role !== 'system');

describe('built provider prompt prefix', () => {
  it.each([false, true])('keeps system/tools byte-identical across changing turns (continuous=%s)', async (continuous) => {
    const fixture = providerCapture();
    const harness = host(fixture, continuous);
    for (const [text, source] of [['unique-first', 'web'], ['unique-second', 'tui'], ['unique-third', 'web']]) {
      const result = await harness.run(request('web:fixture', text, source));
      expect(result.failure).toBeUndefined();
      expect(result.text).toMatch(/^reply-/);
    }
    expect(fixture.payloads).toHaveLength(3);
    const [first, second, third] = fixture.payloads;
    expect(JSON.stringify(instructions(second))).toBe(JSON.stringify(instructions(first)));
    expect(JSON.stringify(instructions(third))).toBe(JSON.stringify(instructions(first)));
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(first.tools.map((tool) => tool.name)).toEqual(["Read"]);
    expect(JSON.stringify(instructions(first))).not.toContain('unique-first');
    expect(JSON.stringify(first).match(/unique-first/g)).toHaveLength(1);
    expect(JSON.stringify(second).match(/unique-second/g)).toHaveLength(1);
    expect(JSON.stringify(third).match(/unique-third/g)).toHaveLength(1);
    if (continuous) expect(conversation(second).slice(0, conversation(first).length)).toEqual(conversation(first));
    await harness.dispose();
  });

  it('shares stable instructions across concurrent conversations without sharing transcripts', async () => {
    const fixture = providerCapture();
    const harness = host(fixture, true);
    const results = await Promise.all([
      harness.run(request('web:one', 'conversation-one-only', 'web')),
      harness.run(request('web:two', 'conversation-two-only', 'tui')),
    ]);
    expect(results.every((result) => result.failure === undefined)).toBe(true);
    expect(fixture.payloads).toHaveLength(2);
    expect(instructions(fixture.payloads[0])).toEqual(instructions(fixture.payloads[1]));
    for (const payload of fixture.payloads) {
      const text = JSON.stringify(payload);
      expect(text.includes('conversation-one-only') !== text.includes('conversation-two-only')).toBe(true);
    }
    expect(sessions.size).toBe(2);
    await harness.dispose();
  });
});
