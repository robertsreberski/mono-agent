import { join } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import {
  normalizeOptionalString,
  readBoolean,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/settings";
import type { SettingsJson } from "@mono-agent/settings";

import type { MonoAgentAppConfigInput } from "./app-config.js";

/**
 * Resolved conversation-history persistence settings. `dbPath` is shared by the
 * in-app store and the adapter send-tool subprocess so a proactive send lands in
 * the same durable store the channel reads. `rollover`/`rolloverTimezone` mirror
 * the responder's daily bucketing so a recorded send keys to the same thread.
 */
export interface HistorySettings {
  readonly persist: boolean;
  readonly dbPath: string;
  readonly maxMessages: number;
  readonly rollover?: string;
  readonly rolloverTimezone?: string;
}

const DEFAULT_DATA_DIR = ".mono-agent";
const HISTORY_DB_FILE = "history.db";

/** Resolve the history db path alone (no core config needed) — used by the CLI. */
export async function resolveHistoryDbPath(input: MonoAgentAppConfigInput): Promise<string> {
  const json = (await readSettingsJson(input.configPath)).json;
  return historyDbPath(json, input);
}

export async function resolveHistorySettings(
  input: MonoAgentAppConfigInput,
  coreConfig: MonoAgentConfig,
): Promise<HistorySettings> {
  const json = (await readSettingsJson(input.configPath)).json;
  const section = readJsonSection(json, "history");
  const persist = readBoolean(
    normalizeOptionalString(input.env.MONO_AGENT_HISTORY_PERSIST) ??
      (typeof section.persist === "boolean" ? String(section.persist) : undefined),
    "history.persist",
    true,
    (message) => new Error(message),
  );
  const session = coreConfig.runtime.session;
  return {
    persist,
    dbPath: historyDbPath(json, input),
    maxMessages: historyMaxMessages(coreConfig.runtime.maxTurns),
    ...(session.rollover === undefined ? {} : { rollover: session.rollover }),
    ...(session.rolloverTimezone === undefined ? {} : { rolloverTimezone: session.rolloverTimezone }),
  };
}

/** History db dir precedence: env override → history.path → memory.path → `<cwd>/.mono-agent`. */
function historyDbPath(json: SettingsJson, input: MonoAgentAppConfigInput): string {
  const dir =
    normalizeOptionalString(input.env.MONO_AGENT_HISTORY_DIR) ??
    asString(readJsonSection(json, "history").path) ??
    asString(readJsonSection(json, "memory").path) ??
    join(input.cwd, DEFAULT_DATA_DIR);
  return join(dir, HISTORY_DB_FILE);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

/** Mirror of agent-host's history bound: maxTurns*2, or 0 (unbounded) when unset. */
function historyMaxMessages(maxTurns: number | undefined): number {
  return maxTurns === undefined || maxTurns <= 0 ? 0 : maxTurns * 2;
}
