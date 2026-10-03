import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";

import { acquireContinuationStoreLock, ensureOwnerOnlyDirectory, loadOrCreateContinuationSecret, readBoundedOwnerOnlyFile, writeJsonAtomic } from "./continuation-store-fs.js";

/** Private, source-bound peer handoff. Attribution is never owner approval or tool authority. */
export interface PeerHandoff {
  readonly version: 1;
  readonly caller: string;
  readonly conversation: string;
  readonly session: string;
  readonly sourceId: string;
  readonly generation: string;
  readonly chain: readonly string[];
  readonly depth: number;
  readonly digest: string;
  readonly proof: string;
}

function peerSecretDir(artifactDir: string): string {
  return join(dirname(resolve(artifactDir)), "acp-peer-handoff");
}

function payload(value: Omit<PeerHandoff, "proof">): string {
  return JSON.stringify([value.version, value.caller, value.conversation, value.session, value.sourceId, value.generation, value.chain, value.depth, value.digest]);
}

export async function makePeerHandoff(artifactDir: string, input: {
  caller: string; conversation: string; session: string; sourceId: string; generation: string; chain?: readonly string[]; depth: number; text: string;
}): Promise<PeerHandoff> {
  const root = peerSecretDir(artifactDir);
  await ensureOwnerOnlyDirectory(root);
  const secret = await loadOrCreateContinuationSecret(root);
  const body = {
    version: 1 as const, caller: input.caller, conversation: input.conversation,
    session: input.session, sourceId: input.sourceId, generation: input.generation,
    chain: input.chain ?? [input.caller, input.sourceId], depth: input.depth,
    digest: createHash("sha256").update(input.text).digest("hex"),
  };
  return { ...body, proof: createHmac("sha256", secret).update(payload(body)).digest("base64url") };
}

export async function verifyPeerHandoff(artifactDir: string, value: unknown, session: string, text?: string, sourceId?: string): Promise<PeerHandoff | undefined> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const p = value as Partial<PeerHandoff>;
  if (Object.keys(p).sort().join(",") !== "caller,chain,conversation,depth,digest,generation,proof,session,sourceId,version"
    || p.version !== 1 || typeof p.session !== "string"
    || !(p.session === session || (session.startsWith(`${p.session}#`) && /^\d{4}-\d{2}-\d{2}$/u.test(session.slice(p.session.length + 1))))
    || (sourceId !== undefined && p.sourceId !== sourceId)
    || typeof p.sourceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(p.sourceId)
    || typeof p.generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(p.generation)
    || typeof p.caller !== "string"
    || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(p.caller)
    || !Array.isArray(p.chain) || p.chain.length < 2 || p.chain.length > 64
    || p.chain.some((entry) => typeof entry !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(entry))
    || new Set(p.chain).size !== p.chain.length
    || p.chain[p.chain.length - 1] !== p.sourceId || p.chain[p.chain.length - 2] !== p.caller
    || (typeof p.depth === "number" && p.depth < p.chain.length - 1)
    || typeof p.conversation !== "string" || p.conversation.length < 1 || p.conversation.length > 256
    || !Number.isSafeInteger(p.depth) || p.depth! < 1 || p.depth! > 64
    || typeof p.digest !== "string" || !/^[a-f0-9]{64}$/u.test(p.digest)
    || typeof p.proof !== "string" || !/^[a-zA-Z0-9_-]{43}$/u.test(p.proof)) return undefined;
  if (text !== undefined && createHash("sha256").update(text).digest("hex") !== p.digest) return undefined;
  const secret = await readPeerSecret(artifactDir);
  if (secret === undefined) return undefined;
  const expected = createHmac("sha256", secret).update(payload(p as PeerHandoff)).digest();
  const received = Buffer.from(p.proof, "base64url");
  return received.length === expected.length && timingSafeEqual(received, expected) ? p as PeerHandoff : undefined;
}

async function readPeerSecret(artifactDir: string): Promise<Buffer | undefined> {
  // Neither malformed nor well-formed forged metadata may create owner state.
  let encoded: string;
  try { encoded = await readBoundedOwnerOnlyFile(join(peerSecretDir(artifactDir), "continuation-secret"), 128, "Peer handoff secret"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const secret = Buffer.from(encoded.trim(), "base64url");
  return secret.length === 32 ? secret : undefined;
}

function peerGenerationDirectory(artifactDir: string, sessionId: string): string {
  return join(peerSecretDir(artifactDir), "consumed", createHash("sha256").update(sessionId).digest("hex"));
}

/** A reset session can no longer dispatch proof-bearing turns; retire its ledger. */
export async function prunePeerGenerationLedger(artifactDir: string, sessionId: string): Promise<void> {
  await rm(peerGenerationDirectory(artifactDir, sessionId), { recursive: true, force: true });
}

export class PeerSessionExhaustedError extends Error {
  constructor() { super("Peer session generation ledger is full; the next explicit send must start a new session."); }
}

/** The bridge consumes each signed turn generation at most once, before dispatch.
 * Exhaustion fails closed rather than evicting old generations and enabling replay. */
export async function consumePeerGeneration(artifactDir: string, proof: PeerHandoff, maxGenerations = 1024): Promise<boolean> {
  const directory = peerGenerationDirectory(artifactDir, proof.session);
  let lease: Awaited<ReturnType<typeof acquireContinuationStoreLock>> | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { lease = await acquireContinuationStoreLock(directory); break; }
    catch (error) {
      if (attempt === 5 || !(error instanceof Error) || !error.message.startsWith("Continuation state is already owned")) throw error;
      await pause(25);
    }
  }
  if (lease === undefined) throw new Error("Peer generation ownership unavailable.");
  try {
    const path = join(directory, "generations.json");
    let encoded: string;
    try { encoded = await readBoundedOwnerOnlyFile(path, 64 * 1024, "Consumed peer generations"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") encoded = "[]"; else throw error; }
    const entries: unknown = JSON.parse(encoded);
    if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 1024) throw new Error("Peer generation limit is invalid.");
    if (!Array.isArray(entries) || entries.length > 1024 || entries.some((entry) => typeof entry !== "string"
      || !/^[a-f0-9-]{36}$/u.test(entry)) || new Set(entries).size !== entries.length) {
      throw new Error("Consumed peer generation state is invalid.");
    }
    if (entries.includes(proof.generation)) return false;
    if (entries.length >= maxGenerations) throw new PeerSessionExhaustedError();
    await writeJsonAtomic(path, [...entries, proof.generation], true, 64 * 1024);
    return true;
  } finally { await lease.release(); }
}

/** Only this bridge-produced, domain-separated MAC is forwarded to the operator. */
export interface PeerOperatorHandoff extends Omit<PeerHandoff, "proof"> {
  readonly attestation: string;
}

function operatorAttestation(secret: Buffer, body: Omit<PeerHandoff, "proof">): Buffer {
  return createHmac("sha256", secret).update("mono-agent.peer-operator.v1\0").update(payload(body)).digest();
}

export async function stampPeerOperatorHandoff(artifactDir: string, proof: PeerHandoff): Promise<PeerOperatorHandoff> {
  const secret = await readPeerSecret(artifactDir);
  if (secret === undefined) throw new Error("Verified peer secret disappeared before operator handoff.");
  const { proof: _proof, ...body } = proof;
  return { ...body, attestation: operatorAttestation(secret, body).toString("base64url") };
}

export async function verifyPeerOperatorHandoff(artifactDir: string, value: unknown, session: string, text: string, sourceId?: string): Promise<PeerOperatorHandoff | undefined> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Partial<PeerOperatorHandoff>;
  if (Object.keys(input).sort().join(",") !== "attestation,caller,chain,conversation,depth,digest,generation,session,sourceId,version"
    || typeof input.attestation !== "string" || !/^[a-zA-Z0-9_-]{43}$/u.test(input.attestation)) return undefined;
  // Reuse all structural/digest checks without allowing a client proof on this path.
  const secret = await readPeerSecret(artifactDir);
  if (secret === undefined) return undefined;
  const body = { version: input.version, caller: input.caller, conversation: input.conversation,
    session: input.session, sourceId: input.sourceId, generation: input.generation,
    chain: input.chain, depth: input.depth, digest: input.digest };
  const expected = operatorAttestation(secret, body as Omit<PeerHandoff, "proof">);
  const received = Buffer.from(input.attestation, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
  const reconstructed = { ...body, proof: createHmac("sha256", secret).update(payload(body as Omit<PeerHandoff, "proof">)).digest("base64url") };
  return await verifyPeerHandoff(artifactDir, reconstructed, session, text, sourceId) === undefined ? undefined : input as PeerOperatorHandoff;
}
