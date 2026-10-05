// Read-only, best-effort evidence from Pi v4 JSONL. Never open through the Pi repo:
// its cold-open path repairs torn transactions by rewriting the source file.
import { SessionStore, validateJournalHeader } from "@mono-agent/harness";
import { JournalReader } from "@mono-agent/harness/journal-reader.js";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat as statPath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const MAX_FILE = 32 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const safeId = /^[A-Za-z0-9_-]+$/u;
const valid = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => { throw new Error("Durable Pi salvage unavailable"); };

/** @returns {Promise<{completed: {name:string, result:string}[], outcomeUnknown: {name:string}[], omittedCompleted:number, omittedUnknown:number, draftText?:string, additionalOutcomesUnknown:boolean}>} */
export async function salvageDurableNativeSession(sessionId, sessionsRoot) {
  if (typeof sessionId !== "string" || !safeId.test(sessionId) || typeof sessionsRoot !== "string" || !sessionsRoot) fail();
  const root = resolve(sessionsRoot);
  if (!(await lstat(root)).isDirectory()) fail();
  const canonicalRoot = await realpath(root);
  const suffix = `_${encodeURIComponent(sessionId)}.jsonl`;
  const matches = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const parent = join(root, dir.name);
    for (const file of await readdir(parent, { withFileTypes: true })) {
      if (!file.name.endsWith(suffix)) continue;
      if (!file.isFile()) fail();
      matches.push(join(parent, file.name));
    }
  }
  const owned = [];
  let skippedJournal = false;
  const journals = join(root, "mono-v2", "journals");
  let journalFiles = [];
  try { journalFiles = await readdir(journals, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const file of journalFiles) {
    if (!file.name.endsWith(".jsonl")) continue;
    if (!file.isFile()) { skippedJournal = true; continue; }
    const path = join(journals, file.name);
    let reader;
    try {
      reader = await JournalReader.open(path, root);
      const header = await reader.readHeader(); validateJournalHeader(header);
      if (header?.format === "mono-harness" && header.version === 2 && header.id === sessionId) owned.push(path);
    } catch { skippedJournal = true; }
    finally { await reader?.close(); }
  }
  // An unreadable journal may be the requested clean-break successor. Never
  // silently return its stale legacy source when ownership is uncertain.
  if (owned.length > 1 || (skippedJournal && owned.length === 0)) fail();
  if (owned.length === 1) matches.splice(0, matches.length, owned[0]);
  if (matches.length !== 1) fail();
  const path = matches[0];
  if (owned.includes(path)) return salvageOwnedJournal(path, root, sessionId);
  const before = await lstat(path);
  if (!before.isFile() || before.size > MAX_FILE) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_FILE) fail();
    // O_NOFOLLOW protects the last component only. A session directory may have
    // been swapped for a symlink since readdir; re-resolve the opened pathname and
    // require its canonical target to remain within the trusted sessions root.
    const canonicalFile = await realpath(path);
    if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) fail();
    const current = await statPath(canonicalFile);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) fail();
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail();
  } finally { await handle.close(); }
  const finalNewline = bytes.lastIndexOf(10);
  if (finalNewline < 0) fail();
  const torn = finalNewline !== bytes.length - 1;
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, finalNewline)).split("\n");
  if (lines.some((line) => Buffer.byteLength(line) > MAX_LINE || !line)) fail();
  const header = JSON.parse(lines.shift());
  const entries = new Map();
  const ids = new Set();
  const values = new Map();
  const pending = new Map();
  let openTurn = false;
  if (!valid(header) || header.kind !== "header" || header.v !== 4 || header.storageVersion !== 1 || header.id !== sessionId) fail();
  let seq = 0;
  for (const line of lines) {
    const transaction = JSON.parse(line);
    const writes = Array.isArray(transaction) ? transaction : [transaction];
    if (!writes.length) fail();
    for (const write of writes) {
      if (!valid(write) || !Number.isSafeInteger(write.seq) || write.seq <= seq) fail();
      seq = write.seq;
      if (write.kind === "entry") {
        if (typeof write.id !== "string" || ids.has(write.id) || (write.parentId !== null && !entries.has(write.parentId)) || !Number.isSafeInteger(write.timestamp)) fail();
        ids.add(write.id); entries.set(write.id, write);
      } else if (write.kind === "usage") {
        if (typeof write.id !== "string" || ids.has(write.id)) fail();
        ids.add(write.id);
      } else if (write.kind === "value" || write.kind === "list") {
        if (typeof write.namespace !== "string" || typeof write.key !== "string" || !["set", "delete", "append"].includes(write.op)
          || (write.kind === "value" && write.op === "append") || (write.kind === "list" && write.op === "set")) fail();
        if (write.kind === "value" && write.namespace === "pi.branch.tip") {
          if (write.op === "delete") values.delete(write.key);
          else values.set(write.key, write.value);
        }
        if (write.namespace.startsWith("pi.pending.")) {
          const address = `${write.namespace}\0${write.key}`;
          if (write.op === "delete") pending.delete(address);
          else pending.set(address, write);
        }
      } else fail();
    }
  }
  return collectEvidence(entries, values, pending, openTurn, torn);
}

async function collectEvidence(entries, values, pending, openTurn, torn, materialize = async (entry) => entry) {
  const tip = values.get("main");
  if (tip !== undefined && tip !== null && (typeof tip !== "string" || !entries.has(tip))) fail();
  const branch = [];
  const seen = new Set();
  for (let id = tip; id !== undefined && id !== null;) {
    if (seen.has(id)) fail();
    seen.add(id);
    const entry = entries.get(id);
    if (!entry) fail();
    branch.push(entry);
    id = entry.parentId;
  }
  branch.reverse();
  const calls = new Map();
  const results = new Map();
  let draftText;
  for (const reference of branch) {
    const entry = await materialize(reference);
    if (entry.type !== "message" || !valid(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      if (message.stopReason !== "aborted" && message.stopReason !== "error") {
        const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
        if (text) draftText = text.slice(-4096);
      }
      for (const block of message.content) if (block?.type === "toolCall") {
        if (typeof block.id !== "string" || typeof block.name !== "string" || calls.has(block.id)) fail();
        calls.set(block.id, { name: block.name, seq: entry.seq });
      }
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || results.has(message.toolCallId)) fail();
      const excerpt = Array.isArray(message.content) ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text.slice(-4096)).join("\n").slice(-4096) : "";
      results.set(message.toolCallId, { message: { toolName: message.toolName, content: [{ type: "text", text: excerpt }] }, seq: entry.seq });
    }
  }
  // Pi can durably stage an assistant message before placing it on a branch.
  // Its calls have no branch-placed result even if a result is staged too.
  const stagedCalls = new Map();
  let unclassifiedPending = false;
  const stageAssistant = (message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      unclassifiedPending = true;
      return;
    }
    for (const block of message.content) if (block?.type === "toolCall") {
      if (typeof block.id !== "string" || typeof block.name !== "string" || !block.id || !block.name) {
        unclassifiedPending = true;
      } else if (!calls.has(block.id)) {
        if (stagedCalls.has(block.id) && stagedCalls.get(block.id) !== block.name) unclassifiedPending = true;
        stagedCalls.set(block.id, block.name);
      }
    }
  };
  for (const write of pending.values()) {
    if (write.namespace !== "pi.pending.entry" || write.kind !== "value"
      || !valid(write.value) || write.value.type !== "message" || !valid(write.value.payload)) {
      unclassifiedPending = true;
      continue;
    }
    stageAssistant(write.value.payload);
  }
  // A committed entry may have been inserted before a tip advance. Exclude
  // messages reachable from explicit sibling branches, but conservatively
  // classify unattached assistant calls as unknown, never as completed.
  const attached = new Set(seen);
  for (const [name, otherTip] of values) if (name !== "main") {
    if (typeof otherTip !== "string" || !entries.has(otherTip)) fail();
    const walked = new Set();
    for (let id = otherTip; id !== null;) {
      if (walked.has(id)) fail();
      walked.add(id);
      const entry = entries.get(id);
      if (!entry) fail();
      attached.add(id);
      id = entry.parentId;
    }
  }
  for (const [id, reference] of entries) {
    if (attached.has(id) || reference.type !== "message") continue;
    const entry = await materialize(reference);
    if (!valid(entry.message)) { unclassifiedPending = true; continue; }
    if (entry.message.role === "assistant") stageAssistant(entry.message);
    else if (entry.message.role === "toolResult") unclassifiedPending = true;
  }
  const completed = [];
  const outcomeUnknown = [];
  for (const [id, call] of calls) {
    const placed = results.get(id);
    const result = placed?.message;
    if (result && placed.seq > call.seq && result.toolName === call.name) {
      const content = Array.isArray(result.content) ? result.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
      completed.push({ name: call.name, result: content.slice(-4096) });
    } else outcomeUnknown.push({ name: call.name });
  }
  for (const name of stagedCalls.values()) outcomeUnknown.push({ name });
  // Orphaned or mismatched results cannot attest to a call's outcome.
  return { completed: completed.slice(-8), outcomeUnknown: outcomeUnknown.slice(-8),
    omittedCompleted: Math.max(0, completed.length - 8), omittedUnknown: Math.max(0, outcomeUnknown.length - 8),
    ...(draftText ? { draftText } : {}), additionalOutcomesUnknown: torn || openTurn || unclassifiedPending || results.size > completed.length || tip === undefined };
}

async function salvageOwnedJournal(path, root, sessionId) {
  const reader = await JournalReader.open(path, root);
  try {
    const header = await reader.readHeader(); validateJournalHeader(header);
    if (header.id !== sessionId || header.format !== "mono-harness" || header.version !== 2) fail();
    const store = new SessionStore(header, [], { read: (address) => reader.read(address) });
    let first = true;
    const evidence = await reader.scan((record, address) => {
      if (first) { first = false; return; }
      store.apply(record, address);
    });
    const result = await collectEvidence(store.entries, new Map([["main", store.tip]]), new Map(),
      (await store.getOpenTurns()).length > 0, evidence.torn, (entry) => store.getEntry(entry.id));
    const visible = new Set((await store.getEntries()).map((entry) => entry.id));
    for (const call of store.validator.calls.values()) {
      if (!call.result || call.placed || !visible.has(call.messageId)) continue;
      const returned = await store.getReturnedOutcome(call.operationId, call.callId);
      if (!returned) continue;
      const text = returned.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text.slice(-4096)).join("\n").slice(-4096);
      const at = result.outcomeUnknown.findIndex((item) => item.name === call.name);
      if (at >= 0) result.outcomeUnknown.splice(at, 1);
      result.completed.push({ name: call.name, result: text });
    }
    result.omittedCompleted += Math.max(0, result.completed.length - 8); result.completed = result.completed.slice(-8);
    return result;
  } finally { await reader.close(); }
}
