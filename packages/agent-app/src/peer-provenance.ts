import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { ensureOwnerOnlyDirectory, loadOrCreateContinuationSecret } from "./continuation-store-fs.js";

/** Private, source-bound peer handoff. Attribution is never owner approval or tool authority. */
export interface PeerHandoff {
  readonly version: 1;
  readonly caller: string;
  readonly conversation: string;
  readonly session: string;
  readonly sourceId: string;
  readonly generation: string;
  readonly depth: number;
  readonly digest: string;
  readonly proof: string;
}

function peerSecretDir(artifactDir: string): string {
  return join(dirname(resolve(artifactDir)), "acp-peer-handoff");
}

function payload(value: Omit<PeerHandoff, "proof">): string {
  return JSON.stringify([value.version, value.caller, value.conversation, value.session, value.sourceId, value.generation, value.depth, value.digest]);
}

export async function makePeerHandoff(artifactDir: string, input: {
  caller: string; conversation: string; session: string; sourceId: string; generation: string; depth: number; text: string;
}): Promise<PeerHandoff> {
  const root = peerSecretDir(artifactDir);
  await ensureOwnerOnlyDirectory(root);
  const secret = await loadOrCreateContinuationSecret(root);
  const body = {
    version: 1 as const, caller: input.caller, conversation: input.conversation,
    session: input.session, sourceId: input.sourceId, generation: input.generation, depth: input.depth,
    digest: createHash("sha256").update(input.text).digest("hex"),
  };
  return { ...body, proof: createHmac("sha256", secret).update(payload(body)).digest("base64url") };
}

export async function verifyPeerHandoff(artifactDir: string, value: unknown, session: string, text?: string, sourceId?: string): Promise<PeerHandoff | undefined> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const p = value as Partial<PeerHandoff>;
  if (Object.keys(p).sort().join(",") !== "caller,conversation,depth,digest,generation,proof,session,sourceId,version"
    || p.version !== 1 || p.session !== session || (sourceId !== undefined && p.sourceId !== sourceId)
    || typeof p.sourceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(p.sourceId)
    || typeof p.generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(p.generation)
    || typeof p.caller !== "string"
    || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(p.caller)
    || typeof p.conversation !== "string" || p.conversation.length < 1 || p.conversation.length > 256
    || !Number.isSafeInteger(p.depth) || p.depth! < 1 || p.depth! > 64
    || typeof p.digest !== "string" || !/^[a-f0-9]{64}$/u.test(p.digest)
    || typeof p.proof !== "string" || !/^[a-zA-Z0-9_-]{43}$/u.test(p.proof)) return undefined;
  if (text !== undefined && createHash("sha256").update(text).digest("hex") !== p.digest) return undefined;
  const root = peerSecretDir(artifactDir);
  await ensureOwnerOnlyDirectory(root);
  const secret = await loadOrCreateContinuationSecret(root);
  const expected = createHmac("sha256", secret).update(payload(p as PeerHandoff)).digest();
  const received = Buffer.from(p.proof, "base64url");
  return received.length === expected.length && timingSafeEqual(received, expected) ? p as PeerHandoff : undefined;
}
