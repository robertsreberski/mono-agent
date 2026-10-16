import { isDeepStrictEqual } from "node:util";
import { processIncarnationsEqual,type ProcessIncarnation } from "@mono-agent/conversation/process-incarnation";
import type { SubagentExecutionOwnership } from "./subagents/types.js";

/** Owner-supplied capabilities only. No command creation, registry writes or path discovery. */
export interface SubagentOwnershipRecoveryCapabilities {
  readonly currentIncarnation: ProcessIncarnation;
  readIncarnation(pid: number): Promise<ProcessIncarnation | undefined>;
  sameIncarnation(pid: number, expected: ProcessIncarnation): Promise<boolean>;
  groupAbsent(pgid: number): boolean;
  signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): boolean;
  grace(): Promise<void>;
  waitForGroupExit(pgid: number): Promise<boolean>;
  cleanup(settingsPath: string | null): Promise<boolean>;
}

/** One bounded observation/termination pass. Reporting state is intentionally not an input. */
export async function reconcileSubagentExecutionOwnership(
  input: SubagentExecutionOwnership,
  capabilities: SubagentOwnershipRecoveryCapabilities,
): Promise<SubagentExecutionOwnership> {
  const value = structuredClone(input);
  value.revoked = true;
  if (["running", "unknown"].includes(value.owner.settlement)) {
    try {
      // Boot ids are comparable only within one schema (Darwin v1 calendar boot
      // time is not a v2 boot-session UUID).
      if (differentBoot(value.owner.incarnation, capabilities.currentIncarnation)) value.owner.settlement = "dead";
      else {
        // Liveness: only ESRCH (undefined) or comparable mismatching evidence proves
        // death. A read failure or a legacy/incomparable record leaves the owner unknown.
        const actual = await capabilities.readIncarnation(value.owner.pid);
        value.owner.settlement = actual === undefined
          || (actual.schema === value.owner.incarnation.schema && !processIncarnationsEqual(actual, value.owner.incarnation))
          ? "dead" : "unknown";
      }
    } catch { value.owner.settlement = "unknown"; }
  }
  const command = value.command;
  // A live/unknown provider may still race its old command admission. Only proven
  // death or durable true settlement authorizes this recovery pass to clean it.
  if (command && command.state !== "released" && ["dead", "settled"].includes(value.owner.settlement)) {
    let absent = false;
    try {
      absent = command.pid === null && command.incarnation === null;
      absent ||= command.incarnation !== null && differentBoot(command.incarnation, capabilities.currentIncarnation);
      absent ||= command.pgid !== null && capabilities.groupAbsent(command.pgid);
      if (!absent && command.pid !== null && command.pgid === command.pid && command.incarnation !== null
        && await capabilities.sameIncarnation(command.pid, command.incarnation)) {
        const termAccepted = capabilities.signalGroup(command.pgid, "SIGTERM");
        await capabilities.grace();
        absent = termAccepted && capabilities.groupAbsent(command.pgid);
        if (!absent && await capabilities.sameIncarnation(command.pid, command.incarnation)) {
          const killAccepted = capabilities.signalGroup(command.pgid, "SIGKILL");
          absent = killAccepted && await capabilities.waitForGroupExit(command.pgid);
        }
      }
      command.state = absent && await capabilities.cleanup(command.sandboxSettingsPath) ? "released" : "cleanup_unknown";
    } catch { command.state = "cleanup_unknown"; }
  }
  if (!isDeepStrictEqual(value, input)) {
    // Ownership observation never certifies registry publication. A lost write
    // pins P; callers persist this before any release notification or wake.
    if (value.publication.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Subagent publication sequence exhausted.");
    value.publication = { sequence: value.publication.sequence + 1, state: "pending" };
  }
  return value;
}

function differentBoot(recorded: ProcessIncarnation, current: ProcessIncarnation): boolean {
  return recorded.schema === current.schema && recorded.bootSessionId !== current.bootSessionId;
}
