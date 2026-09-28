import { useSyncExternalStore } from "react";

export interface SettingsDraft {
  readonly model: string;
  readonly effort: string;
}

const drafts = new Map<string, SettingsDraft>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const notify = () => { for (const listener of listeners) listener(); };

export const getSettingsDraft = (sourceId: string): SettingsDraft | null => drafts.get(sourceId) ?? null;
export const useSettingsDraft = (sourceId: string): SettingsDraft | null =>
  useSyncExternalStore(subscribe, () => getSettingsDraft(sourceId), () => null);
export const setSettingsDraft = (sourceId: string, draft: SettingsDraft): void => {
  const previous = drafts.get(sourceId);
  if (previous?.model === draft.model && previous.effort === draft.effort) return;
  drafts.set(sourceId, draft);
  notify();
};
export const discardSettingsDraft = (sourceId: string): void => {
  if (drafts.delete(sourceId)) notify();
};
export const clearSettingsDraftIfEqual = (sourceId: string, saved: SettingsDraft): void => {
  const draft = getSettingsDraft(sourceId);
  if (draft?.model === saved.model && draft.effort === saved.effort) discardSettingsDraft(sourceId);
};
