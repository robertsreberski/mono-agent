import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetDataUsage } from "../data-usage";

class ResizeObserverStub implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub;
HTMLElement.prototype.scrollIntoView ??= () => undefined;

/**
 * A loaded CI runner is slower than a developer's machine by more than the one
 * second Testing Library waits by default, and every `waitFor`/`findBy*` here
 * waits for something the app does asynchronously on purpose. Three seconds
 * stays inside Vitest's 5 s test timeout, so a condition that never becomes
 * true still fails with the assertion's own diagnosis rather than with the
 * test timeout's.
 */
configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  // The data meter throttles its publishes behind a trailing `window.setTimeout`
  // (see `data-usage.ts`), and in jsdom `window` IS the global, so that timer is
  // a live Node timer owned by no test. Left armed, it fires after Vitest has
  // torn the environment down, dereferences the deleted `window`, and is
  // reported as an unhandled error -- which fails a run in which every test
  // passed. The meter is module state by design, so the shared teardown is what
  // owns stopping it.
  resetDataUsage();
  cleanup();
  localStorage.clear();
});
