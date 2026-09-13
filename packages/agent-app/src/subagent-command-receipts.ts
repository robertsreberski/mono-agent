import { isAbsolute, resolve } from "node:path";
import type { ProcessJobProcessResult } from "@mono-agent/runtime-adapter";
import { isSubagentUuid } from "./subagent-registry-ownership.js";
import type { SubagentOwnedCommand } from "./subagent-execution-ownership.js";

export const SUBAGENT_COMMAND_RECEIPTS_MAX_COUNT = 32;
export const SUBAGENT_COMMAND_RECEIPTS_MAX_BYTES = 12 * 1024;
/** Private host measurements, not a verdict about the intended verification. */
export interface SubagentCommandReceipt {
  readonly id: string;
  readonly tool: "Exec" | "Bash";
  readonly cwd: string;
  readonly capturedAt: number;
  readonly budgetMs: number | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean | null;
  readonly cancelled: boolean | null;
  readonly truncated: boolean | null;
  readonly completion: "observed" | "unobserved";
  readonly cleanup: "confirmed" | "unknown";
}
export interface SubagentCommandReceipts {
  readonly schemaVersion: 1;
  commands: SubagentCommandReceipt[];
  omitted: number;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableNumber = (value: unknown): boolean => value === null || nonnegative(value);
const nullableBool = (value: unknown): boolean => value === null || typeof value === "boolean";
export function isSubagentCommandReceipt(value: unknown): value is SubagentCommandReceipt {
  return object(value) && exact(value, ["id", "tool", "cwd", "capturedAt", "budgetMs", "durationMs", "exitCode", "signal", "timedOut", "cancelled", "truncated", "completion", "cleanup"])
    && isSubagentUuid(value.id) && ["Exec", "Bash"].includes(String(value.tool))
    && typeof value.cwd === "string" && !value.cwd.includes("\0") && Buffer.byteLength(value.cwd) <= 4096 && isAbsolute(value.cwd) && resolve(value.cwd) === value.cwd
    && nonnegative(value.capturedAt) && nullableNumber(value.budgetMs) && nullableNumber(value.durationMs) && nullableNumber(value.exitCode)
    && (value.signal === null || (typeof value.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(value.signal)))
    && nullableBool(value.timedOut) && nullableBool(value.cancelled) && nullableBool(value.truncated)
    && ["observed", "unobserved"].includes(String(value.completion)) && ["confirmed", "unknown"].includes(String(value.cleanup))
    && (value.completion !== "unobserved" || [value.durationMs, value.exitCode, value.signal, value.timedOut, value.cancelled, value.truncated].every((item) => item === null));
}
export function isSubagentCommandReceipts(value: unknown): value is SubagentCommandReceipts {
  return object(value) && exact(value, ["schemaVersion", "commands", "omitted"]) && value.schemaVersion === 1 && nonnegative(value.omitted)
    && Array.isArray(value.commands) && value.commands.length <= SUBAGENT_COMMAND_RECEIPTS_MAX_COUNT && value.commands.every(isSubagentCommandReceipt)
    && new Set(value.commands.map((command) => command.id)).size === value.commands.length
    && Buffer.byteLength(JSON.stringify(value)) <= SUBAGENT_COMMAND_RECEIPTS_MAX_BYTES;
}
export const emptySubagentCommandReceipts = (): SubagentCommandReceipts => ({ schemaVersion: 1, commands: [], omitted: 0 });

/** Never compromise mandatory ownership to retain optional facts. No argv/output/error prose. */
export function retainSubagentCommandReceipt(target: SubagentCommandReceipts, receipt: SubagentCommandReceipt): void {
  if (!isSubagentCommandReceipt(receipt)) { target.omitted = Math.min(Number.MAX_SAFE_INTEGER, target.omitted + 1); return; }
  const index = target.commands.findIndex((previous) => previous.id === receipt.id);
  if (index >= 0) {
    const previous = target.commands[index]!;
    // Recovery may add positive cleanup evidence but cannot erase observed exits
    // or downgrade already-confirmed cleanup with a later unavailable probe.
    target.commands[index] = {
      ...(previous.completion === "observed" && receipt.completion === "unobserved" ? previous : receipt),
      ...(previous.cleanup === "unknown" && receipt.cleanup === "confirmed" ? { capturedAt: receipt.capturedAt } : {}),
      cleanup: previous.cleanup === "confirmed" ? "confirmed" : receipt.cleanup,
    };
  } else target.commands.push(receipt);
  while (target.commands.length > SUBAGENT_COMMAND_RECEIPTS_MAX_COUNT || Buffer.byteLength(JSON.stringify(target)) > SUBAGENT_COMMAND_RECEIPTS_MAX_BYTES) {
    target.commands.shift(); target.omitted = Math.min(Number.MAX_SAFE_INTEGER, target.omitted + 1);
  }
}

export function subagentCommandReceipt(command: SubagentOwnedCommand, capturedAt: number, result?: ProcessJobProcessResult): SubagentCommandReceipt {
  return { id: command.id, tool: command.tool, cwd: command.cwd, capturedAt, budgetMs: command.budgetMs ?? null,
    durationMs: result ? Math.floor(result.durationMs) : null, exitCode: result?.code ?? null, signal: result?.signal ?? null,
    timedOut: result?.timedOut ?? null, cancelled: result?.aborted ?? null,
    truncated: result ? result.truncated || result.bufferExceeded : null,
    completion: result ? "observed" : "unobserved", cleanup: command.state === "released" ? "confirmed" : "unknown" };
}
