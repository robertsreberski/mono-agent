import { expect, it } from "vitest";
import { parseHistoryFile, serializeHistoryFile, serializeDirtyFence, parseDirtyFence } from "../history/canonical/codec.js";

const epoch = "a".repeat(64);
const conversationKey = "b".repeat(64);
const runIdDigest = "c".repeat(64);
const providerSessionId = "d".repeat(64);

it("preserves canonical JSON framing, field order and escaped UTF-8 bytes", () => {
  const record = { version: 3 as const, conversationId: "morgan#2026-01-02", messages: [{ role: "user" as const, content: "quote \" slash \\ NUL \0 東京" }], providerSession: { epoch, revision: 2 } };
  const expected = '{"version":3,"conversationId":"morgan#2026-01-02","messages":[{"role":"user","content":"quote \\" slash \\\\ NUL \\u0000 東京"}],"providerSession":{"epoch":"' + epoch + '","revision":2}}\n';
  expect(serializeHistoryFile(record)).toEqual(Buffer.from(expected, "utf8"));
  expect(parseHistoryFile(Buffer.from(expected), "record")).toEqual({ sourceVersion: 3, conversationId: record.conversationId, messages: record.messages, providerSession: record.providerSession });
});

it("keeps legacy version dispatch and first-error ordering", () => {
  expect(parseHistoryFile(Buffer.from('{"version":1,"conversationId":"morgan","messages":[]}'), "record")).toEqual({ sourceVersion: 1, conversationId: "morgan", messages: [] });
  expect(parseHistoryFile(Buffer.from(`{"version":2,"conversationId":"morgan","messages":[],"providerSession":{"epoch":"${epoch}"}}`), "record")).toEqual({ sourceVersion: 2, conversationId: "morgan", messages: [], providerSession: { epoch } });
  expect(() => parseHistoryFile(Buffer.from('{'), "record")).toThrow("History file record is not valid JSON.");
  expect(() => parseHistoryFile(Buffer.from('{"version":99,"conversationId":" morgan ","messages":[{}]}'), "record")).toThrow("History file record contains a non-canonical conversation id.");
  expect(() => parseHistoryFile(Buffer.from('{"version":99,"conversationId":"morgan","messages":[{}]}'), "record")).toThrow("History message role is invalid.");
});

it("preserves legacy and logical fence bytes and optional field omissions", () => {
  for (const version of [1, 2, 3] as const) {
    const input = { conversationKey, ...(version === 3 ? { logicalConversationKey: conversationKey } : {}), epoch, ...(version >= 2 ? { providerSessionId } : {}), revision: 0, runIdDigest };
    const expected = `{"version":${version},"conversationKey":"${conversationKey}"${version === 3 ? `,"logicalConversationKey":"${conversationKey}"` : ""},"epoch":"${epoch}"${version >= 2 ? `,"providerSessionId":"${providerSessionId}"` : ""},"revision":0,"runIdDigest":"${runIdDigest}"}\n`;
    expect(serializeDirtyFence(input)).toEqual(Buffer.from(expected));
    expect(parseDirtyFence(Buffer.from(expected), "fence")).toEqual({ path: "fence", ...input });
  }
  expect(() => parseDirtyFence(Buffer.from('{"version":1}'), "fence")).toThrow("History dirty fence fence has an unsupported schema.");
});
