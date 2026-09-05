/**
 * What a message delta MEANS, as data.
 *
 * The server diffs a message's parts into ops and the console replays them, and
 * the two must read an op the same way or a streamed transcript quietly drifts
 * from what a re-read would serve. Both sides drive their own implementation
 * from this one table rather than each inventing its own reading.
 *
 * Deliberately dependency-free: it is imported from BOTH packages, so it names
 * no type from either. `as const` keeps every literal exact, and the annotated
 * assignment each side makes on import is what proves these are valid parts and
 * ops in that side's own vocabulary.
 *
 * Unchanged slots share their part OBJECT with the previous array on purpose:
 * the diff treats an identical reference as an untouched slot, which is what
 * lets a 1,000-frame answer cost one `append` per flush instead of a full copy
 * of the transcript.
 */
const PARTS = {
  alpha: { type: "text", text: "alpha" },
  alphaGrown: { type: "text", text: "alpha and more" },
  alphaShrunk: { type: "text", text: "alp" },
  alphaCopy: { type: "text", text: "alpha" },
  alphaReasoning: { type: "reasoning", text: "alpha" },
  why: { type: "reasoning", text: "why" },
  whyGrown: { type: "reasoning", text: "why not" },
  toolRunning: { type: "tool-call", toolCallId: "t1", toolName: "Read", status: "running" },
  toolComplete: { type: "tool-call", toolCallId: "t1", toolName: "Read", result: "body", status: "complete" },
  failed: { type: "error", code: "provider_unavailable", message: "boom" },
} as const;

export const MESSAGE_DELTA_VECTORS = [
  {
    name: "opens a transcript with its first part",
    prev: [],
    next: [PARTS.alpha],
    ops: [{ op: "set", index: 0, part: PARTS.alpha }],
  },
  {
    name: "grows a text part by its tail",
    prev: [PARTS.alpha],
    next: [PARTS.alphaGrown],
    ops: [{ op: "append", index: 0, delta: " and more" }],
  },
  {
    name: "grows a reasoning part by its tail",
    prev: [PARTS.alpha, PARTS.why],
    next: [PARTS.alpha, PARTS.whyGrown],
    ops: [{ op: "append", index: 1, delta: " not" }],
  },
  {
    name: "replaces a tool call in the slot it already holds",
    prev: [PARTS.alpha, PARTS.toolRunning],
    next: [PARTS.alpha, PARTS.toolComplete],
    ops: [{ op: "set", index: 1, part: PARTS.toolComplete }],
  },
  {
    name: "sets every index the array gained",
    prev: [PARTS.alpha],
    next: [PARTS.alpha, PARTS.toolComplete, PARTS.failed],
    ops: [
      { op: "set", index: 1, part: PARTS.toolComplete },
      { op: "set", index: 2, part: PARTS.failed },
    ],
  },
  {
    name: "truncates before re-setting a spliced array",
    prev: [PARTS.alpha, PARTS.toolComplete, PARTS.why],
    next: [PARTS.toolComplete, PARTS.whyGrown],
    ops: [
      { op: "truncate", length: 2 },
      { op: "set", index: 0, part: PARTS.toolComplete },
      { op: "set", index: 1, part: PARTS.whyGrown },
    ],
  },
  {
    name: "truncates and says nothing else when the survivors did not move",
    prev: [PARTS.alpha, PARTS.why, PARTS.toolComplete],
    next: [PARTS.alpha, PARTS.why],
    ops: [{ op: "truncate", length: 2 }],
  },
  {
    name: "says nothing about an array nothing touched",
    prev: [PARTS.alpha, PARTS.toolComplete],
    next: [PARTS.alpha, PARTS.toolComplete],
    ops: [],
  },
  {
    name: "says nothing about a text part that only lost its identity",
    prev: [PARTS.alpha],
    next: [PARTS.alphaCopy],
    ops: [],
  },
  {
    name: "sets rather than appends when a part changed type",
    prev: [PARTS.alpha],
    next: [PARTS.alphaReasoning],
    ops: [{ op: "set", index: 0, part: PARTS.alphaReasoning }],
  },
  {
    name: "sets rather than appends when text shrank",
    prev: [PARTS.alpha],
    next: [PARTS.alphaShrunk],
    ops: [{ op: "set", index: 0, part: PARTS.alphaShrunk }],
  },
] as const;
