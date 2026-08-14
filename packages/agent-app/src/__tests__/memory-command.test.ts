import * as bujoMemory from "@mono-agent/memory/bujo";
import type { MemoryBundleExportErrorCode } from "@mono-agent/memory/bujo";
import { MemorySearchError } from "@mono-agent/memory/search";
import type { MemorySearchErrorCode } from "@mono-agent/memory/search";
import { describe, expect, it } from "vitest";

import {
  classifyImportApplyFailure,
  classifyImportPrepareFailure,
  classifyMemoryBundleExportFailure,
  isFtsFallbackEligible,
} from "../memory-command.js";
import type { MemoryRecallSettings } from "../memory-recall.js";

const semanticSettings: MemoryRecallSettings = {
  root: "/memory",
  embeddings: { provider: "ollama", model: "test-embed" },
};

const fallbackMemorySearchCodes = [
  "embedding_circuit_open",
  "embedding_request_failed",
  "embedding_response_invalid",
  "invalid_embedding_options",
] as const satisfies readonly MemorySearchErrorCode[];

describe("memory bundle error classification", () => {
  const exportCodes = [
    "export_destination_invalid",
    "export_pending_work",
    "export_source_changed",
    "export_source_invalid",
    "export_failed",
  ] as const satisfies readonly MemoryBundleExportErrorCode[];

  it.each(exportCodes)("preserves the typed export failure %s", (code) => {
    const error = new bujoMemory.MemoryBundleExportError(code, "private package detail");

    expect(classifyMemoryBundleExportFailure(bujoMemory.MemoryBundleExportError, error)).toBe(code);
  });

  it("does not trust an export-error lookalike", () => {
    const lookalike = Object.assign(new Error("private package detail"), {
      name: "MemoryBundleExportError",
      code: "export_pending_work",
    });

    expect(classifyMemoryBundleExportFailure(bujoMemory.MemoryBundleExportError, lookalike))
      .toBe("export_failed");
  });

  it("recognizes an explicit id-conflict code only inside a typed bounded cause chain", () => {
    const conflict = Object.assign(new Error("private merge detail"), { code: "id_conflict" });
    const error = new bujoMemory.MemoryBundleImportError("import_prepare_failed", undefined, conflict);

    expect(classifyImportPrepareFailure(bujoMemory.MemoryBundleImportError, error))
      .toBe("import_conflict");
  });

  it.each([
    [
      "an untyped top-level code",
      Object.assign(new Error("private input"), { code: "import_derived_drift" }),
    ],
    [
      "an arbitrary cause object",
      new bujoMemory.MemoryBundleImportError(
        "import_prepare_failed",
        undefined,
        { code: "id_conflict" },
      ),
    ],
    [
      "arbitrary user text",
      new bujoMemory.MemoryBundleImportError(
        "import_prepare_failed",
        undefined,
        new Error("user text says id_conflict and import_bundle_invalid"),
      ),
    ],
  ] as const)("does not classify from %s", (_label, error) => {
    expect(classifyImportPrepareFailure(bujoMemory.MemoryBundleImportError, error))
      .toBe("import_prepare_failed");
  });

  it("stops before an explicit code beyond the finite cause bound", () => {
    let cause: Error = Object.assign(new Error("private merge detail"), { code: "id_conflict" });
    for (let depth = 0; depth < 8; depth += 1) {
      cause = new Error("bounded wrapper", { cause });
    }
    const error = new bujoMemory.MemoryBundleImportError("import_prepare_failed", undefined, cause);

    expect(classifyImportPrepareFailure(bujoMemory.MemoryBundleImportError, error))
      .toBe("import_prepare_failed");
  });

  it("terminates on a cyclic typed cause chain", () => {
    const cause = new Error("cyclic") as Error & { cause?: unknown };
    cause.cause = cause;
    const error = new bujoMemory.MemoryBundleImportError("import_prepare_failed", undefined, cause);

    expect(classifyImportPrepareFailure(bujoMemory.MemoryBundleImportError, error))
      .toBe("import_prepare_failed");
  });

  it("preserves typed import prepare and apply codes", () => {
    expect(classifyImportPrepareFailure(
      bujoMemory.MemoryBundleImportError,
      new bujoMemory.MemoryBundleImportError("import_derived_drift"),
    )).toBe("import_derived_drift");
    expect(classifyImportApplyFailure(
      bujoMemory,
      new bujoMemory.MemoryBundleImportError("import_pending_work"),
    )).toEqual(["import_pending_work", false, undefined]);
    expect(classifyImportApplyFailure(
      bujoMemory,
      new bujoMemory.MemoryBundleImportError("import_apply_failed_recovered", "/private/backup"),
    )).toEqual(["import_apply_failed_recovered", true, "/private/backup"]);
  });
});

describe("isFtsFallbackEligible", () => {
  it.each(fallbackMemorySearchCodes)("accepts the typed provider failure code %s", (code) => {
    expect(isFtsFallbackEligible(semanticSettings, new MemorySearchError(code, "provider unavailable"))).toBe(true);
  });

  it("accepts a real fetch failure with a structured network cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    const error = Object.assign(new TypeError("fetch failed"), { cause });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("uses intrinsic TypeError identity even when its mutable name is changed", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    const error = Object.assign(new TypeError("fetch failed"), { cause, name: "Error" });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("accepts bounded AggregateError network causes", () => {
    const nested = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
    const error = new AggregateError([new AggregateError([nested], "nested fetch failures")], "fetch failed");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(true);
  });

  it("bounds a huge root AggregateError fan-out before reading or enqueueing every entry", () => {
    const error = new AggregateError(new Array(200_000).fill(null), "many failures");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("bounds a huge nested AggregateError fan-out before reading or enqueueing every entry", () => {
    const nested = new AggregateError(new Array(200_000).fill(null), "many nested failures");
    const error = new AggregateError([nested], "fetch failed");

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("recognizes a network failure at the exact traversal bound", () => {
    const failures = Array.from({ length: 16 }, () => new Error("unrelated failure"));
    failures[15] = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });

    expect(isFtsFallbackEligible(semanticSettings, new AggregateError(failures, "fetch failed"))).toBe(true);
  });

  it("does not read or recognize a network failure beyond the traversal bound", () => {
    const error = new AggregateError(new Array<Error | null>(17).fill(null), "fetch failed");
    let beyondBoundReads = 0;
    Object.defineProperty(error.errors, 16, {
      configurable: true,
      get() {
        beyondBoundReads += 1;
        return Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
      },
    });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
    expect(beyondBoundReads).toBe(0);
  });

  it("terminates on cyclic cause graphs", () => {
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = error;

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("accepts an intrinsic DOM AbortError even when an own name property tries to hide it", () => {
    const timeout = new DOMException("This operation was aborted", "AbortError");
    Object.defineProperty(timeout, "name", { configurable: true, value: "Error" });

    expect(isFtsFallbackEligible(semanticSettings, timeout)).toBe(true);
  });

  it.each([
    [
      "an ordinary Error renamed AbortError",
      () => Object.assign(new Error("programming failure"), { name: "AbortError" }),
    ],
    [
      "an ordinary Error renamed TypeError with a plain network-shaped cause",
      () => Object.assign(new Error("programming failure"), {
        name: "TypeError",
        cause: { code: "ECONNREFUSED" },
      }),
    ],
    [
      "a real TypeError whose plain cause carries an arbitrary errors array",
      () => Object.assign(new TypeError("fetch failed"), {
        cause: {
          errors: [Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
        },
      }),
    ],
    [
      "a real TypeError with a throwing cause getter",
      () => {
        const error = new TypeError("fetch failed");
        Object.defineProperty(error, "cause", {
          configurable: true,
          get() {
            throw new Error("cause getter exploded");
          },
        });
        return error;
      },
    ],
  ] as const)("reviewer honesty matrix rejects %s without replacing the original failure", (_label, createError) => {
    expect(isFtsFallbackEligible(semanticSettings, createError())).toBe(false);
  });

  it("ignores an arbitrary errors array on a non-aggregate TypeError", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      errors: [Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
    });

    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it.each([
    [
      "AggregateError.errors",
      () => {
        const error = new AggregateError([], "fetch failed");
        Object.defineProperty(error, "errors", {
          configurable: true,
          get() {
            throw new Error("errors getter exploded");
          },
        });
        return error;
      },
    ],
    [
      "nested Error.code",
      () => {
        const cause = new Error("lookup failed");
        Object.defineProperty(cause, "code", {
          configurable: true,
          get() {
            throw new Error("code getter exploded");
          },
        });
        return Object.assign(new TypeError("fetch failed"), { cause });
      },
    ],
    [
      "AggregateError.errors array entry",
      () => {
        const errors = new Array<Error>(1);
        Object.defineProperty(errors, 0, {
          configurable: true,
          get() {
            throw new Error("errors entry getter exploded");
          },
        });
        const aggregate = new AggregateError([], "fetch failed");
        Object.defineProperty(aggregate, "errors", { configurable: true, value: errors });
        return aggregate;
      },
    ],
  ] as const)("fails closed when %s inspection throws", (_label, createError) => {
    expect(isFtsFallbackEligible(semanticSettings, createError())).toBe(false);
  });

  it.each([
    ["a bare TypeError", new TypeError("request failed")],
    [
      "a programming TypeError whose message mentions ECONNREFUSED",
      new TypeError("Cannot read properties of undefined (reading 'ECONNREFUSED')"),
    ],
    ["an invariant Error whose message mentions embedding", new Error("embedding adapter invariant violated")],
    [
      "a fetch-shaped TypeError with an unknown cause code",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      }),
    ],
    [
      "a TypeError with only a top-level network code",
      Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
    ],
    [
      "a genuine TypeError with only a plain-object network cause",
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    ],
    [
      "an ordinary Error renamed AggregateError with an errors array",
      Object.assign(new Error("fetch failed"), {
        name: "AggregateError",
        errors: [Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
      }),
    ],
    [
      "an untyped lookalike provider error",
      Object.assign(new Error("provider failed"), {
        name: "MemorySearchError",
        code: "embedding_request_failed",
      }),
    ],
    ["an unknown non-error cause", { cause: { code: "ECONNREFUSED" } }],
  ])("rejects %s", (_label, error) => {
    expect(isFtsFallbackEligible(semanticSettings, error)).toBe(false);
  });

  it("never falls back without configured local embeddings", () => {
    const providerError = new MemorySearchError("embedding_request_failed", "provider unavailable");

    expect(isFtsFallbackEligible({ root: "/memory" }, providerError)).toBe(false);
    expect(isFtsFallbackEligible({
      supermemory: { baseUrl: "https://example.invalid", container: "agent" },
    }, providerError)).toBe(false);
  });
});
