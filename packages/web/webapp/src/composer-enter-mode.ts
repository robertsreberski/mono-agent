import { useSyncExternalStore } from "react";

// Console-local preference, following data-mode's storage + document fallback.
export type ComposerEnterMode = "send" | "newline";
export const COMPOSER_ENTER_MODE_KEY = "mono-agent:composer-enter-mode";
export const TOUCH_PRIMARY_QUERY = "(pointer: coarse) and (not (any-pointer: fine))";
export const defaultComposerEnterMode = (touchPrimary: boolean): ComposerEnterMode =>
  touchPrimary ? "newline" : "send";
export const composerEnterHint = (mode: ComposerEnterMode): string => mode === "send"
  ? "Enter sends · Shift+Enter newline"
  : "Enter newline · Cmd/Ctrl+Enter sends";
const listeners = new Set<() => void>();
let sessionMode: ComposerEnterMode | undefined;
const notify = () => { for (const listener of listeners) listener(); };

export function readComposerEnterMode(): ComposerEnterMode {
  if (sessionMode !== undefined) return sessionMode;
  try {
    const stored = localStorage.getItem(COMPOSER_ENTER_MODE_KEY);
    if (stored === "send" || stored === "newline") return stored;
  } catch { /* Storage refusal retains the document's choice below. */ }
  // Resolve ONCE, not from a live media subscription. Persist even the default.
  const mode = defaultComposerEnterMode(window.matchMedia?.(TOUCH_PRIMARY_QUERY).matches === true);
  persist(mode);
  return mode;
}
function persist(mode: ComposerEnterMode): void {
  sessionMode = mode;
  try {
    localStorage.setItem(COMPOSER_ENTER_MODE_KEY, mode);
    sessionMode = undefined;
  } catch { /* This document still remembers the choice. */ }
}
export function writeComposerEnterMode(mode: ComposerEnterMode): void {
  persist(mode);
  notify();
}
const onStorage = (event: StorageEvent) => {
  if (event.key !== null && event.key !== COMPOSER_ENTER_MODE_KEY) return;
  sessionMode = undefined;
  notify();
};
function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}
export const useComposerEnterMode = (): ComposerEnterMode =>
  useSyncExternalStore(subscribe, readComposerEnterMode, () => "newline");
