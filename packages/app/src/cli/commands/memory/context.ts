import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { listTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
  resolveAppTraceRegistryDir,
  resolveGlobalTraceRegistryDir,
} from "../../../composition/app-config.js";
import { resolveMemoryRecallSettings } from "../../../memory-recall-settings.js";
import type { MemoryRecallSettings } from "../../../memory-recall-settings.js";
import * as ui from "../../../ui.js";
import { writeMemoryForgetFailure } from "./forget-failure.js";
import { write } from "./render.js";
import { writeReplayAdoptionCliFailure } from "./replay-failure.js";
import type { MemoryCommandContext, RunMemoryCommandInput } from "./types.js";

export async function memoryRegistryDirs(context: MemoryCommandContext): Promise<readonly string[]> {
  return await dedupeRegistryDirs([
    await resolveAppTraceRegistryDir({
      env: context.env,
      cwd: context.cwd,
      configPath: context.configPath,
    }),
    resolveGlobalTraceRegistryDir(context.env),
  ]);
}

export async function loadMemoryCommandContext(
  input: RunMemoryCommandInput,
): Promise<MemoryCommandContext | { readonly code: number }> {
  const cwd = input.cwd;
  const configPath = resolve(cwd, input.configPath ?? "mono-agent.config.json");
  try {
    return {
      cwd,
      env: input.env,
      configPath,
      config: await loadAppCoreConfig({ env: input.env, cwd, configPath }),
    };
  } catch (error) {
    if (input.positionals[0] === "profile") {
      write(input.json, { code: "memory_profile_config_invalid" }, () => "memory_profile_config_invalid\n");
      return { code: 1 };
    }
    if (input.positionals[0] === "adopt-replay") {
      // Config/native failures can contain the config path or invalid private
      // values. Adoption always exposes the same closed error contract.
      writeReplayAdoptionCliFailure(input.json, "replay_adoption_config_invalid");
      return { code: 1 };
    }
    if (input.positionals[0] === "forget") {
      writeMemoryForgetFailure(input.json, input.positionals[1] ?? "unknown", "forget_config_invalid");
      return { code: 1 };
    }
    if (isAppCoreConfigError(error)) {
      process.stderr.write(ui.errorLine(error.message));
      process.stderr.write(ui.hint(`Fix ${configPath}, then re-run \`mono-agent memory\`.`));
      return { code: 1 };
    }
    throw error;
  }
}

export async function assertNoLiveConfiguredAgent(configPath: string, registryDirs: readonly string[]): Promise<void> {
  const live = await findLiveConfiguredAgent(configPath, registryDirs);
  if (live === undefined) return;
  const canonicalConfig = await canonicalPath(configPath);
  throw new Error(
    `agent process ${live.pid} (${live.sourceId}) is still alive for this config (trace health: ${live.health}); ` +
    `stop it first with: mono-agent stop --config ${canonicalConfig}`,
  );
}

export async function hasLiveConfiguredAgent(configPath: string, registryDirs: readonly string[]): Promise<boolean> {
  return await findLiveConfiguredAgent(configPath, registryDirs) !== undefined;
}

async function findLiveConfiguredAgent(
  configPath: string,
  registryDirs: readonly string[],
): Promise<TraceSourceListItem | undefined> {
  const canonicalConfig = await canonicalPath(configPath);
  const listings = await Promise.all(registryDirs.map(async (registryDir) => await listTraceSources({ registryDir })));
  const sources = dedupeTraceSources(listings.flatMap((listing) => listing.sources));
  let live: (typeof sources)[number] | undefined;
  for (const source of sources) {
    if (source.configPath === undefined || source.pid === undefined || !pidIsAlive(source.pid)) continue;
    if (await canonicalPath(source.configPath) === canonicalConfig) {
      live = source;
      break;
    }
  }
  return live;
}

async function dedupeRegistryDirs(registryDirs: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const registryDir of registryDirs) {
    const canonical = await canonicalPath(registryDir);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push(registryDir);
  }
  return deduped;
}

function dedupeTraceSources(sources: readonly TraceSourceListItem[]): TraceSourceListItem[] {
  const seen = new Set<string>();
  const deduped: TraceSourceListItem[] = [];
  for (const source of sources) {
    // Primary and global registries mirror the same source/PID pair. Preserve
    // a reused source ID with a different PID so either live process blocks.
    const key = `${source.sourceId}\0${source.pid ?? "unknown"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function previewRecallSettings(config: MonoAgentConfig): MemoryRecallSettings | undefined {
  return resolveMemoryRecallSettings(config, { ignoreRecallToolGate: true });
}
