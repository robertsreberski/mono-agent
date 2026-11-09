import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as policy from "../lib/continuity-e2-policy.mjs";
it("golden-pins the complete E2 policy export inventory, independent of lookup constants", async () => {
  const golden = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-policy.json", import.meta.url)));
  const actual = JSON.parse(JSON.stringify(policy, (_, v) => typeof v === "bigint" ? v.toString() : v));
  expect(actual).toEqual(golden);
  expect(Object.keys(policy).filter(k => typeof policy[k] !== "function").sort()).toEqual(Object.keys(golden).sort());
  expect(Object.isFrozen(policy.E2_ASSUMPTIONS)).toBe(true); expect(Object.isFrozen(policy.E2_REGISTRY_LAYOUT[0])).toBe(true);
});
it("owns the E2 registry and schemas without inheriting a lookup request envelope", () => {
  expect(join("/Users/example", ...policy.E2_REGISTRY_LAYOUT.map(([part]) => part))).toBe("/Users/example/.local/state/mono-agent/lcc-e2/consumed-v1");
  expect(policy.USD_UNITS).toBe(1000000000n);
  expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("rmax"); expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("inputMax");
  expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("outputMax"); expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("rates");
  expect(policy.E2_ASSUMPTIONS.literalInput).toBe("max_serialized_bytes_over_3_and_engine_full_request");
  expect(policy.E2_ASSUMPTIONS.reservation).toBe("actual-input-envelope-times-catalog-input-plus-output-limit-times-catalog-output");
  expect(policy.E2_BINDING_FIELDS).toEqual(["code", "build", "catalog", "protocol", "source", "probes", "keys", "soul", "schedule", "account", "tools", "deadlines", "capUnits"]);
});
