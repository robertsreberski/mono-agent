export interface DrawerGesturePoint {
  readonly x: number;
  readonly y: number;
}

export type DrawerGestureDirection = "left" | "right";

const MINIMUM_SWIPE_DISTANCE = 64;
const HORIZONTAL_DOMINANCE_RATIO = 1.25;
const NATIVE_HORIZONTAL_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

export function hasHorizontalScrollAncestor(
  target: Element | null,
  boundary: Element,
): boolean {
  let current = target;
  while (current) {
    if (current instanceof HTMLElement) {
      const overflowX = window.getComputedStyle(current).overflowX;
      if (
        NATIVE_HORIZONTAL_OVERFLOW.has(overflowX)
        && current.scrollWidth > current.clientWidth
      ) return true;
    }
    if (current === boundary) break;
    current = current.parentElement;
  }
  return false;
}

export function isMobileDrawerSwipe(
  start: DrawerGesturePoint,
  end: DrawerGesturePoint,
  direction: DrawerGestureDirection,
): boolean {
  const horizontalDistance = direction === "right"
    ? end.x - start.x
    : start.x - end.x;
  const verticalDistance = Math.abs(end.y - start.y);

  return horizontalDistance >= MINIMUM_SWIPE_DISTANCE
    && horizontalDistance >= verticalDistance * HORIZONTAL_DOMINANCE_RATIO;
}
