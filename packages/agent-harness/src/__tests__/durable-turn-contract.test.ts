import { createHash } from "node:crypto";
import { digestNativeTurnInput, formatLiveInputGuidance } from "@mono-agent/runtime-adapter";
import { describe, expect, it } from "vitest";
import {
  createPendingTurnPayload, createPendingTurnInput, createPendingInitialInput, createPendingLiveInput, durableTurnFenceDigest, parsePendingTurnPayload, serializeDurableTurnFence,
  serializePendingTurnPayload, validateDurableTurnFence, validateDurableTurnReceipt, MAX_PENDING_TURN_BYTES,
} from "../durable-turn-contract.js";
import type { DurableTurnFence, PendingTurnPayload } from "../durable-turn-contract.js";
const hash = "a".repeat(64);
const identity = { purpose: "execution" as const, ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "fictional-turn", handleId: hash, modelKey: "openai:fictional-model", baseRevision: 0, fenceDigest: hash };
const payload = (): PendingTurnPayload => ({ version: 1, identity, disposition: "admitted", inputs: [{ kind: "initial", id: "initial", placement: "initial", requestDigest: hash, persistText: "Fictional redacted input.", timestamp: "2026-01-01T00:00:00.000Z", senderLabel: "Fictional sender" }] });
const fence = (): DurableTurnFence => ({ version: 5, kind: "execution", conversationKey: hash, logicalConversationKey: hash, epoch: hash, providerSessionId: hash, modelKey: "openai:fictional-model", revision: 0, runIdDigest: hash, payload: { generation: "b".repeat(32), sha256: hash } });

describe("P2b private payload/fence/receipt contracts", () => {
  it("round-trips canonical fields without transport or memory-only metadata", () => {
    const input = createPendingTurnInput({ ...payload().inputs[0]!, ownerText: "Fictional memory-only text", deliveryKey: "fictional-private-wake-key", attachments: ["fictional attachment"], speaker: { name: "fictional speaker" } } as never);
    const value = { ...payload(), inputs: [input] }; const text = serializePendingTurnPayload(value).toString();
    expect(parsePendingTurnPayload(Buffer.from(text))).toEqual(value);
    for (const excluded of ["ownerText", "deliveryKey", "attachments", "speaker", "memory-only", "private-wake-key"]) expect(text).not.toContain(excluded);
  });
  it("builds a body-free internal wake even when the caller has private context", () => {
    const wake = createPendingTurnInput({ kind: "wake", id: "wake", placement: "live", requestDigest: hash, text: "Fictional private wake", deliveryKey: "fictional delivery" } as never);
    expect(wake).toEqual({ kind: "wake", id: "wake", placement: "live", requestDigest: hash });
    expect(parsePendingTurnPayload(serializePendingTurnPayload({ ...payload(), inputs: [...payload().inputs, wake] })).inputs).toHaveLength(2);
  });
  it.each(["deliveryKey", "ownerText", "attachments", "metadata", "toJSON"])("rejects persisted arbitrary/private field %s at every contract layer", (key) => {
    expect(() => serializePendingTurnPayload({ ...payload(), [key]: "fictional" } as never)).toThrow();
    expect(() => serializePendingTurnPayload({ ...payload(), inputs: [{ ...payload().inputs[0], [key]: "fictional" }] } as never)).toThrow();
    expect(() => serializePendingTurnPayload({ ...payload(), identity: { ...identity, [key]: "fictional" } } as never)).toThrow();
    expect(() => serializePendingTurnPayload({ ...payload(), candidate: { outcome: "completed", text: "Fictional reply.", timestamp: "2026-01-01", error: null, failureKind: null, [key]: "fictional" } } as never)).toThrow();
  });
  it("bounds ordinary live offers and serialized generations before publication", () => {
    const live = { kind: "live" as const, id: "live", placement: "live" as const, requestDigest: hash, persistText: "x".repeat(8000), receivedAt: "2026-01-01" };
    expect(() => serializePendingTurnPayload({ ...payload(), inputs: [...payload().inputs, live] })).not.toThrow();
    expect(() => serializePendingTurnPayload({ ...payload(), inputs: [...payload().inputs, { ...live, persistText: live.persistText + "x" }] })).toThrow();
    expect(() => serializePendingTurnPayload({ ...payload(), inputs: [...payload().inputs, ...Array.from({ length: 101 }, (_, i) => ({ ...live, id: `live-${i}` }))] })).toThrow();
    expect(() => parsePendingTurnPayload(Buffer.alloc(MAX_PENDING_TURN_BYTES + 1))).toThrow("16 MiB");
  });
  it("rejects duplicate identities, malformed digests, inherited serialization and invalid UTF-8", () => {
    expect(() => serializePendingTurnPayload({ ...payload(), inputs: [...payload().inputs, payload().inputs[0]!] })).toThrow();
    expect(() => serializePendingTurnPayload({ ...payload(), identity: { ...identity, fenceDigest: "bad" } })).toThrow();
    expect(() => serializePendingTurnPayload(Object.assign(Object.create({ toJSON: () => ({}) }), payload()))).toThrow();
    expect(() => parsePendingTurnPayload(Buffer.from([0xff]))).toThrow();
  });
  it("keeps compaction promptless and retirement distinct from recoverable execution", () => {
    expect(() => serializePendingTurnPayload({ ...payload(), identity: { ...identity, purpose: "compaction" }, inputs: [] })).not.toThrow();
    expect(() => serializePendingTurnPayload({ ...payload(), identity: { ...identity, purpose: "compaction" } })).toThrow();
    const { payload: _payload, ...base } = fence(); const retirement = { ...base, kind: "retirement" };
    expect(() => validateDurableTurnFence(retirement)).not.toThrow();
    expect(() => validateDurableTurnFence({ ...retirement, payload: fence().payload })).toThrow();
    expect(() => validateDurableTurnFence({ ...fence(), payload: undefined })).toThrow();
  });
  it("keeps the 1 KiB fence and a stable admission digest across immutable pointers", () => {
    expect(serializeDurableTurnFence(fence()).byteLength).toBeLessThanOrEqual(1024);
    expect(durableTurnFenceDigest({ ...fence(), payload: { generation: "c".repeat(32), sha256: "b".repeat(64) } })).toBe(durableTurnFenceDigest(fence()));
    expect(durableTurnFenceDigest({ ...fence(), revision: 1 })).not.toBe(durableTurnFenceDigest(fence()));
    expect(() => serializeDurableTurnFence({ ...fence(), modelKey: "openai:" + "x".repeat(1000) })).toThrow("1 KiB");
    expect(() => validateDurableTurnFence({ ...fence(), payload: { generation: "../escape", sha256: hash } })).toThrow();
  });
  it("validates bounded last-commit receipts independently of retained messages", () => {
    const receipt = { version: 1, turnId: identity.turnId, inputDigest: hash, candidateDigest: hash, journalId: "fictional-journal", tipId: "fictional-tip", baseRevision: 0, committedRevision: 1, outcome: "completed" };
    expect(() => validateDurableTurnReceipt(receipt)).not.toThrow();
    expect(() => validateDurableTurnReceipt({ ...receipt, committedRevision: 0 })).toThrow();
    expect(() => validateDurableTurnReceipt({ ...receipt, deliveryKey: "fictional-private" })).toThrow();
  });
});

it("hashes original native decoration but persists only redacted canonical text", () => {
  const initial = createPendingInitialInput({ id: "original", persistText: "Fictional redacted input.", timestamp: "2026-01-01" }, "Fictional runtime-only memory and attachment decoration.");
  expect(initial.requestDigest).toBe(digestNativeTurnInput("Fictional runtime-only memory and attachment decoration."));
  expect(JSON.stringify(initial)).not.toContain("runtime-only");
});
it("uses the exact native live guidance formatter including prompt overrides, without persisting private wake bodies", () => {
  const source = { id: "live", persistText: "Fictional canonical follow-up.", receivedAt: "2026-01-01" };
  const prompts = { liveInputGuidance: (body: string) => `Fictional configured guidance: ${body}` };
  const body = "Fictional private runtime wake body.";
  const ordinary = createPendingLiveInput(source, body, "live", prompts), wake = createPendingLiveInput(source, body, "wake", prompts);
  const actual = createHash("sha256").update(JSON.stringify([{ type: "text", text: formatLiveInputGuidance(body, prompts) }])).digest("hex");
  expect(ordinary.requestDigest).toBe(actual); expect(wake.requestDigest).toBe(actual); expect(actual).not.toBe(digestNativeTurnInput(body));
  expect(JSON.stringify(wake)).not.toContain("private runtime"); expect(wake).not.toHaveProperty("persistText");
});

it("uses an explicit candidate/identity builder instead of persisting result/controller spreads", () => {
  const candidate = { outcome: "completed" as const, text: "Fictional answer.", timestamp: "2026-01-01", error: null, failureKind: null,
    deliveryKey: "fictional private delivery", ownerText: "fictional memory only", controller: { secret: "fictional secret" } };
  const built = createPendingTurnPayload({ ...identity, ownerText: "fictional owner-only decoration" } as never, payload().inputs, "completed", candidate);
  const serialized = serializePendingTurnPayload(built).toString();
  for (const excluded of ["deliveryKey", "ownerText", "controller", "secret", "private delivery", "memory only"]) expect(serialized).not.toContain(excluded);
});
