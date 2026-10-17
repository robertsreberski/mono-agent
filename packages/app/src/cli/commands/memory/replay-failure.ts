import * as ui from "../../../ui.js";
import { write } from "./render.js";
const REPLAY_ADOPTION_SCHEMA_VERSION = 1;

type ReplayAdoptionFailureCode =
  | "replay_adoption_usage"
  | "replay_adoption_config_invalid"
  | "replay_adoption_requires_bujo"
  | "replay_adoption_agent_running"
  | "replay_adoption_failed";

const REPLAY_ADOPTION_FAILURE_MESSAGES: Readonly<Record<ReplayAdoptionFailureCode, string>> = Object.freeze({
  replay_adoption_usage: "Usage: mono-agent memory adopt-replay [--json] [--config <path>] [--env-file <path>].",
  replay_adoption_config_invalid: "Replay adoption requires a valid mono-agent configuration.",
  replay_adoption_requires_bujo: "Replay adoption requires a configured built-in BuJo memory store with embeddings.",
  replay_adoption_agent_running: "Replay adoption requires the configured agent to be stopped. Stop it and retry.",
  replay_adoption_failed: "Replay adoption failed. Keep the agent stopped, inspect strict memory health, resolve the reported condition, and retry.",
});

export function writeReplayAdoptionCliFailure(json: boolean, code: ReplayAdoptionFailureCode): void {
  const result = {
    schemaVersion: REPLAY_ADOPTION_SCHEMA_VERSION,
    operation: "adopt-replay" as const,
    status: "failed" as const,
    code,
    message: REPLAY_ADOPTION_FAILURE_MESSAGES[code],
  };
  if (json) {
    write(true, result, () => "");
    return;
  }
  process.stderr.write(ui.errorLine(`[${result.code}] ${result.message}`));
}
