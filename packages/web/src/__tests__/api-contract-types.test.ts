import { expectTypeOf, it } from "vitest";
import type { WebEvent, WebEventPayloadMap, WebEventType, WebMessageDelta, WebTypedEvent } from "../contracts.js";

it("adds exhaustive discriminated SSE types without narrowing the legacy event", () => {
  expectTypeOf<keyof WebEventPayloadMap>().toEqualTypeOf<WebEventType>();
  expectTypeOf<WebTypedEvent>().toExtend<WebEvent>();
  expectTypeOf<Extract<WebTypedEvent, { type: "message.delta" }>["payload"]>().toEqualTypeOf<WebMessageDelta>();
  expectTypeOf<WebEvent["payload"]>().toBeUnknown();
});
