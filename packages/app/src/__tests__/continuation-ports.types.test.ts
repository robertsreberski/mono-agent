import { expectTypeOf, it } from "vitest";
import type { ContinuationHttpOperations, ContinuationOperatorOperations } from "../continuations/operation-ports.js";
import type { ContinuationServiceHandle } from "../continuation-service-types.js";

it("keeps lifecycle, raw secrets and mutable stores out of adapter ports", () => {
  expectTypeOf<Extract<keyof ContinuationHttpOperations, "store" | "secret" | "claimBindings" | "stop" | "lifecycleAbort">>().toEqualTypeOf<never>();
  expectTypeOf<keyof ContinuationOperatorOperations>().toEqualTypeOf<"retry" | "cancel" | "resolveUnknown" | "health">();
  expectTypeOf<ContinuationOperatorOperations["resolveUnknown"]>().toEqualTypeOf<ContinuationServiceHandle["resolveUnknown"]>();
});

function assertAdapterTypes(operations: ContinuationHttpOperations): void {
  // @ts-expect-error HTTP cannot reach the writer
  operations.store;
  // @ts-expect-error HTTP cannot mutate owner configuration
  operations.maxResultBytes = 0;
  expectTypeOf<Parameters<ContinuationHttpOperations["acceptResult"]>[2]>().toEqualTypeOf<unknown>();
}
void assertAdapterTypes;
