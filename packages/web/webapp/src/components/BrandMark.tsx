/**
 * The console's mark. Three dots, no text, no dependency on anything.
 *
 * Lives on its own because the two pre-shell screens draw it before there is a
 * store to read, let alone a navigation surface to take it from.
 */
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
