export interface DrawerGesturePoint {
  readonly x: number;
  readonly y: number;
}

export type DrawerGestureDirection = "left" | "right";

export const MOBILE_DRAWER_EDGE_WIDTH = 32;

const MINIMUM_SWIPE_DISTANCE = 64;
const HORIZONTAL_DOMINANCE_RATIO = 1.25;

export function startsAtMobileDrawerEdge(point: DrawerGesturePoint): boolean {
  return point.x >= 0 && point.x <= MOBILE_DRAWER_EDGE_WIDTH;
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
