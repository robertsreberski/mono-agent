import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isProcessJobState, PROCESS_JOB_STATES } from "@mono-agent/contracts";
import {
  hasSubagentObligation,
  hasUnresolvedSubagentOwnership,
  isSubagentExecutionOwnership,
} from "../subagent-execution-ownership.js";
import {
  MAX_PROCESS_JOB_HEALTH_BYTES,
  PROCESS_JOB_HEALTH_FILE,
  PROCESS_JOB_QUARANTINE_DIRECTORY,
  PROCESS_JOB_RECORDS_DIRECTORY,
  PROCESS_JOB_SECRET_FILE,
} from "../process-jobs-store.js";
import { continuationFsCode, continuationReason, isDoctorObject } from "../diagnostics/inspection-values.js";

export async function inspectProcessJobState(cwd: string, stateDir: string): Promise<{
  readonly status: "ok" | "error";
  readonly details: readonly string[];
}> {
  const confinementError = await inspectProcessJobConfinement(cwd, stateDir);
  if (confinementError !== undefined) {
    return { status: "error", details: [confinementError] };
  }
  let root;
  try {
    root = await lstat(stateDir);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { status: "ok", details: ["State has not been initialized; the app will create it owner-only on first start."] }
      : { status: "error", details: [`Process-job state cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return { status: "error", details: ["Process-job state root must be a real directory, not a symlink."] };
  }
  const rootSecurity = processJobOwnershipError(root, "state directory", 0o700);
  if (rootSecurity !== undefined) return { status: "error", details: [rootSecurity] };

  const healthInspection = await inspectProcessJobHealth(stateDir);
  if (healthInspection !== undefined) return healthInspection;

  const quarantineInspection = await inspectProcessJobQuarantine(stateDir);
  if (quarantineInspection !== undefined) return quarantineInspection;

  const secretPath = join(stateDir, PROCESS_JOB_SECRET_FILE);
  try {
    const secret = await lstat(secretPath);
    if (!secret.isFile() || secret.isSymbolicLink() || Number(secret.nlink) !== 1 || Number(secret.size) > 256) {
      return { status: "error", details: ["Process-job operator secret must be one regular file."] };
    }
    const secretSecurity = processJobOwnershipError(secret, "operator secret", 0o600);
    if (secretSecurity !== undefined) return { status: "error", details: [secretSecurity] };
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Process-job operator secret cannot be inspected: ${continuationReason(error)}`] };
    }
  }

  const recordsPath = join(stateDir, PROCESS_JOB_RECORDS_DIRECTORY);
  let names: string[];
  try {
    const records = await lstat(recordsPath);
    if (!records.isDirectory() || records.isSymbolicLink()) {
      return { status: "error", details: ["Process-job records path must be a real directory."] };
    }
    const recordsSecurity = processJobOwnershipError(records, "records directory", 0o700);
    if (recordsSecurity !== undefined) return { status: "error", details: [recordsSecurity] };
    names = (await readdir(recordsPath)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { status: "ok", details: ["No local process-job records have been written yet."] }
      : { status: "error", details: [`Process-job records cannot be inspected: ${continuationReason(error)}`] };
  }
  if (names.length > 10_000) return { status: "error", details: ["Process-job record count exceeds the compiled inspection bound of 10000."] };
  const counts = Object.fromEntries(PROCESS_JOB_STATES.map((state) => [state, 0])) as Record<string, number>;
  const childOwnership = { retained: 0, unresolved: 0, ownerUnavailable: 0 };
  for (const name of names) {
    const path = join(recordsPath, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) throw new Error("record is not one regular file");
      const security = processJobOwnershipError(info, `record ${name}`, 0o600);
      if (security !== undefined) throw new Error(security);
      if (Number(info.size) > 128 * 1024) throw new Error("record exceeds 131072 bytes");
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isDoctorObject(raw) || !isProcessJobState(raw.state) || raw.jobId !== name.slice(0, -5)) {
        throw new Error("record identity or state is invalid");
      }
      counts[raw.state] = (counts[raw.state] ?? 0) + 1;
      if (raw.subagentOwnership !== undefined && !isSubagentExecutionOwnership(raw.subagentOwnership)) {
        throw new Error("record child ownership is invalid");
      }
      if (raw.subagentOwnership !== undefined && raw.kind !== "internal") {
        throw new Error("record child ownership kind is invalid");
      }
      if (raw.kind === "internal") {
        const ownership = isSubagentExecutionOwnership(raw.subagentOwnership) ? raw.subagentOwnership : undefined;
        const record = { kind: "internal" as const, childStillBusy: raw.childStillBusy === true, ...(ownership ? { subagentOwnership: ownership } : {}) };
        if (hasSubagentObligation(record)) childOwnership.retained++;
        if (hasUnresolvedSubagentOwnership(record)) {
          childOwnership.unresolved++;
          if (!ownership || ownership.owner.settlement === "unknown") childOwnership.ownerUnavailable++;
        }
      }
    } catch (error) {
      return { status: "error", details: [`Process-job record ${name} is unsafe or malformed: ${continuationReason(error)}`] };
    }
  }
  return {
    status: "ok",
    details: [
      `Local records: ${String(names.length)}.`,
      `States: ${PROCESS_JOB_STATES.map((state) => `${state}=${String(counts[state] ?? 0)}`).join(", ")}.`,
      `Persistent child ownership: retained=${String(childOwnership.retained)}, unresolved=${String(childOwnership.unresolved)}, owner-unavailable=${String(childOwnership.ownerUnavailable)}.`,
    ],
  };
}

async function inspectProcessJobHealth(stateDir: string): Promise<{
  readonly status: "error";
  readonly details: readonly string[];
} | undefined> {
  const path = join(stateDir, PROCESS_JOB_HEALTH_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) {
      throw new Error("runtime health marker is not one regular file");
    }
    const security = processJobOwnershipError(info, "runtime health marker", 0o600);
    if (security !== undefined) throw new Error(security);
    if (Number(info.size) > MAX_PROCESS_JOB_HEALTH_BYTES) {
      throw new Error(`runtime health marker exceeds ${String(MAX_PROCESS_JOB_HEALTH_BYTES)} bytes`);
    }
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isDoctorObject(value)
      || Object.keys(value).sort().join(",") !== "detectedAt,operation,schemaVersion,state"
      || value.schemaVersion !== 1
      || value.state !== "degraded"
      || typeof value.operation !== "string"
      || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(value.operation)
      || typeof value.detectedAt !== "string"
      || !Number.isFinite(Date.parse(value.detectedAt))) {
      throw new Error("runtime health marker is malformed");
    }
    return {
      status: "error",
      details: [
        `Process-job storage degraded during ${value.operation} at ${value.detectedAt}; new admission is closed until a clean restart recovery.`,
      ],
    };
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? undefined
      : {
          status: "error",
          details: [`Process-job runtime health cannot be inspected: ${continuationReason(error)}`],
        };
  }
}

async function inspectProcessJobQuarantine(stateDir: string): Promise<{
  readonly status: "error";
  readonly details: readonly string[];
} | undefined> {
  const quarantinePath = join(stateDir, PROCESS_JOB_QUARANTINE_DIRECTORY);
  let names: string[];
  try {
    const directory = await lstat(quarantinePath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return { status: "error", details: ["Process-job quarantine path must be a real directory."] };
    }
    const security = processJobOwnershipError(directory, "quarantine directory", 0o700);
    if (security !== undefined) return { status: "error", details: [security] };
    names = await readdir(quarantinePath);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? undefined
      : { status: "error", details: [`Process-job quarantine cannot be inspected: ${continuationReason(error)}`] };
  }
  if (names.length > 10_000) {
    return { status: "error", details: ["Process-job quarantined transaction count exceeds 10000."] };
  }
  for (const name of names) {
    const path = join(quarantinePath, name);
    try {
      if (!/^transaction-\d{4}-\d{2}-\d{2}T[0-9.-]+Z-[0-9a-f-]{36}\.json$/iu.test(name)) {
        throw new Error("quarantine filename is invalid");
      }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) {
        throw new Error("quarantined transaction is not one regular file");
      }
      const security = processJobOwnershipError(info, `quarantined transaction ${name}`, 0o600);
      if (security !== undefined) throw new Error(security);
      if (Number(info.size) > 256 * 1024) throw new Error("quarantined transaction exceeds 262144 bytes");
    } catch (error) {
      return {
        status: "error",
        details: [`Process-job quarantined transaction ${name} is unsafe: ${continuationReason(error)}`],
      };
    }
  }
  return names.length === 0
    ? undefined
    : {
        status: "error",
        details: [
          `Quarantined unreplayable process-job transactions: ${String(names.length)}.`,
          "The agent can continue without the affected transaction, but operator review is required.",
        ],
      };
}

function processJobOwnershipError(
  info: Awaited<ReturnType<typeof lstat>>,
  label: string,
  expectedMode: number,
): string | undefined {
  if (typeof process.getuid === "function" && Number(info.uid) !== process.getuid()) {
    return `Process-job ${label} is not owned by the current user.`;
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== expectedMode) {
    return `Process-job ${label} permissions must be ${expectedMode.toString(8)}.`;
  }
  return undefined;
}

async function inspectProcessJobConfinement(cwd: string, stateDir: string): Promise<string | undefined> {
  const lexicalRoot = resolve(cwd);
  const root = await realpath(lexicalRoot).catch(() => lexicalRoot);
  const rel = relative(root, resolve(stateDir));
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`)) {
    return "Process-job state must be a child directory inside the canonical agent root.";
  }
  let current = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return `Process-job state component must be a real directory, not a symlink: ${current}.`;
      }
    } catch (error) {
      if (continuationFsCode(error) === "ENOENT") return undefined;
      return `Process-job state confinement cannot be inspected: ${continuationReason(error)}`;
    }
  }
  return undefined;
}
