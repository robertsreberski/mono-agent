import { describe, expect, it, beforeEach } from "vitest";

import {
  annotateProviderErrorMessage,
  describeErrorCause,
  recentTransportErrorCode,
  recordTransportErrorForTests,
  resetTransportErrorProbeForTests,
} from "../../ai/providers/transport-errors.js";
import { failureKindForPiError } from "../../ai/providers/pi-native/result-builder.js";
import { retryableProviderFailureInfo } from "../../ai/failure.js";

beforeEach(() => {
  resetTransportErrorProbeForTests();
});

describe("describeErrorCause", () => {
  it("returns the code from a nested cause, not the outer error", () => {
    // Exactly the shape Node produces for a stalled response body.
    const err = new TypeError("terminated", {
      cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
    });
    expect(describeErrorCause(err)).toBe("UND_ERR_BODY_TIMEOUT");
  });

  it("walks more than one level", () => {
    const root = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const middle = new Error("socket failure", { cause: root });
    const outer = new TypeError("terminated", { cause: middle });
    expect(describeErrorCause(outer)).toBe("ECONNRESET");
  });

  it("falls back to a distinctive error name when no code is present", () => {
    const err = new TypeError("terminated", {
      cause: Object.assign(new Error("stalled"), { name: "BodyTimeoutError" }),
    });
    expect(describeErrorCause(err)).toBe("BodyTimeoutError");
  });

  it("returns null when the chain carries nothing useful", () => {
    expect(describeErrorCause(new Error("terminated"))).toBeNull();
    expect(describeErrorCause(new TypeError("terminated", { cause: new Error("nope") }))).toBeNull();
    expect(describeErrorCause(null)).toBeNull();
    expect(describeErrorCause("a string")).toBeNull();
  });

  it("terminates on a self-referential cause chain", () => {
    const err = new Error("loop");
    err.cause = err;
    expect(() => describeErrorCause(err)).not.toThrow();
    expect(describeErrorCause(err)).toBeNull();
  });
});

describe("annotateProviderErrorMessage", () => {
  it("names the real reason behind a bare 'terminated'", () => {
    const err = new TypeError("terminated", {
      cause: Object.assign(new Error("timeout"), { code: "UND_ERR_BODY_TIMEOUT" }),
    });
    const result = annotateProviderErrorMessage("terminated", err);
    expect(result.message).toBe("terminated (UND_ERR_BODY_TIMEOUT)");
    expect(result.causeCode).toBe("UND_ERR_BODY_TIMEOUT");
    expect(result.causeSource).toBe("cause_chain");
  });

  it("leaves descriptive provider errors untouched", () => {
    const message = "Your input exceeds the context window of this model.";
    const result = annotateProviderErrorMessage(message, new Error("x", { cause: { code: "NOPE" } }));
    expect(result.message).toBe(message);
    expect(result.causeCode).toBeNull();
  });

  it("does not double-annotate an already-annotated message", () => {
    const already = "terminated (UND_ERR_BODY_TIMEOUT)";
    const err = new TypeError("terminated", { cause: { code: "ECONNRESET" } });
    expect(annotateProviderErrorMessage(already, err).message).toBe(already);
  });

  it("falls back to the correlated probe when the cause was already flattened away", () => {
    // pi-agent-core keeps only `error.message`, so no cause survives here.
    recordTransportErrorForTests("UND_ERR_BODY_TIMEOUT");
    const result = annotateProviderErrorMessage("terminated", undefined);
    expect(result.message).toBe("terminated (UND_ERR_BODY_TIMEOUT, correlated)");
    expect(result.causeSource).toBe("transport_probe");
  });

  it("refuses to guess when the window holds conflicting codes", () => {
    recordTransportErrorForTests("UND_ERR_BODY_TIMEOUT");
    recordTransportErrorForTests("ECONNRESET");
    const result = annotateProviderErrorMessage("terminated", undefined);
    expect(result.message).toBe("terminated");
    expect(result.causeCode).toBeNull();
  });

  it("ignores transport errors older than the correlation window", () => {
    recordTransportErrorForTests("ECONNRESET", Date.now() - 60_000);
    expect(recentTransportErrorCode()).toBeNull();
    expect(annotateProviderErrorMessage("terminated", undefined).message).toBe("terminated");
  });

  it("prefers an exact cause chain over correlation", () => {
    recordTransportErrorForTests("ECONNRESET");
    const err = new TypeError("terminated", { cause: { code: "UND_ERR_BODY_TIMEOUT" } });
    const result = annotateProviderErrorMessage("terminated", err);
    expect(result.causeCode).toBe("UND_ERR_BODY_TIMEOUT");
    expect(result.causeSource).toBe("cause_chain");
  });

  it("passes null and empty messages through unchanged", () => {
    expect(annotateProviderErrorMessage(null).message).toBeNull();
    expect(annotateProviderErrorMessage("").message).toBe("");
  });
});

describe("annotation preserves existing failure classification", () => {
  // The annotation must not change routing. `terminated` is matched with a word
  // boundary, so the appended code has to leave both the failure kind and the
  // retry subkind exactly where they were.
  const annotated = "terminated (UND_ERR_BODY_TIMEOUT)";

  it("still classifies as provider_unavailable, not context_limit", () => {
    const diagnostics = { context_compactions: 0, context_tokens_estimate_max: 1000, context_compaction_trigger_tokens: 190_400 };
    expect(failureKindForPiError(annotated, diagnostics)).toBe("provider_unavailable");
    expect(failureKindForPiError("terminated", diagnostics)).toBe("provider_unavailable");
  });

  it("still reports the 'terminated' retry subkind and stays retryable", () => {
    const before = retryableProviderFailureInfo({ errorText: "terminated", failureKind: "provider_unavailable" });
    const after = retryableProviderFailureInfo({ errorText: annotated, failureKind: "provider_unavailable" });
    expect(after.retryable).toBe(true);
    expect(after.subkind).toBe(before.subkind);
    expect(after.subkind).toBe("terminated");
  });

  it("still reclassifies as context_limit when compaction already fired", () => {
    const diagnostics = { context_compactions: 2 };
    expect(failureKindForPiError(annotated, diagnostics)).toBe("context_limit");
  });
});
