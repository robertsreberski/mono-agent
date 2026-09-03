import {
  MODEL_REFERENCE_ECHO_MAX_BYTES,
  MODEL_REFERENCE_REASON_MAX_BYTES,
  sanitizeModelReferenceText,
} from "@mono-agent/runtime-adapter";
import { describe, expect, it } from "vitest";

import { findTriggerOverrideIssues } from "../trigger-overrides.js";

const NEWLINE = String.fromCharCode(10);
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const echo = (value: string): string => sanitizeModelReferenceText(value, MODEL_REFERENCE_ECHO_MAX_BYTES);

/**
 * A per-trigger diagnostic quotes three pieces of operator-supplied text back: the trigger
 * label, the rejected value, and the parser's reason (itself one repair sentence plus one
 * echo). Nothing else in the sentence varies, so this is the whole envelope -- and it is what
 * `docs/runtime/backends.md` promises when it says a per-trigger value is bounded.
 */
const ENVELOPE_MAX_BYTES = 2 * MODEL_REFERENCE_ECHO_MAX_BYTES + MODEL_REFERENCE_REASON_MAX_BYTES + 128;

describe("findTriggerOverrideIssues bounds every value it quotes back", () => {
  it("quotes a short model override whole, unchanged", () => {
    const issues = findTriggerOverrideIssues([{ name: 'cron job "digest"', model: "codex:gpt-5.6-sol" }]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cron job "digest" has an invalid model override "codex:gpt-5.6-sol"');
    expect(issues[0]).toContain("use openai-codex:gpt-5.6-sol");
    expect(issues[0]!.split(NEWLINE)).toHaveLength(1);
  });

  it("escapes a newline in a model override instead of letting it forge a diagnostic line", () => {
    const model = `codex:gpt-5.6-sol${NEWLINE}[ok] Core config: everything fine`;

    const issues = findTriggerOverrideIssues([{ name: 'cron job "digest"', model }]);

    expect(issues[0]!.split(NEWLINE)).toHaveLength(1);
    expect(issues[0]).toContain(`"${echo(model)}"`);
    expect(issues[0]).toContain("\\n[ok] Core config");
  });

  it("clamps an oversized model override to the shared echo budget", () => {
    // The vehicle changed and the property did not. This used to be a megabyte of `x` as the
    // PROVIDER half, rejected because the reference parser had a byte ceiling. That ceiling is
    // gone -- what a model may be called is decided by providers, and both numbers tried refused
    // a model that really exists -- so an oversized value is no longer rejected for its size and
    // that fixture would now produce no issue at all to bound.
    //
    // The guarantee it was bought for is untouched and is what matters: when an oversized value
    // IS rejected, none of it reaches the diagnostic unclamped. `codex:` is the strongest form,
    // because the kernel parser interpolates the operator's whole model half into the repair it
    // names, so an unbounded value would produce an unbounded reason if this layer did not clamp.
    const model = `codex:${"x".repeat(1_000_000)}`;

    const issues = findTriggerOverrideIssues([{ name: 'cron job "digest"', model }]);

    expect(issues).toHaveLength(1);
    // The actionable half survives the clamp...
    expect(issues[0]).toContain("use openai-codex:");
    // ...and the megabyte does not.
    expect(issues[0]).not.toContain("x".repeat(1_000));
    expect(byteLength(issues[0]!)).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    expect(byteLength(issues[0]!)).toBeLessThan(1_000);
  });

  it("raises no issue at all for an oversized override that is nonetheless a valid reference", () => {
    // The other side of removing the ceiling, pinned so it is not quietly restored as a "fix".
    // A long `<provider>:<model>` is a reference like any other; length is not this layer's
    // business, and refusing one here would cost an operator a route that runs. It is bounded
    // where it is RENDERED, which is what the case above asserts.
    const model = `${"x".repeat(1_000_000)}:y`;

    expect(findTriggerOverrideIssues([{ name: 'cron job "digest"', model }])).toEqual([]);
  });

  it("escapes a newline in an effort override", () => {
    const effort = `extreme${NEWLINE}[ok] Core config: everything fine`;

    const issues = findTriggerOverrideIssues([{ name: 'webhook endpoint "results"', effort }]);

    expect(issues[0]!.split(NEWLINE)).toHaveLength(1);
    expect(issues[0]).toContain(`"${echo(effort)}"`);
  });

  it("clamps an oversized effort override to the shared echo budget", () => {
    const effort = "e".repeat(100_000);

    const issues = findTriggerOverrideIssues([{ name: 'webhook endpoint "results"', effort }]);

    expect(issues[0]).toContain(`"${echo(effort)}"`);
    expect(byteLength(issues[0]!)).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    expect(byteLength(issues[0]!)).toBeLessThan(1_000);
  });

  /**
   * A webhook endpoint `name` is an arbitrary operator string (`asOptionalString`), so the
   * label carrying it is untrusted text on the same diagnostic line as the value.
   */
  it("bounds and escapes the trigger label as well as the value", () => {
    const name = `webhook endpoint "${NEWLINE}[ok] Core config: everything fine"`;

    const issues = findTriggerOverrideIssues([{ name, model: "codex:gpt-5.6-sol" }]);

    expect(issues[0]!.split(NEWLINE)).toHaveLength(1);
    expect(issues[0]!.startsWith(echo(name))).toBe(true);
  });

  it("reports nothing for valid overrides", () => {
    expect(findTriggerOverrideIssues([
      { name: 'cron job "digest"', model: "openai-codex:gpt-5.6-sol", effort: "high" },
    ])).toEqual([]);
  });
});
