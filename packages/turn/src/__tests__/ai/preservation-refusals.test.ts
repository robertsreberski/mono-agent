import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { clearProactivePreservationRefusal, proactivePreservationGuard } from "../../execution/pi/compaction/preservation-refusals.js";

it("bounds a stable session across harness instances at the existing idle growth threshold", () => {
  const scope = randomUUID();
  proactivePreservationGuard(scope, {}, "fictional-input", 100000).refused(true);
  expect(proactivePreservationGuard(scope, {}, "fictional-input", 109999).suppressed).toBe(true);
  expect(proactivePreservationGuard(scope, {}, "fictional-input", 110000).suppressed).toBe(false);
  expect(proactivePreservationGuard(scope, {}, "changed-fictional-input", 100000).suppressed).toBe(false);
  expect(proactivePreservationGuard(randomUUID(), {}, "fictional-input", 100000).suppressed).toBe(false);
  clearProactivePreservationRefusal(scope, {});
  expect(proactivePreservationGuard(scope, {}, "fictional-input", 100000).suppressed).toBe(false);
});
it("does not record unpaid refusals and isolates unscoped harnesses without a global fallback key", () => {
  const harness = {};
  proactivePreservationGuard(undefined, harness, "fictional-input", 1000).refused(false);
  expect(proactivePreservationGuard(undefined, harness, "fictional-input", 1000).suppressed).toBe(false);
  proactivePreservationGuard(undefined, harness, "fictional-input", 1000).refused(true);
  expect(proactivePreservationGuard(undefined, harness, "fictional-input", 9191).suppressed).toBe(true);
  expect(proactivePreservationGuard(undefined, harness, "fictional-input", 9192).suppressed).toBe(false);
  expect(proactivePreservationGuard(undefined, {}, "fictional-input", 1000).suppressed).toBe(false);
  clearProactivePreservationRefusal(undefined, harness);
  expect(proactivePreservationGuard(undefined, harness, "fictional-input", 1000).suppressed).toBe(false);
});
