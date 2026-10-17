import { expect, it } from "vitest";
import type { RuntimeModelRef, RuntimeBridgeId } from "@mono-agent/turn/ai";
import type { RuntimeModelReference, RuntimeResult } from "@mono-agent/turn/host/types";

it("keeps the converted model contract and readonly/unknown host projection strict", () => {
  if (false) {
    const ref = null as unknown as RuntimeModelRef;
    const record: Record<string, string> = ref; // Type aliases retain implicit index assignability.
    void record;
    const host = null as unknown as RuntimeModelReference;
    // @ts-expect-error host model identity is readonly, unlike the internal core record.
    host.provider = "fictional";
    // @ts-expect-error the model contract still requires the canonical reference.
    const missing: RuntimeModelRef = { provider: "fictional", model: "fixture" };
    // @ts-expect-error the bridge discriminant remains Pi-only.
    const bridge: RuntimeBridgeId = "fictional";
    const result = null as unknown as RuntimeResult;
    // @ts-expect-error structured output still requires unknown-value narrowing.
    const output: string = result.structuredResult;
    void [missing, bridge, output];
  }
  expect(true).toBe(true);
});
