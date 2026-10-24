import { expect, expectTypeOf, it } from "vitest";

import type { DurableProcessJobRecord } from "../process-jobs/process-jobs-store.js";
import { boundedNewestRecords } from "../process-jobs/policy.js";
import { boundOutput, boundedSafeDiagnostic, outputPreview, internalOutputPreview, processJobWakePrompt } from "../process-jobs/presentation.js";

it("preserves UTF-8 output limits and the exact truncation marker", () => {
  const bounded = boundOutput("🙂".repeat(30), 32);
  expect(bounded.truncated).toBe(true);
  expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(32);
  expect(bounded.text.endsWith("\n[output truncated]\n")).toBe(true);
  expect(bounded.text).not.toContain("�");
  expect(boundOutput("🙂", 1)).toEqual({ text: "", truncated: true });
});

it("keeps empty previews and fixed safe diagnostics bounded", () => {
  expect(outputPreview("", "", 100)).toBe("(no output)");
  expect(outputPreview("", "", 3)).toBe("(no");
  expect(boundedSafeDiagnostic("unknown wake-settlement failure")).toBe("unknown wake-settlement failure");
});

it("accepts readonly snapshots without granting mutation to policy consumers", () => {
  expectTypeOf<Parameters<typeof boundedNewestRecords>[0]>().toEqualTypeOf<readonly DurableProcessJobRecord[]>();
  const records: Parameters<typeof boundedNewestRecords>[0] = [];
  if (false) {
    // @ts-expect-error policy inputs are readonly arrays
    records.push({});
  }
});

it("keeps a detached result reference before a bounded tail, including runner-truncated JSON", () => {
  for (const reference of ["[full result saved to: /artifacts/child-full.txt]", "[full result not saved: artifact persistence unavailable]"]) {
    const stdout = JSON.stringify({ resultReference: reference, answer: "notes ".repeat(10_000) });
    for (const output of [stdout, stdout.slice(0, 20_000)]) {
      expect(internalOutputPreview(output, "", 200).split("\n")[0]).toBe(reference);
    }
  }
});

it("keeps full result metadata in the wake outside a one-character output preview", () => {
  const reference = "[full result not saved: artifact persistence unavailable]";
  const projection = { output: { preview: "x" } } as Parameters<typeof processJobWakePrompt>[0];
  const wake = processJobWakePrompt(projection, undefined, false, reference);
  const body = JSON.parse(wake.split("<untrusted_process_job_result>\n")[1]!.split("\n</untrusted_process_job_result>")[0]!);
  expect(Object.keys(body)[0]).toBe("resultReference");
  expect(body.resultReference).toBe(reference);
});
