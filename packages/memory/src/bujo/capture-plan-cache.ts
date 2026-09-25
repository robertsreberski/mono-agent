import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapturePlan } from "./capture-batch.js";

const KEY = /^[a-f0-9]{64}$/u;
const DIR = ".capture-plans";

function pathFor(root: string, key: string): string {
  if (!KEY.test(key)) throw new Error("memory-capture: invalid plan retention key");
  const dir = join(root, DIR);
  if (existsSync(dir) && (!lstatSync(dir).isDirectory() || (lstatSync(dir).mode & 0o077) !== 0)) {
    throw new Error("memory-capture: retained plan directory is unsafe");
  }
  return join(dir, `${key}.json`);
}

/** Immutable private extraction, fsynced before reconcile or intake retry. */
export function retainCapturePlan(root: string, key: string, inputHash: string, plan: CapturePlan): void {
  const path = pathFor(root, key);
  if (existsSync(path)) return;
  const dir = join(root, DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${key}-${randomUUID()}.tmp`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ inputHash, plan }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    const directory = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

export function recoveredCapturePlan(root: string, key: string, inputHash: string): CapturePlan | undefined {
  const path = pathFor(root, key);
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try { raw = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  const saved: unknown = JSON.parse(raw);
  if (typeof saved !== "object" || saved === null || !Object.hasOwn(saved, "plan") || !Object.hasOwn(saved, "inputHash")
    || (saved as { inputHash: unknown }).inputHash !== inputHash) throw new Error("memory-capture: retained plan does not match intake");
  const plan = (saved as { plan: CapturePlan }).plan;
  if (!Array.isArray(plan?.candidates) || !Array.isArray(plan.entities) || !Array.isArray(plan.relations)
    || plan.candidates.length > 8 || plan.entities.length > 16 || plan.relations.length > 16) {
    throw new Error("memory-capture: retained plan is invalid");
  }
  return plan;
}

export function listRetainedCapturePlanKeys(root: string): readonly string[] {
  const dir = join(root, DIR);
  pathFor(root, "a".repeat(64));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((file) => KEY.test(file.slice(0, -5)) && file.endsWith(".json")
    ? [file.slice(0, -5)] : []);
}

export function discardCapturePlan(root: string, key: string): void {
  const path = pathFor(root, key);
  if (existsSync(path)) unlinkSync(path);
}

export function capturePlanInputHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
