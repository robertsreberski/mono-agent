/**
 * Render a tool payload for display. Tool arguments and results arrive as
 * whatever the provider sent, so a cyclic or otherwise unserializable value
 * must degrade to a string rather than throw inside a render.
 */
export const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
