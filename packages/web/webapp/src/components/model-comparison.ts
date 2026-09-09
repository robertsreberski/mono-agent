export function sameModel(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return left !== undefined
    && left !== null
    && left.length > 0
    && right !== undefined
    && right !== null
    && right.length > 0
    && left === right;
}
