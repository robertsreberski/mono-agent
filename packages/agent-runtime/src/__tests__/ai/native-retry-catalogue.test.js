import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { resolveDurableNativeSessionRepo } from "../../ai/providers/pi-native/session-lifecycle.js";
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

it.each(["list", "catalogue"])("refuses cold reopen when the native %s throws", async (method) => {
  const model = setup();
  const root = mkdtempSync(join(tmpdir(), "catalogue-failure-"));
  const repo = resolveDurableNativeSessionRepo(root);
  const failure = vi.spyOn(repo, method).mockRejectedValue(new Error("Fictional catalogue read failure"));
  const create = vi.spyOn(repo, "create");
  try {
    const result = await generatePiNativeResponse("Fictional rules", runOptions(model, {
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
    const result = await generatePiNativeResponse("Fictional rules", runOptions(model, {
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
  const result = await generatePiNativeResponse("Fictional rules", runOptions(model, {
    piMaxRetries, messages: [{ role: "user", content: "Fictional request" }],
  }));
  expect(result.text).toBe("Fictional answer");
  expect(requests).toHaveLength(1); expect(requests[0].maxRetries).toBe(2);
});
