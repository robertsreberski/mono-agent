import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { generateEngineTurnResponse } from "../../ai/providers/engine-turn.js";
import { resolveDurableNativeSessionRepo } from "../../ai/providers/engine-turn/session-lifecycle.js";
import { disposeProviderSession } from "../../ai/runtime/sessions.js";

let faux, fauxModels;
afterEach(() => { vi.restoreAllMocks(); });
function setup() {
  faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }], tokensPerSecond: undefined });
  fauxModels = createModels(); fauxModels.setProvider(faux.provider);
  return faux.getModel();
}
function runOptions(model, overrides = {}) {
  return { model: { provider: "faux", model: "faux-model", reference: "faux:faux-model" },
    piResolvedModel: model, piResolvedModels: fauxModels, effort: "none", allowedTools: [], ...overrides };
}

it.each(["find"])("refuses cold reopen when the native %s throws", async (method) => {
  const model = setup();
  const root = mkdtempSync(join(tmpdir(), "catalogue-failure-"));
  const repo = resolveDurableNativeSessionRepo(root);
  const failure = vi.spyOn(repo, method).mockRejectedValue(new Error("Fictional catalogue read failure"));
  const create = vi.spyOn(repo, "create");
  try {
    const result = await generateEngineTurnResponse("Fictional rules", runOptions(model, {
      sessionId: "catalogue-failure", piSessionsRoot: root, sessionKeepAlive: true,
      sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket",
        turnId: "catalogue-turn", handleId: "catalogue-failure", baseRevision: 1,
        reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "fictional-input" } },
      messages: [{ role: "user", content: "Fictional request" }],
    }));
    expect(result.failureKind, result.error).toBe("native_journal_unreadable");
    expect(result.error).toContain("catalogue could not be read; native evidence was preserved");
    expect(faux.state.callCount).toBe(0);
    expect(create).not.toHaveBeenCalled();
  } finally {
    failure.mockRestore(); create.mockRestore();
    await disposeProviderSession("catalogue-failure").catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([0, undefined])("piMaxRetries=%s controls both request retry layers and preserves the default", async (piMaxRetries) => {
  const model = setup();
  const requests = [];
  fauxModels.setProvider({ ...faux.provider, streamSimple(model, context, options) {
    requests.push(options); return faux.provider.streamSimple(model, context, options);
  } });
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([], {
    stopReason: "error", errorMessage: "503 service unavailable",
  })));
  try {
    const result = await generateEngineTurnResponse("Fictional rules", runOptions(model, {
      piMaxRetries, messages: [{ role: "user", content: "Fictional request" }],
    }));
    expect(result.error).toContain("503");
    expect(faux.state.callCount).toBe(piMaxRetries === 0 ? 1 : 4);
    expect(requests.every((options) => options.maxRetries === (piMaxRetries === 0 ? 0 : 2))).toBe(true);
    expect(result.events.filter((event) => event.type === "tool_call_started")).toEqual([]);
  } finally { vi.restoreAllMocks(); }
});

it.each([null, "", "   ", Infinity, "not-a-number"])("treats an unset/invalid direct retry budget (%s) as the default, not zero", async (piMaxRetries) => {
  const model = setup(), requests = [];
  fauxModels.setProvider({ ...faux.provider, streamSimple(model, context, options) {
    requests.push(options); return faux.provider.streamSimple(model, context, options);
  } });
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional answer")])]);
  const result = await generateEngineTurnResponse("Fictional rules", runOptions(model, {
    piMaxRetries, messages: [{ role: "user", content: "Fictional request" }],
  }));
  expect(result.text).toBe("Fictional answer");
  expect(requests).toHaveLength(1); expect(requests[0].maxRetries).toBe(2);
});


it("creates a new conversation despite id-less legacy damage", async () => {
  const model = setup(), root = mkdtempSync(join(tmpdir(), "legacy-unowned-"));
  const sessionId = "fictional-new-conversation";
  mkdirSync(join(root, "x"));
  const stray = join(root, "x", "notes.jsonl"), bytes = '{"type":"fictional-not-pi"}\n';
  writeFileSync(stray, bytes);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional answer")])]);
  try {
    const result = await generateEngineTurnResponse("Fictional rules", runOptions(model, {
      sessionId, piSessionsRoot: root, sessionKeepAlive: true,
      messages: [{ role: "user", content: "Fictional request" }],
    }));
    expect(result.text, result.error).toBe("Fictional answer");
    expect(faux.state.callCount).toBe(1);
    expect(await resolveDurableNativeSessionRepo(root).find(sessionId)).toMatchObject({ id: sessionId });
    expect(readFileSync(stray, "utf8")).toBe(bytes);
  } finally { await disposeProviderSession(sessionId).catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

it.each(["ERR_HARNESS_WRITER_BUSY", "ERR_HARNESS_JOURNAL_UNREADABLE"])("classifies attributed lookup failure %s without creating", async (code) => {
  const model = setup(), root = mkdtempSync(join(tmpdir(), "lookup-failure-"));
  const sessionId = "fictional-lookup-owner", repo = resolveDurableNativeSessionRepo(root);
  vi.spyOn(repo, "find").mockRejectedValue(Object.assign(new Error("Fictional lookup failure"), { code, sessionId }));
  const create = vi.spyOn(repo, "create");
  try {
    const result = await generateEngineTurnResponse("Fictional rules", runOptions(model, {
      sessionId, piSessionsRoot: root, sessionKeepAlive: true,
      messages: [{ role: "user", content: "Fictional request" }],
    }));
    expect(result.failureKind).toBe(code === "ERR_HARNESS_WRITER_BUSY" ? "session_busy" : "native_journal_unreadable");
    expect(create).not.toHaveBeenCalled(); expect(faux.state.callCount).toBe(0);
  } finally { await disposeProviderSession(sessionId).catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});
