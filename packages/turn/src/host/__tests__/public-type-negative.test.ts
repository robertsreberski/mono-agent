import { expect, it } from "vitest";
import type { RuntimeModelRef, RuntimeBridgeId } from "@mono-agent/turn/ai";
import type { MonoRuntimeAttemptResolution, RuntimeEventLike, RuntimeModelReference, RuntimeResult } from "@mono-agent/turn/host/types";

import type { RuntimeLiveInputMessage } from "../../contracts/live-input.js";

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
    const telemetry = null as unknown as RuntimeEventLike;
    // @ts-expect-error open telemetry values require narrowing, not implicit any.
    const count: number = telemetry.extension;
    const absent: RuntimeLiveInputMessage = { body: "fixture" };
    // @ts-expect-error absent optional identity is distinct from explicit undefined.
    const explicitUndefined: RuntimeLiveInputMessage = { body: "fixture", id: undefined };
    // @ts-expect-error host-owned settlement callbacks cannot be replaced.
    absent.accepted = () => "recorded";
    // @ts-expect-error attempt plugins cannot inject a protected key, even undefined.
    const protectedOptions: NonNullable<MonoRuntimeAttemptResolution["options"]> = { sandbox: undefined };
    const render = null as unknown as typeof import("@mono-agent/turn/agent").renderResumeSnapshot;
    const seed = null as unknown;
    const resumed: string = render(seed);
    render({ turns: [{ text: "x" }] });
    type IsAny<T> = 0 extends (1 & T) ? true : false;
    const responseAny: IsAny<Awaited<ReturnType<typeof import("@mono-agent/turn/ai").generateEngineTurnResponse>>> = true;
    const nativeConfigAny: IsAny<ReturnType<typeof import("@mono-agent/turn/ai").runtimeCapabilities>["native_runtime_config"]> = true;
    type McpOptions = NonNullable<Parameters<typeof import("../../tools/mcp/tools.js").initPiMcpTools>[2]>;
    const mcpOptions = null as unknown as McpOptions;
    // @ts-expect-error lifecycle timeout exemptions remain readonly.
    mcpOptions.mcpCallNoTotalTimeoutTools?.push("fixture:lifecycle");
    // @ts-expect-error rich-output callbacks receive no payload argument.
    const invalidMcpCallback: McpOptions = { onRichOutput: (payload: string) => { void payload; } };
    const mcpRegistration = null as unknown as import("../../contracts/mcp-apps.js").RuntimeMcpAppRegistration;
    // @ts-expect-error app-visible tool registration is immutable.
    mcpRegistration.appVisibleTools.push("fixture");
    // @ts-expect-error retained connection identity cannot be replaced.
    mcpRegistration.connection.connectionId = "fictional";
    const mcpHost = null as unknown as import("../../contracts/mcp-apps.js").RuntimeMcpAppHost;
    // @ts-expect-error host registration callbacks must return the retention receipt.
    mcpHost.register = async () => undefined;
    void invalidMcpCallback;
    void [missing, bridge, output, count, explicitUndefined, protectedOptions, resumed, responseAny, nativeConfigAny];
  }
  expect(true).toBe(true);
});
