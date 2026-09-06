import { afterEach, describe, expect, it } from "vitest";
import {
  hasHorizontalScrollAncestor,
  isMobileDrawerSwipe,
} from "./mobile-drawer-gesture";

describe("mobile drawer gestures", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("accepts deliberate swipes in the requested direction", () => {
    const start = { x: 180, y: 200 };

    expect(isMobileDrawerSwipe(start, { x: 244, y: 210 }, "right")).toBe(true);
    expect(isMobileDrawerSwipe({ x: 250, y: 200 }, { x: 186, y: 190 }, "left")).toBe(true);
    expect(isMobileDrawerSwipe(start, { x: 244, y: 210 }, "left")).toBe(false);
  });

  it("rejects short drags and vertically dominant scrolling", () => {
    const start = { x: 180, y: 200 };

    expect(isMobileDrawerSwipe(start, { x: 243, y: 200 }, "right")).toBe(false);
    expect(isMobileDrawerSwipe(start, { x: 250, y: 270 }, "right")).toBe(false);
  });

  it("leaves a native horizontal scroller in control", () => {
    const boundary = document.createElement("div");
    const scroller = document.createElement("div");
    const content = document.createElement("span");
    scroller.style.overflowX = "auto";
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 240 },
    });
    scroller.append(content);
    boundary.append(scroller);
    document.body.append(boundary);

    expect(hasHorizontalScrollAncestor(content, boundary)).toBe(true);

    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 120 });
    expect(hasHorizontalScrollAncestor(content, boundary)).toBe(false);
  });
});
