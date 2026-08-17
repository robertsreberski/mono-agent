// @ts-check

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodexAppServerClient } from "../../ai/providers/codex-app.js";

export const DEFAULT_CODEX_SEARCH_MODEL = "gpt-5.6-luna";

const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 1_000;
const MAX_MODEL_PAGES = 10;
const MAX_RESULTS = 100;
const SEARCH_ONLY_INSTRUCTIONS = [
  "You are a search transport, not a general assistant.",
  "Run exactly one live web search for the user's query, preserving quoted phrases and site: operators exactly.",
  "Do not use shell, filesystem, MCP, apps, subagents, image, or any other tool.",
  "Do not ask questions. The host consumes only the structured webSearch results and ignores your prose.",
].join(" ");

/** @type {{client: any, directory: string, models: Set<string>} | null} */
let broker = null;
/** @type {Promise<any> | null} */
let brokerOpening = null;
/** @type {Promise<void>} */
let serial = Promise.resolve();
/** @type {NodeJS.Timeout | null} */
let idleTimer = null;

/**
 * Inspect the installed Codex app-server without reading or exporting tokens.
 *
 * @param {{model?: string, clientFactory?: typeof createCodexAppServerClient}} [options]
 */
export async function inspectCodexSubscriptionSearch(options = {}) {
  const model = normalizeModel(options.model);
  let owned;
  try {
    owned = await openBroker(options.clientFactory);
    const ready = await inspectClient(owned.client, model);
    const { models: _models, ...publicReadiness } = ready;
    return publicReadiness;
  } catch (error) {
    return {
      ok: false,
      code: "codex_unavailable",
      reason: publicReason(error),
      model,
    };
  } finally {
    if (owned) await closeOwnedBroker(owned);
  }
}

/**
 * Execute one subscription-backed live search through Codex app-server.
 * Calls are serialized process-wide so one agent cannot fan out subscription
 * turns or cross-wire app-server notifications between requests.
 *
 * @param {string} query
 * @param {{model?: string, signal?: AbortSignal, clientFactory?: typeof createCodexAppServerClient}} [options]
 */
export function searchCodexSubscription(query, options = {}) {
  return enqueue(async () => {
    if (options.signal?.aborted) return abortedResult();
    const model = normalizeModel(options.model);
    let current;
    try {
      current = await getBroker(model, options.clientFactory);
      const result = await runSearch(current, query, model, options.signal);
      scheduleIdleClose();
      return result;
    } catch (error) {
      await closeBroker();
      return {
        ok: false,
        backend: "codex",
        message: `Codex subscription search unavailable: ${publicReason(error)}`,
        retryable: isRetryable(error),
      };
    }
  });
}

function enqueue(task) {
  const result = serial.then(task, task);
  serial = result.then(() => {}, () => {});
  return result;
}

async function getBroker(model, clientFactory) {
  clearIdleTimer();
  if (broker?.models.has(model)) return broker;
  if (broker && !broker.models.has(model)) await closeBroker();
  if (!brokerOpening) {
    brokerOpening = (async () => {
      const owned = await openBroker(clientFactory);
      const ready = await inspectClient(owned.client, model);
      if (!ready.ok) {
        await closeOwnedBroker(owned);
        throw new Error(ready.reason);
      }
      owned.models = ready.models;
      broker = owned;
      return owned;
    })().finally(() => { brokerOpening = null; });
  }
  return await brokerOpening;
}

async function openBroker(clientFactory = createCodexAppServerClient) {
  const directory = await mkdtemp(join(tmpdir(), "mono-agent-codex-search-"));
  /** @type {{handler: (message: any) => void}} */
  const target = { handler: () => {} };
  let client;
  try {
    client = clientFactory({
      cwd: directory,
      onNotification: (message) => target.handler(message),
      onServerRequest: (message) => {
        target.handler(message);
        throw new Error("Codex subscription search rejected an unexpected server request.");
      },
    });
    await client.request("initialize", {
      clientInfo: { name: "mono-agent-web-search", title: "mono-agent WebSearch", version: "0" },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    return { client, directory, models: new Set(), target };
  } catch (error) {
    await Promise.resolve(client?.close?.()).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function inspectClient(client, model) {
  const account = await client.request("account/read", { refreshToken: false }, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (account?.account?.type !== "chatgpt") {
    return {
      ok: false,
      code: "codex_chatgpt_login_required",
      reason: "Codex must be signed in with ChatGPT subscription access.",
      model,
      models: new Set(),
    };
  }
  const capabilities = await client.request(
    "modelProvider/capabilities/read",
    {},
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  if (capabilities?.webSearch !== true) {
    return {
      ok: false,
      code: "codex_web_search_unavailable",
      reason: "The signed-in Codex account does not expose web search.",
      model,
      models: new Set(),
    };
  }
  const models = await readModels(client);
  if (!models.has(model)) {
    return {
      ok: false,
      code: "codex_model_unavailable",
      reason: `Codex model ${model} is not available to the signed-in account.`,
      model,
      models,
    };
  }
  return {
    ok: true,
    code: "ok",
    reason: "",
    model,
    models,
  };
}

async function readModels(client) {
  const models = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const response = await client.request("model/list", {
      includeHidden: false,
      limit: 100,
      ...(cursor === null ? {} : { cursor }),
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    if (!Array.isArray(response?.data)) throw new Error("Codex returned an invalid model catalog.");
    for (const row of response.data) {
      if (typeof row?.id === "string" && row.id.trim()) models.add(row.id.trim());
    }
    cursor = typeof response?.nextCursor === "string" && response.nextCursor ? response.nextCursor : null;
    if (cursor === null) return models;
  }
  throw new Error("Codex model catalog exceeded the pagination bound.");
}

async function runSearch(current, query, model, signal) {
  const state = /** @type {any} */ ({
    threadId: "",
    turnId: "",
    completed: false,
    violation: "",
    webSearchItems: [],
    resolve: () => {},
  });
  const completion = new Promise((resolve) => { state.resolve = resolve; });
  current.target.handler = (message) => handleNotification(message, state, current.client);
  const onAbort = () => {
    if (state.threadId && state.turnId) {
      void current.client.request("turn/interrupt", {
        threadId: state.threadId,
        turnId: state.turnId,
      }).catch(() => {});
    }
    state.violation ||= "WebSearch was aborted.";
    state.resolve();
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const thread = await current.client.request("thread/start", {
      model,
      modelProvider: "openai",
      allowProviderModelFallback: false,
      cwd: current.directory,
      runtimeWorkspaceRoots: [current.directory],
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      config: {
        web_search: "live",
        project_doc_max_bytes: 0,
        mcp_servers: {},
      },
      developerInstructions: SEARCH_ONLY_INSTRUCTIONS,
      ephemeral: true,
      sessionStartSource: "startup",
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    state.threadId = thread?.thread?.id || "";
    if (!state.threadId) throw new Error("Codex did not return a search thread id.");
    const turn = await current.client.request("turn/start", {
      threadId: state.threadId,
      input: [{ type: "text", text: String(query), text_elements: [] }],
      cwd: current.directory,
      runtimeWorkspaceRoots: [current.directory],
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model,
      effort: "low",
      summary: "none",
      environments: [],
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    state.turnId = turn?.turn?.id || state.turnId;
    if (state.violation && state.turnId) {
      await current.client.request("turn/interrupt", {
        threadId: state.threadId,
        turnId: state.turnId,
      }).catch(() => {});
    }
    await waitForCompletion(completion, signal);
    if (state.violation) throw new Error(state.violation);
    if (!state.completed) throw new Error("Codex search turn did not complete.");
    if (state.webSearchItems.length !== 1) {
      throw new Error(`Codex search turn produced ${state.webSearchItems.length} web search items; expected exactly one.`);
    }
    const item = state.webSearchItems[0];
    const actualQuery = typeof item.query === "string" && item.query.trim()
      ? item.query.trim()
      : String(query);
    if (actualQuery !== String(query)) {
      throw new Error("Codex changed the exact web search query.");
    }
    const results = normalizeResults(item.results);
    return {
      ok: true,
      backend: "codex",
      results,
      actualQuery,
    };
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    current.target.handler = () => {};
  }
}

function handleNotification(message, state, client) {
  const method = typeof message?.method === "string" ? message.method : "";
  if (method === "turn/started" && message?.params?.threadId === state.threadId) {
    state.turnId ||= message?.params?.turn?.id || "";
    return;
  }
  if ((method === "item/started" || method === "item/completed")
    && message?.params?.threadId === state.threadId) {
    const item = message?.params?.item;
    if (item?.type === "webSearch") {
      if (method === "item/completed") state.webSearchItems.push(item);
      return;
    }
    if (["userMessage", "agentMessage", "reasoning", "plan"].includes(item?.type)) return;
    state.violation ||= `Codex subscription search attempted unsupported item ${String(item?.type || "unknown")}.`;
    if (state.threadId && state.turnId) {
      void client.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).catch(() => {});
    }
    state.resolve();
    return;
  }
  if (method === "turn/completed" && message?.params?.threadId === state.threadId) {
    const turn = message?.params?.turn;
    state.turnId ||= turn?.id || "";
    state.completed = turn?.status === "completed";
    if (!state.completed) state.violation ||= "Codex search turn failed.";
    state.resolve();
    return;
  }
  if (method === "error") {
    state.violation ||= "Codex search turn reported an error.";
    state.resolve();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message || {}, "id") && method) {
    state.violation ||= "Codex subscription search attempted an unsupported server request.";
    state.resolve();
  }
}

function normalizeResults(rows) {
  if (!Array.isArray(rows)) return [];
  const results = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.url !== "string") continue;
    results.push({
      title: boundedText(row.title, 500),
      url: row.url,
      snippet: boundedText(row.snippet, 4_000),
      provenance: boundedText(row.domain || row.ref_id || row.type, 300),
      backend: "codex",
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

async function waitForCompletion(completion, signal) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Codex search turn timed out."), {
      code: "CODEX_SEARCH_TIMEOUT",
    })), REQUEST_TIMEOUT_MS);
  });
  try {
    if (signal?.aborted) throw Object.assign(new Error("WebSearch was aborted."), { name: "AbortError" });
    await Promise.race([completion, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function scheduleIdleClose() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void enqueue(async () => { await closeBroker(); });
  }, IDLE_CLOSE_MS);
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

async function closeBroker() {
  clearIdleTimer();
  const owned = broker;
  broker = null;
  if (owned) await closeOwnedBroker(owned);
}

async function closeOwnedBroker(owned) {
  await Promise.resolve(owned.client?.close?.()).catch(() => {});
  await rm(owned.directory, { recursive: true, force: true }).catch(() => {});
}

function normalizeModel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_CODEX_SEARCH_MODEL;
}

function boundedText(value, max) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

function safeReason(error) {
  if (error?.name === "AbortError") return "WebSearch was aborted.";
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  return message.replace(/[\r\n\t]+/gu, " ").slice(0, 500) || "unknown error";
}

function publicReason(error) {
  const reason = safeReason(error);
  if (reason === "WebSearch was aborted.") return reason;
  if (/timed out/iu.test(reason)) return "Codex app-server timed out.";
  if (/signed in with ChatGPT subscription access/iu.test(reason)) return reason;
  if (/does not expose web search/iu.test(reason)) return reason;
  if (/Codex model .* is not available/iu.test(reason)) return reason;
  if (/attempted unsupported item/iu.test(reason)) return "Codex attempted a non-search tool and the request was rejected.";
  if (/unsupported server request/iu.test(reason)) return "Codex requested an unsupported interaction and the request was rejected.";
  if (/produced .* web search items/iu.test(reason)) return "Codex did not produce exactly one structured web search result set.";
  if (/changed the exact web search query/iu.test(reason)) return "Codex did not preserve the exact web search query.";
  return "Codex app-server is not ready for subscription web search.";
}

function isRetryable(error) {
  return error?.name === "AbortError" || error?.code === "CODEX_SEARCH_TIMEOUT"
    || error?.code === "CODEX_APP_SERVER_REQUEST_TIMEOUT";
}

function abortedResult() {
  return {
    ok: false,
    backend: "codex",
    message: "WebSearch was aborted.",
    retryable: false,
  };
}

/** Test hook for process-shared broker state. */
export async function __resetCodexSubscriptionSearchForTests() {
  await enqueue(async () => { await closeBroker(); });
  brokerOpening = null;
}
