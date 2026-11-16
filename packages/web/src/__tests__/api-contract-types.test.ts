import { expectTypeOf, it } from "vitest";
import type { WebEvent, WebEventPayloadMap, WebEventType, WebMessageDelta, WebTypedEvent } from "../contracts.js";

it("adds exhaustive discriminated SSE types without narrowing the legacy event", () => {
  expectTypeOf<keyof WebEventPayloadMap>().toEqualTypeOf<WebEventType>();
  expectTypeOf<WebTypedEvent>().toExtend<WebEvent>();
  expectTypeOf<Extract<WebTypedEvent, { type: "message.delta" }>["payload"]>().toEqualTypeOf<WebMessageDelta>();
  expectTypeOf<WebEvent["payload"]>().toBeUnknown();
});

it("keeps analytics DTOs typed at the public route boundary", async () => {
  type Dtos = import("../api-contract.js").WebApiDtos;
  expectTypeOf<Dtos["ApiUsageAnalytics"]>().toEqualTypeOf<import("../contracts.js").WebUsageAnalytics>();
  expectTypeOf<Dtos["ApiProviderUsageHistory"]>().toEqualTypeOf<import("@mono-agent/contracts").ProviderUsageHistory>();
});
