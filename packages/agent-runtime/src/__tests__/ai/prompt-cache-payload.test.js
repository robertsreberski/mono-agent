// Cross-boundary proof: real host assembly -> native Pi session -> real OpenAI
// request builder. fetch is fully replaced; no network/authentication is used.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHarness, createInMemoryHistoryStore, createToolPolicy } from '../../../../agent-harness/src/index.ts';
import { resolveJsonMonoAgentConfig } from '../../../../config/src/index.ts';
import { generatePiNativeResponse } from '../../ai/providers/pi-native.js';
import { disposeProviderSession } from '../../ai/runtime/sessions.js';
import { createToolContext } from "../../agent/tools/shared/tool-context.js";

// Direct tool construction in this file binds one explicit context.
const ctx = createToolContext();

const roots = [];
const sessions = new Set();
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

it.each(['anthropic-messages', 'openai-responses'])('serializes a recovered native tool prefix through %s without failed reasoning', async (api) => {
  const { fauxAssistantMessage, fauxThinking, fauxToolCall } = await import('@earendil-works/pi-ai');
  const { buildPiSessionContext } = await import('../../ai/providers/pi-native/harness-adapter.js');
  const { validRecoveryProjection } = await import('../../ai/providers/pi-native/terminal-recovery.js');
  const send = api === 'anthropic-messages'
    ? (await import('@earendil-works/pi-ai/api/anthropic-messages')).streamSimple : streamSimple;
  const base = fauxProvider({ provider: 'wire-fixture', models: [{ id: 'fixture', reasoning: true }] }).getModel();
  const model = { ...base, api, baseUrl: 'https://fixture.invalid/v1' };
  const signature = api === 'anthropic-messages' ? 'faux-signature'
    : JSON.stringify({ type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'faux-signature' });
  const assistant = (content, stopReason) => ({ ...fauxAssistantMessage(content, { stopReason }), api, provider: model.provider, model: model.id });
  const messages = buildPiSessionContext([
    { type: 'message', message: { role: 'user', content: 'cancelled ask', timestamp: 1 } },
    { type: 'message', message: assistant([{ ...fauxThinking('completed'), thinkingSignature: signature }, fauxToolCall('Read', { file_path: 'file' }, { id: 'call_fixture' })], 'toolUse') },
    // A surviving orphan call is paired by Pi's serializer, without a host append.
    { type: 'message', message: assistant([{ ...fauxThinking('interrupted'), thinkingSignature: 'INVALID_PARTIAL_SIGNATURE' }], 'aborted') },
    { type: 'message', message: { role: 'user', content: 'next ask', timestamp: 2 } },
  ]);
  expect(validRecoveryProjection(messages, model)).toBe(true);
  let payload;
  await send(model, { systemPrompt: 'stable', messages, tools: [{ name: 'Read', description: 'Read fixture', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }] }, {
    apiKey: 'synthetic-test-value', maxRetries: 0,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ error: { message: 'intercepted test response', type: 'test_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    },
  }).result();
  expect(payload).toBeDefined();
  expect(JSON.stringify(payload)).not.toContain('INVALID_PARTIAL_SIGNATURE');
  expect(JSON.stringify(payload)).toContain('faux-signature');
  const items = api === 'anthropic-messages' ? payload.messages.flatMap((message) => message.content) : payload.input;
  const calls = items.filter((item) => item.type === (api === 'anthropic-messages' ? 'tool_use' : 'function_call'));
  const results = items.filter((item) => item.type === (api === 'anthropic-messages' ? 'tool_result' : 'function_call_output'));
  expect(calls).toHaveLength(1); expect(results).toHaveLength(1);
  expect(api === 'anthropic-messages' ? results[0].tool_use_id : results[0].call_id)
    .toBe(api === 'anthropic-messages' ? calls[0].id : calls[0].call_id);
});


it.each(['anthropic-messages', 'openai-responses'])('keeps actual %s tool arrays byte-identical across admission changes within each profile', async (api) => {
  const { getPiBuiltinTools } = await import('../../agent/tools/pi-bridge.js');
  const { composeHostTurnEnvelope, formatHostCapabilities } = await import('../../../../agent-harness/src/context/turn-envelope.ts');
  const send = api === 'anthropic-messages' ? (await import('@earendil-works/pi-ai/api/anthropic-messages')).streamSimple : streamSimple;
  const model = { ...fauxProvider({ provider: 'wire-fixture', models: [{ id: 'fixture' }] }).getModel(), api, baseUrl: 'https://fixture.invalid/v1' };
  const processJobs = { start: async () => { throw new Error('must not start'); }, limits: { maxRuntimeMs: 10000 } };
  const instances = { reserve: () => {}, releaseReservation: () => {}, inspect: () => {}, checkAcknowledgement: () => {} };
  const parent = { run: async () => { throw new Error('must not run'); }, instances };
  for (const profile of ['parent', 'persistent-child']) {
    const exposure = { persistentSubagents: profile === 'parent', askParent: profile === 'persistent-child' };
    let baseline;
    const envelopes = new Set();
    for (const [index, kind] of ['user', 'job-wake', 'cron', 'child-continuation', 'exhausted-lineage', 'absent-controller'].entries()) {
      const admitted = index < 3;
      const subagents = profile === 'parent' ? { ...parent, ...(admitted ? { backgroundSubagentController: {} } : {}), ...(index === 6 ? { instances: undefined } : {}) } : { depth: 1 };
      const options = {
        toolExposure: exposure, subagents,
        processJobs: admitted ? processJobs : undefined,
        askParentController: profile === 'persistent-child' && admitted ? { submit: async () => {} } : undefined,
        toolLimits: { bashTimeoutMs: 120000 - index * 1000 },
        processJobsAvailability: { chainDepth: index, maxChainDepth: 4, remainingStarts: Math.max(0, 4 - index), ...(index >= 4 ? { unavailableReason: 'chain_depth_exhausted' } : {}) },
      };
      const tools = getPiBuiltinTools(['Bash', 'Exec', 'Agent', 'AgentSend', 'AskParent'], {
        ...options, ctx, processJobsController: options.processJobs,
      });
      if (profile === 'persistent-child') expect(tools.map((tool) => tool.name)).toEqual(['AskParent', 'Bash', 'Exec']);
      const envelope = composeHostTurnEnvelope(formatHostCapabilities(options), kind);
      envelopes.add(envelope);
      let payload;
      await send(model, { systemPrompt: 'fixed', tools, messages: [{ role: 'user', content: envelope, timestamp: 1 }] }, {
        apiKey: 'synthetic-test-value', maxRetries: 0,
        fetch: async (_url, init) => {
          payload = JSON.parse(init.body);
          return new Response(JSON.stringify({ error: { message: 'intercepted', type: 'test_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
        },
      }).result();
      expect(payload).toBeDefined();
      const bytes = JSON.stringify(payload.tools);
      baseline ??= bytes;
      expect(bytes, `${profile}/${kind}`).toBe(baseline);
    }
    expect(envelopes.size).toBe(6);
  }
});


it.each([
  ['anthropic-messages', 'long', true, '1h'],
  ['anthropic-messages', 'long', false, '5m'],
  ['anthropic-messages', 'short', true, '5m'],
  ['anthropic-messages', undefined, true, '1h'],
  ['anthropic-messages', undefined, undefined, '1h'],
  ['anthropic-messages', undefined, false, '5m'],
  ['openai-responses', undefined, true, null],
  ['openai-responses', 'long', true, null],
])('retention %s/%s (supported=%s) preserves Pi compatibility and stream-option boundaries', async (api, cacheRetention, supported, ttl) => {
  vi.stubEnv('PI_CACHE_RETENTION', cacheRetention === 'short' ? 'long' : 'short');
  const resolvedRetention = resolveJsonMonoAgentConfig({ cwd: '/repo', json: { runtime: { model: 'anthropic:claude-sonnet-4-6' }, context: { identityPath: 'IDENTITY.md' }, providers: { piNative: { ...(cacheRetention === undefined ? {} : { cacheRetention }) } } } }).providers.piNative.cacheRetention;
  const { AgentHarness } = await import('@earendil-works/pi-agent-core');
  const create = vi.spyOn(AgentHarness, 'create');
  const send = api === 'anthropic-messages' ? (await import('@earendil-works/pi-ai/api/anthropic-messages')).streamSimple : streamSimple;
  const base = fauxProvider({ provider: 'retention-fixture', models: [{ id: 'fixture' }] });
  const model = { ...base.getModel(), api, baseUrl: 'https://fixture.invalid/v1', compat: { supportsLongCacheRetention: supported } };
  const models = createModels(); const payloads = []; const streamOptions = []; const events = [];
  models.setProvider({ ...base.provider, getModels: () => [model], streamSimple: (selected, context, options) => {
    streamOptions.push(options);
    return send(selected, context, { ...options, apiKey: 'synthetic-test-value', maxRetries: 0,
      fetch: async (_url, init) => {
        payloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: { message: 'intercepted', type: 'test_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      },
    });
  } });
  await generatePiNativeResponse('stable', { model: { provider: 'retention-fixture', model: 'fixture', reference: 'retention-fixture:fixture' },
    piResolvedModel: model, piResolvedModels: models, messages: [{ role: 'user', content: 'test' }], allowedTools: ['Read'],
    cacheRetention: resolvedRetention, promptCacheDiagnostics: true, onEvent: (event) => events.push(event),
  });
  expect(payloads).toHaveLength(1);
  if (api === 'anthropic-messages') expect(streamOptions[0].cacheRetention).toBe(resolvedRetention);
  else {
    expect(create.mock.calls[0][0].streamOptions).not.toHaveProperty('cacheRetention');
    // Pi itself materializes an undefined option in its downstream projection.
    expect(streamOptions[0].cacheRetention).toBeUndefined();
  }
  const diagnostic = events.find((event) => event.type === 'prompt_cache_diagnostic');
  expect(diagnostic).toMatchObject({ requestedCacheRetention: resolvedRetention, observedCacheTtls: ttl ? [ttl] : [] });
  if (ttl === '1h') expect(JSON.stringify(payloads[0])).toContain('"ttl":"1h"');
  else expect(JSON.stringify(payloads[0])).not.toContain('"ttl":"1h"');
});

it.each(['anthropic-messages', 'openai-responses'])('keeps combined app-owned MCP and builtin %s definitions stable on real request-scoped endpoints', async (api) => {
  const { getPiBuiltinTools, initPiMcpTools, closePiMcpClients } = await import('../../agent/tools/pi-bridge.js');
  const { createSetConversationTitleRuntimeExtension } = await import('../../../../agent-app/src/conversation-title.ts');
  const { createConsoleProjectsRuntimeExtension } = await import('../../../../agent-app/src/console-projects.ts');
  const { createMemoryRememberRuntimeExtension } = await import('../../../../agent-app/src/memory-remember.ts');
  const { createAdapterSendToolsServer } = await import('../../../../agent-app/src/adapter-send-tools.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { composeRuntimeOptionExtensions } = await import('../../../../agent-app/src/runtime-option-extensions.ts');
  const { composeHostTurnEnvelope, formatHostCapabilities } = await import('../../../../agent-harness/src/context/turn-envelope.ts');
  const send = api === 'anthropic-messages' ? (await import('@earendil-works/pi-ai/api/anthropic-messages')).streamSimple : streamSimple;
  const model = { ...fauxProvider({ provider: 'app-wire-fixture', models: [{ id: 'fixture' }] }).getModel(), api, baseUrl: 'https://fixture.invalid/v1' };
  const mutations = vi.fn(); const bridgeFetch = vi.fn();
  let baseline; const envelopes = new Set();
  for (const [index, kind] of ['user', 'job-wake', 'cron', 'exhausted-lineage', 'absent-controller'].entries()) {
    const interactive = ['user', 'exhausted-lineage'].includes(kind);
    const web = { threadId: 'thread', turnId: `turn-${index}`, conversationTitle: { schema: 1, writable: true }, consoleProjects: { schema: 1 },
      ...(['job-wake'].includes(kind) ? { trigger: kind } : {}) };
    const metadata = kind === 'cron' ? { source: 'cron' } : kind === 'absent-controller' ? { source: 'web' } : { source: 'web', web };
    const input = { request: { conversationId: 'web:thread', userMessage: kind, abortSignal: new AbortController().signal, metadata }, runId: `run-${index}`, context: {} };
    const store = { supportsRemember: () => interactive, remember: mutations };
    const adapterServer = await createAdapterSendToolsServer({ askUser: {
        bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'synthetic-test-value', timeoutMs: interactive ? null : 1000,
        // Wake turns retain AskUser's existing admission; only missing target refuses.
        ...(kind === 'absent-controller' ? {} : { producerConversationId: 'web:thread', interactionConversationId: 'web:thread' }),
      } }, {}, undefined, { fetchImpl: bridgeFetch });
    const adapterClient = new Client({ name: "wire-fixture", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await adapterServer.connect(serverTransport); await adapterClient.connect(clientTransport);
    const adapterTools = (await adapterClient.listTools()).tools.map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema }));
    const extension = composeRuntimeOptionExtensions([
      createSetConversationTitleRuntimeExtension(),
      createConsoleProjectsRuntimeExtension({ sourceId: 'fixture', policy: { allowedTools: ['*'], disallowedTools: [] }, createClient: async () => mutations }),
      createMemoryRememberRuntimeExtension(store),
    ]);
    const bound = await extension(input);
    const runOptions = { ...bound.runtimeOptions, toolLimits: { bashTimeoutMs: 120000 - index * 1000 },
      processJobsAvailability: { chainDepth: index, maxChainDepth: 4, remainingStarts: Math.max(0, 4 - index), ...(index >= 4 ? { unavailableReason: 'chain_depth_exhausted' } : {}) } };
    const builtins = getPiBuiltinTools(['Bash', 'Exec', 'Read'], { ctx, toolLimits: runOptions.toolLimits });
    const mcp = await initPiMcpTools(runOptions.mcpServers, new Set(builtins.map((tool) => tool.name)), { ctx });
    try {
      expect(mcp.warnings).toEqual([]);
      if (!interactive) {
        for (const [name, args] of [['SetConversationTitle', { title: 'No mutation' }], ['CreateProject', { name: 'No mutation' }], ['Remember', { text: 'Must not be persisted.' }]]) {
          const result = await mcp.tools.find((tool) => tool.name === name).execute('refused', args);
          expect(result.details.mcp_result_is_error, name).toBe(true);
          if (name === "Remember") expect(result.details.raw?.structuredContent).toMatchObject({ stored: false });
          else expect(result.details.raw?.structuredContent).toBeUndefined();
        }
      }
      if (kind === 'absent-controller') {
        const result = await adapterClient.callTool({ name: 'AskUser', arguments: { questions: [{ header: 'Question', question: 'Proceed?', options: [{ label: 'Yes', description: 'Proceed' }, { label: 'No', description: 'Stop' }] }] } });
        expect(result.isError).toBe(true);
      }
      const envelope = composeHostTurnEnvelope(formatHostCapabilities(runOptions), kind); envelopes.add(envelope);
      let payload;
      await send(model, { systemPrompt: 'fixed', tools: [...builtins, ...mcp.tools, ...adapterTools], messages: [{ role: 'user', content: envelope, timestamp: 1 }] }, {
        apiKey: 'synthetic-test-value', maxRetries: 0, fetch: async (_url, init) => {
          payload = JSON.parse(init.body);
          return new Response(JSON.stringify({ error: { message: 'intercepted', type: 'test_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
        },
      }).result();
      expect(payload).toBeDefined(); const bytes = JSON.stringify(payload.tools); baseline ??= bytes;
      expect(bytes, kind).toBe(baseline);
      expect(bytes).toContain('SetConversationTitle'); expect(bytes).toContain('Remember'); expect(bytes).toContain('AskUser'); expect(bytes).toContain('CreateProject');
    } finally { await closePiMcpClients(mcp.clients); await bound.cleanup?.(); await adapterClient.close(); await adapterServer.close(); }
  }
  expect(envelopes.size).toBe(5); expect(mutations).not.toHaveBeenCalled(); expect(bridgeFetch).not.toHaveBeenCalled();
});
