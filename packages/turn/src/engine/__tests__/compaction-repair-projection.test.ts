import { expect, it } from "vitest";
import { projectContext, projectInheritedContext } from "../request-projection.js";
import { buildHarnessSessionContext } from "../session-context.js";
import { estimateTokens, prepareCompaction } from "../compaction-kit/compaction.js";

const message = (id: string, content = id, extra: any = {}) => ({ type: "message", id, parentId: "native-parent", seq: 40,
  timestamp: 1, message: { role: "user", content, timestamp: 1, ...extra } });
const checkpoint = (inheritedCoverage?: any) => ({ type: "compaction", id: "checkpoint", parentId: "old", seq: 41, timestamp: 2,
  summary: "Fictional predecessor summary", retainedTail: [], checkpoint: {
    summaryMessage: { role: "compactionSummary", summary: "Fictional predecessor summary", timestamp: 2 },
    ...(inheritedCoverage ? { inheritedCoverage } : {}),
  } });
const repair = (tipId: string | null, calls: any[] = []) => ({ tipId, calls, cause: "crashed", timestamp: 3 });
const inherited = { messages: [{ role: "user", content: "Fictional inherited prefix", timestamp: 0 }],
  coverage: { version: 1, sources: [{ journalId: "predecessor", sourceTipId: "tip", sourceSeq: 3, sourceDigest: "a".repeat(64) }] } };

it.each([undefined, [], [repair("old")], [repair("unknown")], [repair(null)], [repair("old"), repair("unknown"), repair(null)]])(
  "keeps the same native array and entries for ineffective repairs %j", repairs => {
    const entries: any[] = [message("old"), checkpoint(), message("active")];
    const result = projectContext(entries, { mode: "compaction", repairs }).entries!;
    expect(result).toBe(entries);
    result.forEach((entry, index) => expect(entry).toBe(entries[index]));
    expect(buildHarnessSessionContext(entries, { repairs: repairs ?? [] })).toEqual(buildHarnessSessionContext(entries));
    expect(prepareCompaction(result, { keepRecentTokens: 0 }).value.previousSummary).toBe(entries[1]!.summary);
  });

it.each(["checkpoint", "active", "draft", "branch"])("flattens a live zero-call account anchored at %s, with prompt parity", tip => {
  const entries: any[] = [message("old"), checkpoint(), message("active"),
    message("draft", "Failed fictional draft", { role: "assistant", stopReason: "error" }),
    { type: "branch_summary", id: "branch", summary: "Fictional branch", fromId: "active", timestamp: 2 }];
  const repairs = [repair("old"), repair(tip), repair("unknown")];
  const messages = buildHarnessSessionContext(entries, { repairs });
  const result = projectContext(entries, { mode: "compaction", repairs }).entries!;
  // Pin the existing flattening representation, including synthetic identities.
  expect(result).toEqual(messages.map((value, index) => ({ type: "message", message: value,
    id: entries.find(entry => entry.type === "message" && entry.message === value)?.id ?? `derived:repair:${index}`,
    parentId: null, timestamp: value.timestamp, seq: index })));
  expect(messages.filter(value => value.interruptionCause === "crashed")).toHaveLength(1);
  // Prompt-local remapping remains unchanged: checkpoint -> null, and hidden
  // draft/non-message anchors -> the preceding visible native message.
  expect(messages.findIndex(value => value.interruptionCause === "crashed")).toBe(tip === "checkpoint" ? 0 : 2);
  expect(JSON.stringify(messages)).toContain("no tool was replayed");
  expect(result.every(entry => entry.type === "message")).toBe(true);
});

it("matches the prompt selector's index-zero checkpoint/null-anchor edge without changing it", () => {
  const entries: any[] = [checkpoint(), message("active")];
  const repairs = [repair(null)];
  const result = projectContext(entries, { mode: "compaction", repairs }).entries!;
  expect(result).not.toBe(entries);
  expect(result.map(entry => entry.message)).toEqual(buildHarnessSessionContext(entries, { repairs }));
  expect(result[0].message).toMatchObject({ projectionOnly: true, interruptionCause: "crashed" });
});

it("preserves returned-unplaced results and notices, and the no-checkpoint ids/parentId/seq shape", () => {
  const returned = { role: "toolResult", toolCallId: "call", toolName: "FictionalEffect", isError: false,
    content: [{ type: "text", text: "Fictional outcome observed once" }], timestamp: 2 };
  const entries: any[] = [message("input"), message("assistant", "", { role: "assistant", stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call", name: "FictionalEffect", arguments: {} }] })];
  const repairs = [repair("assistant", [{ callId: "call", name: "FictionalEffect", messageId: "assistant", returned }])];
  const result = projectContext(entries, { mode: "compaction", repairs }).entries!;
  expect(result.map(entry => entry.id)).toEqual(["input", "assistant", "derived:repair:2", "derived:repair:3"]);
  expect(result.map(entry => entry.parentId)).toEqual([null, null, null, null]);
  expect(result.map(entry => entry.seq)).toEqual([0, 1, 2, 3]);
  expect(result[0].message).toBe(entries[0]!.message);
  expect(result[1].message).toBe(entries[1]!.message);
  expect(result[2].message).toEqual({ ...returned, projectionOnly: true });
  expect(result[3].message.content[0].text).toContain("no tool was replayed");
  expect(result.map(entry => entry.message)).toEqual(buildHarnessSessionContext(entries, { repairs }));
});

it("keeps a live checkpoint-era returned-unplaced result while ignoring older checkpoints and retained origins", () => {
  const earlier = { ...checkpoint(), id: "earlier-checkpoint" };
  const current = checkpoint();
  const retained = message("retained-origin");
  const returned = { role: "toolResult", toolCallId: "call", toolName: "FictionalEffect", isError: false,
    content: [{ type: "text", text: "Fictional returned outcome" }], timestamp: 4 };
  const call = message("call-entry", "", { role: "assistant", stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call", name: "FictionalEffect", arguments: {} }] });
  const entries = [retained, earlier, { ...current, retainedTail: [retained.message] }, call];
  const stale = [repair("earlier-checkpoint"), repair("retained-origin"), repair(null)];
  expect(projectContext(entries, { mode: "compaction", repairs: stale }).entries).toBe(entries);
  const repairs = [...stale, repair("call-entry", [{ callId: "call", name: "FictionalEffect", messageId: "call-entry", returned }])];
  const result = projectContext(entries, { mode: "compaction", repairs }).entries!;
  expect(result.every(entry => entry.type === "message")).toBe(true);
  expect(result.map(entry => entry.message.role)).toEqual(["compactionSummary", "user", "assistant", "toolResult", "user"]);
  expect(result[3].message).toEqual({ ...returned, projectionOnly: true });
  expect(result[4].message.interruptionCause).toBe("crashed");
  expect(result.map(entry => entry.message)).toEqual(buildHarnessSessionContext(entries, { repairs }));
});

it.each([null, "input"])("keeps no-checkpoint zero-call repair at %s live", tipId => {
  const entries: any[] = [message("input")];
  const projected = projectContext(entries, { mode: "compaction", repairs: [repair(tipId)] }).entries!;
  expect(projected).not.toBe(entries);
  expect(projected).toHaveLength(2);
  expect(projected.some(entry => entry.message.interruptionCause === "crashed")).toBe(true);
});

it.each([false, true])("keeps inherited prefix/composed coverage and non-retainable behavior, composed=%s", composed => {
  const entries: any[] = [message("old"), checkpoint(composed ? inherited.coverage : undefined), message("active", "Fictional growth. ".repeat(100))];
  for (const repairs of [[repair("old")], [repair("checkpoint")]]) {
    const native = projectContext(entries, { mode: "compaction", repairs }).entries!;
    const result = projectInheritedContext(entries, inherited, { mode: "compaction", repairs });
    expect(result.nonRetainablePrefixLength).toBe(composed ? 0 : 1);
    if (composed) expect(result.entries).toEqual(native);
    else {
      expect(result.entries![0]).toMatchObject({ id: "inherited:0", parentId: null, seq: 0, message: inherited.messages[0] });
      expect(result.entries!.slice(1)).toEqual(native);
    }
    if (repairs[0]!.tipId === "old") {
      if (composed) expect(result.entries).toBe(entries);
      else expect(result.entries![2]).toBe(entries[1]);
    }
    const prepared = prepareCompaction(result.entries, { keepRecentTokens: 10000 }, { nonRetainablePrefixLength: result.nonRetainablePrefixLength });
    expect(prepared.ok).toBe(true);
    expect(prepared.value.messagesToSummarize).toEqual(composed ? [] : inherited.messages);
    expect(prepared.value.retainedTail).not.toContain(inherited.messages[0]);
    const prompt = projectInheritedContext(entries, inherited, { repairs });
    expect("coverage" in prompt && prompt.coverage).toEqual({ source: "native", repair: "prompt-only", entryCount: entries.length });
    const current = buildHarnessSessionContext(entries, { repairs });
    expect(prompt.messages).toEqual(composed ? current : [...inherited.messages, ...current]);
  }
});

it.each(["error", "aborted", "deferred"])("restores native failed-%s draft estimates/preparation, including mid-run includeFailed:true", stopReason => {
  const draft = message("draft", "Fictional failed draft. ".repeat(1000), { role: "assistant", stopReason });
  const entries: any[] = [message("old"), checkpoint(), draft, message("active", "Fictional latest request")];
  const baseline = projectContext(entries, { mode: "compaction" }).entries!;
  const stale = projectContext(entries, { mode: "compaction", repairs: [repair("old")] }).entries!;
  expect(stale).toBe(baseline);
  for (const includeFailed of [false, true]) {
    const before = projectContext(baseline, { includeFailed }).messages!;
    const after = projectContext(stale, { includeFailed }).messages!;
    expect(after).toEqual(before);
    expect(after.includes(draft.message)).toBe(includeFailed);
    expect(after.reduce((sum, value) => sum + estimateTokens(value), 0)).toBe(before.reduce((sum, value) => sum + estimateTokens(value), 0));
  }
  const settings = { keepRecentTokens: 0 };
  const prepared = prepareCompaction(stale, settings).value;
  expect(prepared).toEqual(prepareCompaction(baseline, settings).value);
  expect(prepared.messagesToSummarize).toContain(draft.message);
  // Contrast the former raw-list gate: flattening with includeFailed:false lost it.
  const formerlyFlattened = buildHarnessSessionContext(entries, { repairs: [repair("old")] });
  expect(formerlyFlattened).not.toContain(draft.message);
});
