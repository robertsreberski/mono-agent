/** Keep touch input surfaces inside the keyboard-reduced visual viewport.
 * The layout viewport (not innerHeight, which WebKit may already shrink) is
 * the baseline. Zoom has its own panning semantics and must remain browser-owned.
 */
export function installVisualViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => undefined;

  const root = document.documentElement;
  const touch = window.matchMedia("(hover: none), (pointer: coarse)");
  let frame: number | undefined;

  const clear = () => {
    root.classList.remove("keyboard-viewport");
    root.style.removeProperty("--app-viewport-height");
    root.style.removeProperty("--app-viewport-top");
  };
  const update = () => {
    frame = undefined;
    const active = touch.matches && viewport.scale === 1 && viewport.height > 0
      && (root.clientHeight - viewport.height > 80 || viewport.offsetTop !== 0);
    if (!active) {
      clear();
      return;
    }

    // Follow WebKit's reported box without writing document scroll. Resetting
    // scroll can erase the offset that keeps this active after a layout resize,
    // making the shell and browser repeatedly undo each other's adjustments.
    root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
    root.style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
    root.classList.add("keyboard-viewport");
  };
  const schedule = () => {
    if (frame === undefined) frame = window.requestAnimationFrame(update);
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, { passive: true });
  touch.addEventListener("change", schedule);
  schedule();

  return () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule);
    touch.removeEventListener("change", schedule);
    clear();
  };
}
