import { useSyncExternalStore } from "react";

/**
 * Whether this tab is on screen.
 *
 * A poll is a promise to show the operator something new. A backgrounded tab
 * shows nobody anything, so a poll running there is pure spend — and on the
 * phone this console is installed on, a backgrounded tab is the normal state.
 *
 * Read through `useSyncExternalStore` rather than an effect so a component that
 * pauses on this cannot render one frame believing it is visible when it is not.
 */
/**
 * One `visibilitychange` listener for the document, however many components ask.
 *
 * A transcript can hold dozens of pollers; registering a listener each would put
 * dozens on `document` for one boolean. Attached with the first subscriber and
 * detached with the last, the same way the data mode's sources are.
 */
const listeners = new Set<() => void>();

const announce = (): void => {
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  if (listeners.size === 0) document.addEventListener("visibilitychange", announce);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("visibilitychange", announce);
  };
};

export const documentVisible = (): boolean => document.visibilityState !== "hidden";

/**
 * Server-side and in a document that never reports: visible. A poll that never
 * starts is worse than one that runs when it did not need to.
 */
const alwaysVisible = (): boolean => true;

export const useDocumentVisible = (): boolean =>
  useSyncExternalStore(subscribe, documentVisible, alwaysVisible);
