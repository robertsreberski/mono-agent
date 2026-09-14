import { useSyncExternalStore } from "react";

// Console-local preference, following data-mode's storage + document fallback.
export type ComposerEnterMode = "send" | "newline";
export const COMPOSER_ENTER_MODE_KEY = "mono-agent:composer-enter-mode";
export const defaultComposerEnterMode = (): ComposerEnterMode => "newline";
const platformName = (): string => typeof navigator === "undefined" ? "" : navigator.platform;
const usesCommandKey = (platform: string): boolean => /Mac|iPhone|iPad|iPod/i.test(platform);
export const composerEnterHint = (mode: ComposerEnterMode, platform = platformName()): string => mode === "send"
  ? "↵ to send · ⇧↵ newline"
  : `${usesCommandKey(platform) ? "⌘↵" : "Ctrl+↵"} to send · ↵ newline`;
export const composerSteerHint = (platform = platformName()): string =>
  `${usesCommandKey(platform) ? "⌘⇧↵" : "Ctrl+Shift+↵"} steer`;
const listeners = new Set<() => void>();
let sessionMode: ComposerEnterMode | undefined;
const notify = () => { for (const listener of listeners) listener(); };

export function readComposerEnterMode(): ComposerEnterMode {
  if (sessionMode !== undefined) return sessionMode;
  try {
    const stored = localStorage.getItem(COMPOSER_ENTER_MODE_KEY);
    if (stored === "send" || stored === "newline") return stored;
  } catch { /* Storage refusal retains the document's choice below. */ }
  // Plain Enter is a newline everywhere. Only an explicit preference can change it.
  const mode = defaultComposerEnterMode();
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
