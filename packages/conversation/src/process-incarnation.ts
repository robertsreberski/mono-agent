import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

export const PROCESS_INCARNATION_SCHEMA = "mono-agent.process-incarnation.v1";
/**
 * Stable evidence: Darwin `kern.bootsessionuuid` plus UTC `ps lstart`, or Linux
 * boot UUID plus start ticks. Unaffected by calendar-clock steps and timezones.
 */
export const HISTORY_PROCESS_INCARNATION_SCHEMA = "mono-agent.process-incarnation.v2";

type ProcessIncarnationSchema = typeof PROCESS_INCARNATION_SCHEMA | typeof HISTORY_PROCESS_INCARNATION_SCHEMA;

/**
 * Stable OS evidence that distinguishes one use of a PID from every later reuse.
 * Darwin writers use v2. Linux, Windows and other platforms keep writing v1.
 */
export interface ProcessIncarnation {
  readonly schema: ProcessIncarnationSchema;
  readonly bootSessionId: string;
  readonly processStartId: string;
}

export type SameProcessIncarnation = (
  pid: number,
  expected: ProcessIncarnation,
) => boolean | Promise<boolean>;

const PROBE_TIMEOUT_MS = 5_000;

let bootSessionIdPromise: Promise<string> | undefined;
let darwinBootUuidPromise: Promise<string> | undefined;
let currentStablePromise: Promise<ProcessIncarnation> | undefined;

/**
 * Capture the current process's boot-session and process-birth identity.
 * `schema` defaults to this platform's writer schema (v2 on Darwin, v1
 * elsewhere); Darwin lock writers also request v1 for legacy-reader sidecars.
 */
export async function currentProcessIncarnation(
  schema: ProcessIncarnationSchema = writerSchema(),
): Promise<ProcessIncarnation> {
  // This process's stable identity never changes, so one successful capture is
  // reused. v1 stays a fresh read: its local start string follows TZ changes.
  if (schema === HISTORY_PROCESS_INCARNATION_SCHEMA) {
    const pending = currentStablePromise ??= readCurrent(schema);
    pending.catch(() => { if (currentStablePromise === pending) currentStablePromise = undefined; });
    return await pending;
  }
  return await readCurrent(schema);
}

async function readCurrent(schema: ProcessIncarnationSchema): Promise<ProcessIncarnation> {
  const incarnation = await readProcessIncarnation(process.pid, schema);
  if (incarnation === undefined) {
    throw new Error(`Cannot read process incarnation for current pid ${process.pid}.`);
  }
  return incarnation;
}

/**
 * Read one PID incarnation without mistaking `kill(pid, 0)` for owner identity.
 * `undefined` means ESRCH proved the PID absent; every other failure throws.
 * Linux exposes a boot UUID and per-process start tick directly. Darwin v2 uses
 * the boot-session UUID plus UTC `ps lstart`; Darwin v1 (legacy readers only)
 * uses calendar boot time plus local `ps lstart`. BSD-like platforms use PID 1's
 * birth. Windows uses native process/OS creation timestamps through PowerShell.
 * Every Darwin probe is bounded at five seconds and then SIGKILLed.
 */
export async function readProcessIncarnation(
  pid: number,
  schema: ProcessIncarnationSchema = writerSchema(),
): Promise<ProcessIncarnation | undefined> {
  assertPid(pid);
  if (schema === HISTORY_PROCESS_INCARNATION_SCHEMA) return await readStableProcessIncarnation(pid);
  if (schema !== PROCESS_INCARNATION_SCHEMA) throw new Error(`Unsupported process incarnation schema ${String(schema)}.`);
  if (!processExists(pid)) return undefined;
  const [bootSessionId, processStartId] = await Promise.all([
    currentBootSessionId(),
    processStartIdentifier(pid),
  ]);
  if (processStartId === undefined) return undefined;
  return {
    schema: PROCESS_INCARNATION_SCHEMA,
    bootSessionId,
    processStartId,
  };
}

/**
 * Strict authorization check: true only when PID, boot session, and process
 * birth all still identify the owner. Unavailable or incomparable evidence
 * (including Darwin v1 records) is false or throws, never a match.
 */
export async function isSameProcessIncarnation(
  pid: number,
  expected: ProcessIncarnation,
): Promise<boolean> {
  const actual = await readProcessIncarnation(pid);
  return actual !== undefined && processIncarnationsEqual(actual, expected);
}

/**
 * Liveness check for reclaim decisions; never use it to authorize signals or
 * releases. False only when ESRCH proves the PID absent or comparable evidence
 * proves a different process. A live PID whose evidence is unavailable
 * (timeout, malformed output, permission) or incomparable (a Darwin v1 record,
 * an unknown schema) stays live.
 */
export async function isProcessIncarnationLive(
  pid: number,
  expected: ProcessIncarnation,
): Promise<boolean> {
  assertPid(pid);
  if (!processExists(pid)) return false;
  if (expected.schema !== writerSchema()) return true;
  let actual: ProcessIncarnation | undefined;
  try {
    actual = await readProcessIncarnation(pid);
  } catch {
    return stillPresent(pid);
  }
  // A reader can report absence from evidence other than ESRCH (Linux procfs
  // ENOENT); only a fresh ESRCH proves the owner gone.
  if (actual === undefined) return stillPresent(pid);
  return processIncarnationsEqual(actual, expected);
}

/** False only on ESRCH; EPERM or an unexpected kill error keeps the owner. */
function stillPresent(pid: number): boolean {
  try {
    return processExists(pid);
  } catch {
    return true;
  }
}

export function processIncarnationsEqual(
  left: ProcessIncarnation,
  right: ProcessIncarnation,
): boolean {
  return left.schema === right.schema
    && left.bootSessionId === right.bootSessionId
    && left.processStartId === right.processStartId;
}

/** Fail-closed parser for persisted lock-owner data; accepts v1 and v2. */
export function processIncarnationFromJson(value: unknown): ProcessIncarnation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return (record.schema === PROCESS_INCARNATION_SCHEMA || record.schema === HISTORY_PROCESS_INCARNATION_SCHEMA)
    && typeof record.bootSessionId === "string"
    && record.bootSessionId.length > 0
    && typeof record.processStartId === "string"
    && record.processStartId.length > 0
    ? record as unknown as ProcessIncarnation
    : undefined;
}

function writerSchema(): ProcessIncarnationSchema {
  return process.platform === "darwin" ? HISTORY_PROCESS_INCARNATION_SCHEMA : PROCESS_INCARNATION_SCHEMA;
}

async function currentBootSessionId(): Promise<string> {
  const pending = bootSessionIdPromise ??= readBootSessionId();
  // A failed (for example timed-out) read must not poison every later capture.
  pending.catch(() => { if (bootSessionIdPromise === pending) bootSessionIdPromise = undefined; });
  return await pending;
}

async function readBootSessionId(): Promise<string> {
  if (process.platform === "linux") {
    const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!/^[a-zA-Z0-9-]+$/u.test(value)) {
      throw new Error("Linux boot session id is malformed.");
    }
    return `linux:${value}`;
  }
  if (process.platform === "darwin") {
    const output = await execFileText("/usr/sbin/sysctl", ["-n", "kern.boottime"], posixEnvironment(), true);
    const match = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/u.exec(output);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("Darwin boot session identity is malformed.");
    }
    return `darwin:${match[1]}:${match[2]}`;
  }
  if (process.platform === "win32") {
    const output = await execFileText(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
    ]);
    return `win32:${requiredDecimal(output, "Windows boot session identity")}`;
  }

  // PID 1 is recreated once per POSIX boot, so its birth is a stable fallback
  // on BSD-like platforms that lack Linux's boot UUID and Darwin's sysctl path.
  const pidOneStart = await posixProcessStartIdentifier(1);
  if (pidOneStart === undefined) {
    throw new Error(`Cannot determine the ${process.platform} boot session identity.`);
  }
  return `${process.platform}:pid1:${pidOneStart}`;
}

async function processStartIdentifier(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return await linuxProcessStartIdentifier(pid);
  if (process.platform === "win32") return await windowsProcessStartIdentifier(pid);
  return await posixProcessStartIdentifier(pid);
}

async function linuxProcessStartIdentifier(pid: number): Promise<string | undefined> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return undefined;
    throw error;
  }
  // `comm` is parenthesized and may itself contain spaces or `)`, so split only
  // after its final close paren. The remaining token at index 19 is field 22,
  // the kernel start tick since boot.
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error(`Linux process stat for pid ${pid} is malformed.`);
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
    throw new Error(`Linux process start identity for pid ${pid} is malformed.`);
  }
  return `linux-ticks:${startTicks}`;
}

async function posixProcessStartIdentifier(pid: number): Promise<string | undefined> {
  try {
    const output = await execFileText(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      posixEnvironment(),
      process.platform === "darwin",
    );
    const normalized = output.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0) {
      if (!processExists(pid)) return undefined;
      throw new Error(`POSIX process start identity for pid ${pid} is empty.`);
    }
    return `posix-lstart:${normalized}`;
  } catch (error) {
    if (!processExists(pid)) return undefined;
    throw error;
  }
}

async function windowsProcessStartIdentifier(pid: number): Promise<string | undefined> {
  try {
    const output = await execFileText(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-Process -Id ${pid} -ErrorAction Stop; $process.StartTime.ToUniversalTime().Ticks`,
    ]);
    return `win32-ticks:${requiredDecimal(output, `Windows process start identity for pid ${pid}`)}`;
  } catch (error) {
    if (!processExists(pid)) return undefined;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Process incarnation pid must be a positive safe integer; received ${String(pid)}.`);
  }
}

function posixEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function requiredDecimal(output: string, label: string): string {
  const normalized = output.trim();
  if (!/^\d+$/u.test(normalized)) throw new Error(`${label} is malformed.`);
  return normalized;
}

function execFileText(
  executable: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  bounded = false,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      windowsHide: true,
      ...(env === undefined ? {} : { env }),
      ...(bounded ? { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" as const } : {}),
    }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolvePromise(stdout);
    });
  });
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Shared v2 backend for app owners and history. `undefined` only when ESRCH
 * proves absence; timeout, malformed output and unsupported platforms throw.
 */
async function readStableProcessIncarnation(pid: number): Promise<ProcessIncarnation & { readonly schema: typeof HISTORY_PROCESS_INCARNATION_SCHEMA } | undefined> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`Stable process incarnation is unsupported on ${process.platform}.`);
  }
  if (!processExists(pid)) return undefined;
  try {
    let bootSessionId: string, processStartId: string | undefined;
    if (process.platform === "linux") {
      [bootSessionId, processStartId] = await Promise.all([readBootSessionId(), linuxProcessStartIdentifier(pid)]);
      if (processStartId === undefined) throw new Error(`Linux process start identity for pid ${pid} is unavailable.`);
    } else {
      const [uuid, start] = await Promise.all([
        darwinBootSessionUuid(),
        stableExecFileText("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
      ]);
      const normalized = start.trim().replace(/\s+/gu, " ");
      // Only a well-formed `ps` start time is identity; placeholders such as "-" are unavailable, never mismatch proof.
      if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(normalized)) {
        throw new Error(`Darwin process start identity for pid ${pid} is unavailable or malformed.`);
      }
      bootSessionId = `darwin-uuid:${uuid}`; processStartId = `posix-utc-lstart:${normalized}`;
    }
    return { schema: HISTORY_PROCESS_INCARNATION_SCHEMA, bootSessionId, processStartId };
  } catch (error) {
    if (!processExists(pid)) return undefined;
    throw error;
  }
}

async function darwinBootSessionUuid(): Promise<string> {
  const pending = darwinBootUuidPromise ??= stableExecFileText("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])
    .then((output) => {
      const uuid = output.trim().toLowerCase();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(uuid)) {
        throw new Error("Darwin boot-session UUID is malformed.");
      }
      return uuid;
    });
  pending.catch(() => { if (darwinBootUuidPromise === pending) darwinBootUuidPromise = undefined; });
  return await pending;
}

function stableExecFileText(executable: string, args: readonly string[]): Promise<string> {
  return execFileText(executable, args, { ...posixEnvironment(), TZ: "UTC" }, true);
}
