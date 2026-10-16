import { expectTypeOf, it } from "vitest";

import type { AgentHarnessOptions } from "../harness/contracts.js";
import type { SessionContextCapabilities } from "../harness/session-capabilities.js";
import type { ManagedModelSwitchStorageLease, ModelSwitchStorageSource } from "../history/contracts.js";
import type { DurableConversationHistoryStore } from "../durable-history.js";
import type { ModelSwitchPayloadStore } from "../model-switch-payloads.js";
import { createSessionRuntimeResolver } from "../session-runtime.js";

it("keeps structural owner ports equal to the concrete implementation shapes", () => {
  expectTypeOf<ModelSwitchStorageSource>().toEqualTypeOf<Awaited<ReturnType<DurableConversationHistoryStore["modelSwitchStorageSource"]>>>();
  expectTypeOf<ReturnType<ManagedModelSwitchStorageLease["read"]>>().toEqualTypeOf<ReturnType<ModelSwitchPayloadStore["read"]>>();
  expectTypeOf<Parameters<typeof createSessionRuntimeResolver>[0]>().toEqualTypeOf<Pick<AgentHarnessOptions, "runtime" | "model" | "runtimeForModel">>();
  expectTypeOf<Awaited<ReturnType<NonNullable<AgentHarnessOptions["subagentInstancesFor"]>>>>().toEqualTypeOf<NonNullable<SessionContextCapabilities["subagentInstances"]>>();
});
