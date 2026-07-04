import { useEffect, useState } from "react";

/**
 * True when the viewport is phone-width. Drives the few layout switches that
 * pure inline CSS (clamp/min/env) can't express — stacking a row into a column,
 * dropping a fixed column width, repositioning an absolute menu. Prefer inline
 * `clamp()` / `min()` / `env(safe-area-inset-*)` for everything else.
 *
 * @param maxWidth breakpoint in px (default 640 — the tablet/phone boundary)
 */
export function useIsMobile(maxWidth = 640): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (): void => setIsMobile(mql.matches);
    onChange();
    // addEventListener is the modern API; older Safari used addListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);
  return isMobile;
}
