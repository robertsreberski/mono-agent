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
    const model = `${"x".repeat(1_000_000)}:y`;

    const issues = findTriggerOverrideIssues([{ name: 'cron job "digest"', model }]);

    expect(issues[0]).toContain(`"${echo(model)}"`);
    expect(byteLength(issues[0]!)).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    expect(byteLength(issues[0]!)).toBeLessThan(1_000);
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
