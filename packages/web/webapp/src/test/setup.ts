import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverStub implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub;
HTMLElement.prototype.scrollIntoView ??= () => undefined;

afterEach(() => {
  cleanup();
  localStorage.clear();
});
