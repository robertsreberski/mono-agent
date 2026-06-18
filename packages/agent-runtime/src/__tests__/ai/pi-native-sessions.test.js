// Pi-native session lifecycle integration.
//
// Retargeted from the retired pi-sdk-sessions suite: these assert the SAME
// session contract (resume seeding, session_not_found / session_busy fail-fast,
// keep-alive vs. drop, durable jsonl reopen, per-run billing, dispose reach,
// failed-turn isolation, structured-output finalization retry) against the
// pi-native AgentHarness bridge — the sole pi runtime path.
//
// The harness has no streamFn injection seam, so the provider is driven through
// pi-ai's own `registerFauxProvider`: a real provider is registered into pi-ai's
// API registry, the REAL harness + REAL streamSimple dispatch run with scripted
// responses, and the faux Model is handed to the bridge via the `piResolvedModel`
// seam (the faux model is reachable only through the registration handle).

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { disposeProviderSession } from "../../ai/runtime/sessions.js";

let faux = null;

function setup({ reasoning = false } = {}) {
  faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", reasoning }],
    tokensPerSecond: undefined,
  });
  return faux.getModel();
}

beforeEach(() => {
  faux = null;
});

afterEach(() => {
  faux?.unregister();
  faux = null;
});

function runOptions(model, overrides = {}) {
  return {
    model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:faux-model" },
    piResolvedModel: model,
    effort: "none",
    allowedTools: [],
    ...overrides,
  };
}

// Pull the user/assistant text turns out of a captured provider context so we
// can assert the seeded transcript on a resumed run.
function transcriptOf(context) {
  return (context?.messages || [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => {
      const text = typeof message.content === "string"
        ? message.content
        : (message.content || [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("");
      return `${message.role}:${text}`;
    });
}

// Recursively count .jsonl files under a sessions root so a leaked durable
// transcript (an orphaned session directory) is directly observable.
function countJsonlFiles(root) {
  let count = 0;
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, dirent.name);
    if (dirent.isDirectory()) count += countJsonlFiles(full);
    else if (dirent.name.endsWith(".jsonl")) count += 1;
  }
  return count;
}

describe("pi-native sessions", () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-native-sessions-"));
  afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

  it("forwards streamed thinking once and reports reasoning in per-run capabilities", async () => {
    const model = setup({ reasoning: true });
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("checking context"), fauxText("reply")]),
    ]);
    const seen = [];
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      effort: "medium",
      onEvent: (event) => {
        const block = event?.message?.content?.[0];
        if (block?.type === "thinking" && block.text !== "Running...") seen.push(block.text);
      },
    }));

    expect(result.error).toBeNull();
    expect(result.thinking).toContain("checking context");
    expect(result.capabilitiesUsed.thinking_enabled).toBe(true);
    expect(seen.join("")).toContain("checking context");
  });

  it("keeps a session alive and seeds a resumed run with the prior transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();
    expect(first.text).toBe("reply-1");
    expect(first.providerSessionId).toBeTruthy();

    let resumedContext = null;
    faux.setResponses([
      (context) => { resumedContext = context; return fauxAssistantMessage([fauxText("reply-2")]); },
    ]);
    const second = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
    }));
    expect(second.error).toBeNull();
    expect(second.text).toBe("reply-2");
    expect(second.providerSessionId).toBe(first.providerSessionId);
    expect(transcriptOf(resumedContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-2",
    ]);
  });

  it("fails fast with session_not_found on a resume miss without invoking the provider", async () => {
    const model = setup();
    let invoked = false;
    faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hello" }],
      sessionId: "no-such-session",
    }));
    expect(result.failureKind).toBe("session_not_found");
    expect(result.error).toBe("Pi session no-such-session is not live");
    expect(result.cancelled).toBe(false);
    expect(result.numTurns).toBe(0);
    expect(result.providerSessionId).toBe("no-such-session");
    expect(result.diagnostics.pi_error_code).toBe("pi_session_not_found");
    expect(invoked).toBe(false);
  });

  it("does not persist a failed resumed turn; the next resume sees the last good transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();
    const sessionId = first.providerSessionId;

    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" }),
    ]);
    const failed = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    expect(failed.error).toBe("boom");
    expect(failed.failureKind).toBeTruthy();

    let retryContext = null;
    faux.setResponses([
      (context) => { retryContext = context; return fauxAssistantMessage([fauxText("reply-3")]); },
    ]);
    const third = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-3" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    expect(third.error).toBeNull();
    expect(transcriptOf(retryContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-3",
    ]);
  });

  it("rolls back a resumed turn when a host-side throw lands in the outer catch (F10)", async () => {
    // The provider RESPONDS successfully (so the harness mutates the live
    // session), but a throwing resolveCustomPricing — invoked by estimateCost
    // AFTER the prompt ran — propagates into the OUTER catch. Without the F10
    // rollback the mutated turn leaks into the next resume; with it, the live
    // session is moved back to the pre-turn leaf.
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();
    const sessionId = first.providerSessionId;

    faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
    const failed = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
      resolveCustomPricing: () => { throw new Error("pricing resolver blew up"); },
    }));
    // Outer-catch path: surfaced as a (retryable) provider failure, not a success.
    expect(failed.error).toBeTruthy();
    expect(failed.cancelled).toBe(false);

    let retryContext = null;
    faux.setResponses([
      (context) => { retryContext = context; return fauxAssistantMessage([fauxText("reply-3")]); },
    ]);
    const third = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-3" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    expect(third.error).toBeNull();
    // The failed turn-2 (and its assistant reply-2) must be absent from the
    // resumed transcript — only the last good turn-1 + the new turn-3 remain.
    expect(transcriptOf(retryContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-3",
    ]);
  });

  it("rolls back a keep-alive resumed turn when a cancel lands at run-end after the provider succeeded (durable cancel TOCTOU)", async () => {
    // The provider RESPONDS successfully (mutating the live session), then a
    // cancel lands AFTER the run completed — modeled by flipping the abort signal
    // on the `capabilities_resolved` event, which fires immediately before the
    // session-lifecycle commit. The re-check there must take the rollback path so
    // the cancelled turn never leaks into the next resume.
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();
    const sessionId = first.providerSessionId;

    const lateSignal = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} };
    faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
    const cancelled = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
      abortSignal: lateSignal,
      onEvent: (event) => { if (event?.type === "capabilities_resolved") lateSignal.aborted = true; },
    }));
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.error).toBeNull();

    let retryContext = null;
    faux.setResponses([
      (context) => { retryContext = context; return fauxAssistantMessage([fauxText("reply-3")]); },
    ]);
    const third = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-3" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    expect(third.error).toBeNull();
    // The cancelled turn-2 (and reply-2) must be absent from the resumed
    // transcript — only the last good turn-1 + the new turn-3 remain.
    expect(transcriptOf(retryContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-3",
    ]);
  });

  it("registers no session without sessionKeepAlive", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
    }));
    expect(first.error).toBeNull();

    let invoked = false;
    faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
    const resume = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionId: first.providerSessionId,
    }));
    expect(resume.failureKind).toBe("session_not_found");
    expect(invoked).toBe(false);
  });

  it("rejects a concurrent resume of a busy session with session_busy", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    const sessionId = first.providerSessionId;

    // Gate the blocked run mid-turn so the session is observably busy.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    faux.setResponses([
      async () => { await gate; return fauxAssistantMessage([fauxText("reply-2")]); },
    ]);
    const blockedRun = generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const contended = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2b" }],
      sessionId,
    }));
    expect(contended.failureKind).toBe("session_busy");
    expect(contended.diagnostics.pi_error_code).toBe("pi_session_busy");

    release();
    const blocked = await blockedRun;
    expect(blocked.error).toBeNull();
    expect(blocked.text).toBe("reply-2");
  });

  it("reopens a durable jsonl session from disk after the live entry is dropped", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      piSessionsRoot: sessionsRoot,
    }));
    expect(first.error).toBeNull();

    // Dropping the live entry leaves the jsonl transcript on disk.
    await expect(disposeProviderSession(first.providerSessionId)).resolves.toBe(true);

    let resumedContext = null;
    faux.setResponses([
      (context) => { resumedContext = context; return fauxAssistantMessage([fauxText("reply-2")]); },
    ]);
    const resumed = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
      piSessionsRoot: sessionsRoot,
    }));
    expect(resumed.error).toBeNull();
    expect(resumed.text).toBe("reply-2");
    expect(transcriptOf(resumedContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-2",
    ]);
  });

  it("resumes a durable session across a restart by a caller-derived stable id (create-on-miss then reopen-from-disk) (F9)", async () => {
    // Simulates the cross-restart resume the harness relies on: the
    // conversationId→providerSessionId map is in-memory only, so after a restart
    // the harness has NO live entry and instead passes a STABLE id it derived
    // from the conversationId. On turn-1 that id has no live entry and no JSONL
    // on disk, so the bridge CREATES a durable session under it (create-on-miss).
    // Dropping the live registry entry models the process restart; turn-2 passes
    // the SAME derived id and must REOPEN the prior transcript from disk rather
    // than orphaning it in a fresh, randomly-named session.
    const model = setup();
    const root = mkdtempSync(join(tmpdir(), "pi-native-restart-"));
    try {
      const derivedId = "conversation-derived-stable-id";

      // Turn 1: requested id is set but nothing exists yet → create-on-miss.
      faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
      const first = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        sessionKeepAlive: true,
        sessionId: derivedId,
        piSessionsRoot: root,
      }));
      expect(first.error).toBeNull();
      expect(first.text).toBe("reply-1");
      // The bridge must echo back the SAME id the harness passed, so the harness
      // saves a consistent mapping.
      expect(first.providerSessionId).toBe(derivedId);
      // The durable transcript is on disk under the derived id.
      expect(countJsonlFiles(root)).toBe(1);

      // Model the restart: the live registry entry is gone, but the JSONL
      // survives on disk (durable repos are not deleted on dispose).
      await expect(disposeProviderSession(derivedId)).resolves.toBe(true);

      // Turn 2: same derived id, fresh process (no live entry) → reopen-from-disk.
      let resumedContext = null;
      faux.setResponses([
        (context) => { resumedContext = context; return fauxAssistantMessage([fauxText("reply-2")]); },
      ]);
      const second = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionKeepAlive: true,
        sessionId: derivedId,
        piSessionsRoot: root,
      }));
      expect(second.error).toBeNull();
      expect(second.text).toBe("reply-2");
      expect(second.providerSessionId).toBe(derivedId);
      // The prior turn-1 transcript was reopened from disk, not lost: turn-1 is
      // present, proving the restart resumed the same conversation.
      expect(transcriptOf(resumedContext)).toEqual([
        "user:turn-1",
        "assistant:reply-1",
        "user:turn-2",
      ]);
      // Still exactly one durable transcript — no orphaned second session.
      expect(countJsonlFiles(root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an in-memory resume miss (no piSessionsRoot) still fast-fails with session_not_found — create-on-miss is durable-only (F9)", async () => {
    // Guards the gate: create-on-miss fires ONLY on a durable-repo miss. Without
    // piSessionsRoot a resume miss must keep the existing per-process
    // session_not_found contract (no session is silently fabricated in memory).
    const model = setup();
    let invoked = false;
    faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hello" }],
      sessionId: "derived-but-no-durable-root",
      sessionKeepAlive: true,
    }));
    expect(result.failureKind).toBe("session_not_found");
    expect(result.diagnostics.pi_error_code).toBe("pi_session_not_found");
    expect(invoked).toBe(false);
  });

  it("serializes two concurrent cold resumes of an evicted durable session (one wins, the other returns session_busy)", async () => {
    const model = setup();
    // Fresh keep-alive turn with a durable jsonl on disk.
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      piSessionsRoot: sessionsRoot,
    }));
    expect(first.error).toBeNull();
    const sessionId = first.providerSessionId;

    // Evict the live entry but leave the durable jsonl on disk, so BOTH resumes
    // take the cold reopen-from-disk branch (the F4 race window).
    await expect(disposeProviderSession(sessionId)).resolves.toBe(true);

    // Gate the winning turn mid-run so the session is observably busy while the
    // loser races through the cold-resume path.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    faux.setResponses([
      async () => { await gate; return fauxAssistantMessage([fauxText("reply-2")]); },
    ]);

    // Fire BOTH cold resumes without an intervening await so the reopen await
    // (the shared jsonl repo's async open) interleaves them through the window.
    const optionsResume = runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
      piSessionsRoot: sessionsRoot,
    });
    const runA = generatePiNativeResponse("system", optionsResume);
    const runB = generatePiNativeResponse("system", optionsResume);

    // Let one claim busy and the other observe it, then release the gated turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const settled = await Promise.allSettled([runA, runB]);
    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    const results = settled.map((entry) => entry.value);

    const winners = results.filter((result) => result.error === null);
    const busy = results.filter((result) => result.failureKind === "session_busy");
    expect(winners).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(winners[0].text).toBe("reply-2");
    expect(busy[0].diagnostics.pi_error_code).toBe("pi_session_busy");
  });

  it("drops the durable jsonl session when a fresh run throws during execution", async () => {
    const model = setup();
    const root = mkdtempSync(join(tmpdir(), "pi-native-leak-"));
    try {
      // FRESH run: no sessionId/providerSessionId, so the bridge creates a new
      // durable jsonl session (piSessionsRoot set) at the top of the outer try,
      // BEFORE the run. We force a throw into the OUTER catch (F5's patch site)
      // by throwing from onEvent on the first event emitted after session
      // create (`provider_request_started`) — emitCaptured propagates it, and it
      // fires outside the inner harness.prompt try, so it lands in the outer
      // catch rather than the success/runError path. Without the catch-delete
      // the orphaned jsonl persists on disk and a later run resolving the same
      // root would reopen it as a silently-resumable session.
      faux.setResponses([fauxAssistantMessage([fauxText("never reached")])]);
      const failed = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-1" }],
        piSessionsRoot: root,
        onEvent: (event) => {
          if (event?.type === "provider_request_started") throw new Error("setup-boom");
        },
      }));
      expect(failed.error).toBe("setup-boom");
      const leakedSessionId = failed.providerSessionId;

      // No durable transcript may survive the failed fresh run.
      expect(countJsonlFiles(root)).toBe(0);

      // A later run against the (would-be) orphaned id must NOT resurrect the
      // failed run's transcript. With durable create-on-miss (F9), a durable
      // resume miss no longer fails with session_not_found; it CREATES a fresh
      // session under that id. The proof the orphan is gone is that the fresh
      // run sees ONLY its own turn-2 — never the leaked turn-1.
      let resumedContext = null;
      faux.setResponses([
        (context) => { resumedContext = context; return fauxAssistantMessage([fauxText("reply-2")]); },
      ]);
      const resume = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "turn-2" }],
        sessionId: leakedSessionId,
        piSessionsRoot: root,
      }));
      expect(resume.error).toBeNull();
      expect(resume.text).toBe("reply-2");
      // Only turn-2 — the failed turn-1 transcript was dropped, not silently resumed.
      expect(transcriptOf(resumedContext)).toEqual(["user:turn-2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bills a resumed run only for this run's messages, not the restored transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.numTurns).toBe(1);

    faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
    const second = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
    }));
    // The restored turn-1 assistant message must not be re-counted: the resumed
    // run reports exactly its own single turn and only its own assistant output
    // token, not the restored transcript's.
    expect(second.numTurns).toBe(1);
    expect(second.usage.output_tokens).toBe(first.usage.output_tokens);
  });

  it("disposeProviderSession drops the live native session", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();

    await expect(disposeProviderSession(first.providerSessionId)).resolves.toBe(true);

    let invoked = false;
    faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
    const resume = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionId: first.providerSessionId,
    }));
    expect(resume.failureKind).toBe("session_not_found");
    expect(invoked).toBe(false);
  });

  it("re-prompts once for structured output when a turn ends with no result", async () => {
    const model = setup();
    // First turn yields neither text nor a StructuredOutput call; the bridge
    // must re-prompt once with only StructuredOutput active, after which the
    // model submits the structured result.
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("thinking only")]),
      fauxAssistantMessage([fauxToolCall("StructuredOutput", { answer: 7 }, { id: "so-1" })]),
    ]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "give structured output" }],
      outputSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
        additionalProperties: false,
      },
    }));

    expect(result.error).toBeNull();
    expect(result.structuredResult).toEqual({ answer: 7 });
    expect(result.structuredResultSource).toBe("StructuredOutput");
    expect(result.diagnostics.structured_output_finalization_retry_attempts).toBe(1);
    expect(result.diagnostics.structured_output_finalization_retry_reason).toBe("empty_final_output");
    expect(result.diagnostics.structured_output_finalization_retry_failed).toBe(false);
    expect(result.runtimeWarnings.some(
      (warning) => warning?.warning_kind === "structured_output_finalization_retry",
    )).toBe(true);
  });
});
