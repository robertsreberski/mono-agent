import { describe, expect, it } from "vitest";
import {
  isMobileDrawerSwipe,
  MOBILE_DRAWER_EDGE_WIDTH,
  startsAtMobileDrawerEdge,
} from "./mobile-drawer-gesture";

describe("mobile drawer gestures", () => {
  it("starts only inside the bounded left-edge target", () => {
    expect(startsAtMobileDrawerEdge({ x: 0, y: 200 })).toBe(true);
    expect(startsAtMobileDrawerEdge({ x: MOBILE_DRAWER_EDGE_WIDTH, y: 200 })).toBe(true);
    expect(startsAtMobileDrawerEdge({ x: MOBILE_DRAWER_EDGE_WIDTH + 1, y: 200 })).toBe(false);
    expect(startsAtMobileDrawerEdge({ x: -1, y: 200 })).toBe(false);
  });

  it("accepts deliberate swipes in the requested direction", () => {
    const start = { x: 12, y: 200 };

    expect(isMobileDrawerSwipe(start, { x: 76, y: 210 }, "right")).toBe(true);
    expect(isMobileDrawerSwipe({ x: 250, y: 200 }, { x: 186, y: 190 }, "left")).toBe(true);
    expect(isMobileDrawerSwipe(start, { x: 76, y: 210 }, "left")).toBe(false);
  });

  it("rejects short drags and vertically dominant scrolling", () => {
    const start = { x: 12, y: 200 };

    expect(isMobileDrawerSwipe(start, { x: 75, y: 200 }, "right")).toBe(false);
    expect(isMobileDrawerSwipe(start, { x: 82, y: 270 }, "right")).toBe(false);
  });
});
