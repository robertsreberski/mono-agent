/**
 * Whether the operator has something typed or staged and not yet sent.
 *
 * assistant-ui's composer is in-memory: the text in it and the files staged
 * beside it exist only in that runtime, and nothing writes them anywhere. A
 * reload therefore destroys them -- which matters because the console applies a
 * staged service-worker build by reloading, and the one moment it looks safe to
 * do that (the tab has just come back, nothing is running) is exactly the moment
 * an operator is likeliest to be part-way through a message.
 *
 * A module flag rather than a hook, for two reasons: there is exactly one
 * composer on screen at a time, and the question is asked from an event handler
 * that must read the state as of THAT moment. Subscribing to it would re-render
 * whatever asked on every keystroke, for an answer nobody draws.
 */
let unsent = false;

/** Called by the composer whenever what it is holding becomes empty or stops being. */
export const noteComposerDraft = (hasDraft: boolean): void => {
  unsent = hasDraft;
};

/** Read at the moment of a decision. Never rendered. */
export const hasUnsentComposerDraft = (): boolean => unsent;

/** Test hook, and the composer's own unmount: nothing is held any more. */
export const resetComposerDraft = (): void => {
  unsent = false;
};
