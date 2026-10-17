import { resolve } from "node:path";

import type { TraceSourceListItem } from "@mono-agent/observability";

import { formatChannelFactValue } from "../../channels/channel-fact-format.js";
import { formatHumanChannelSections } from "../../channels/channel-status-display.js";
import type { LaunchctlResult } from "../../launchd.js";
import type { ManagedBackgroundRuntime } from "../managed-runtime/types.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "../../diagnostics/runs-health.js";
import type { BackgroundDeps, BackgroundReadyInternalOptions, InstanceTarget } from "./types.js";
import * as ui from "../../cli/ui.js";

export function runtimeVerificationLabel(mode: ManagedBackgroundRuntime["verificationMode"]): string {
  switch (mode) {
    case "fast-reuse": return "warm reuse";
    case "full-reuse": return "full verification";
    case "installed": return "installed";
    case "repaired": return "repaired";
  }
}

export function formatLifecycleDuration(milliseconds: number): string {
  const safe = Math.max(0, milliseconds);
  return safe < 1_000 ? `${Math.round(safe)} ms` : `${(safe / 1_000).toFixed(1)} s`;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function reportSnapshotDrift(target: InstanceTarget, deps: BackgroundDeps): void {
  deps.stderr(ui.errorLine("The committed config, dotenv, Identity, Soul, MCP config, or durable environment changed before background readiness."));
  deps.stderr(ui.style.dim("No readiness claim was made for a different snapshot.") + "\n");
  reportLaunchRecovery(target, deps);
}

export function printInstanceInfo(
  source: TraceSourceListItem,
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
): void {
  const flag = commandFlags(target);
  deps.stdout(`${ui.badge("ok")}${ui.style.bold(`mono-agent ${verb} in the background.`)}\n\n`);
  writeInstanceDetail(source, target, deps);
  deps.stdout("\n" + ui.hint(`Stop with: mono-agent stop${flag}   ·   Logs: mono-agent logs${flag} --follow`));
}

export function reportLaunchFailure(
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
  result: LaunchctlResult | undefined,
): void {
  deps.stderr(ui.errorLine(`Failed to ${verb} ${target.label} via launchctl${result === undefined ? "" : ` (exit ${result.code})`}.`));
  const detail = (result?.stderr || result?.stdout || "").trim();
  if (detail.length > 0) {
    deps.stderr(ui.style.dim(detail) + "\n");
  }
  reportLaunchRecovery(target, deps);
}

export function reportOwnershipConflict(target: InstanceTarget, deps: BackgroundDeps, detail: string): void {
  deps.stderr(ui.errorLine(`Refusing to launch a second worker for ${target.configPath}.`));
  deps.stderr(ui.style.dim(`${detail}.\n`));
  deps.stderr(ui.hint("No LaunchAgent changes were made. Stop the unmanaged process or reconcile launchd ownership, then retry."));
  reportLaunchRecovery(target, deps);
}

export function reportLifecycleException(
  target: InstanceTarget,
  deps: BackgroundDeps,
  operation: string,
  error: unknown,
): void {
  deps.stderr(ui.errorLine(`Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`));
  deps.stderr(ui.style.dim("The committed agent files were preserved.") + "\n");
  reportLaunchRecovery(target, deps);
}

export function reportReadinessException(deps: BackgroundDeps, error: unknown): void {
  deps.stderr(ui.errorLine(
    `Failed to read the worker readiness trace: ${error instanceof Error ? error.message : String(error)}`,
  ));
  deps.stderr(ui.style.dim("The committed agent files were preserved.") + "\n");
}

export function reportTimeout(deps: BackgroundDeps): void {
  deps.stderr(ui.errorLine("mono-agent did not report ready within the timeout."));
  deps.stderr(ui.style.dim("The committed agent files were preserved.") + "\n");
}

export function reportReadinessCleanup(
  target: InstanceTarget,
  deps: BackgroundDeps,
  stopped: boolean,
  options: BackgroundReadyInternalOptions = {},
): void {
  deps.stderr(stopped
    ? options.preserveDefinitionsOnFailure === true
      ? ui.style.dim("The unready main LaunchAgent was stopped; both definitions and the scheduled recovery controller remain for retry.") + "\n"
      : ui.style.dim("The unready LaunchAgent and scheduled maintenance were stopped and their definitions removed before returning control.") + "\n"
    : ui.style.yellow("The unready LaunchAgent could not be proven stopped; a worker or maintenance helper may still be running.") + "\n");
  reportLaunchRecovery(target, deps);
}

function reportLaunchRecovery(target: InstanceTarget, deps: BackgroundDeps): void {
  const flags = commandFlags(target);
  deps.stderr(ui.style.dim("Retry or inspect with:") + "\n");
  deps.stderr(
    `  ${ui.style.gray("logs:  ")} ${target.paths.stderrPath}\n` +
      `          ${target.paths.stdoutPath}\n` +
      `  ${ui.style.gray("retry: ")} mono-agent start${flags}\n` +
      `  ${ui.style.gray("status:")} mono-agent status${flags}\n` +
      `  ${ui.style.gray("follow:")} mono-agent logs${flags} --follow\n`,
  );
}

export function writeInstanceDetail(source: TraceSourceListItem, target: InstanceTarget, deps: BackgroundDeps): void {
  deps.stdout(ui.rule("instance"));
  deps.stdout(
    ui.keyValue(
      [
        ["pid", String(source.pid ?? "unknown")],
        ["health", `${ui.healthBadge(source.health)}${source.health}`],
        ["config", target.configPath],
        ["label", target.label],
        ["started", source.startedAt],
        ["logs", target.paths.stdoutPath],
        ["", target.paths.stderrPath],
      ],
      2,
    ),
  );
  const processJobsProtectionLines = describeProcessJobsProtectionMetadata(source);
  if (processJobsProtectionLines.length > 0) {
    deps.stdout(ui.rule("process jobs protection"));
    for (const line of processJobsProtectionLines) {
      deps.stdout(`  ${line}\n`);
    }
  }
  const sandboxLines = describeSandboxMetadata(source);
  if (sandboxLines.length > 0) {
    deps.stdout(ui.rule("sandbox"));
    for (const line of sandboxLines) {
      deps.stdout(`  ${line}\n`);
    }
  }
  const sessionLines = describeSessionMetadata(source, deps.now());
  if (sessionLines.length > 0) {
    deps.stdout(ui.rule("session"));
    for (const line of sessionLines) {
      deps.stdout(`  ${line}\n`);
    }
  }
  const channelSections = formatChannels(source);
  for (const section of channelSections) {
    deps.stdout(ui.rule(section.title));
    for (const line of section.lines) {
      deps.stdout(`${line}\n`);
    }
  }
}

export async function writeRunsHealthDetail(source: TraceSourceListItem, deps: BackgroundDeps): Promise<void> {
  if (source.artifactDir === undefined || source.artifactDir.trim().length === 0) {
    return;
  }
  const { totalRuns, runs, warnings } = await deps.listRecordedRuns({
    artifactDir: source.artifactDir,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    scope: "agent",
  });
  const selectedSkills = selectedSkillsFromMetadata(source.metadata);
  const runOwnerAlive = source.pid === undefined ? undefined : deps.isAlive(source.pid);
  const display = buildRunsHealthDisplay({
    artifactDir: source.artifactDir,
    totalRuns,
    runs,
    warnings,
    includeSelectedSkills: true,
    nowMs: deps.now(),
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    ...(selectedSkills === undefined ? {} : { selectedSkills }),
    ...(runOwnerAlive === undefined ? {} : { runOwnerAlive }),
  });
  deps.stdout(ui.rule("runs health"));
  for (const detail of display.details) {
    deps.stdout(`  ${detail}\n`);
  }
}

function selectedSkillsFromMetadata(metadata: Record<string, unknown> | undefined): readonly string[] | undefined {
  const context = metadata?.context;
  if (context === null || typeof context !== "object") {
    return undefined;
  }
  const selectedSkills = (context as Record<string, unknown>).selectedSkills;
  if (!Array.isArray(selectedSkills)) {
    return undefined;
  }
  return selectedSkills.flatMap((skill) => typeof skill === "string" ? [skill] : []);
}

export function formatOtherInstance(source: TraceSourceListItem): string {
  const pid = source.pid === undefined ? "?" : String(source.pid);
  const config = source.configPath ?? "(unknown config)";
  return `  ${ui.healthBadge(source.health)}${source.health.padEnd(8)} pid ${pid.padEnd(7)} ${source.sourceId}  ${config}`;
}

export function channelRecords(source: TraceSourceListItem): readonly Record<string, unknown>[] {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") return [];
  return Object.values(channels as Record<string, unknown>)
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object");
}

function describeSandboxMetadata(source: TraceSourceListItem): string[] {
  const sandbox = source.metadata?.sandbox;
  if (sandbox === null || typeof sandbox !== "object") {
    return [];
  }
  const record = sandbox as Record<string, unknown>;
  const effective = stringField(record, "effective") ?? "unknown";
  const engine = stringField(record, "engine") ?? "none";
  const engineAvailability = record.engineAvailable === true
    ? "present"
    : record.engineAvailable === false
      ? "absent"
      : "not checked";
  const fallback = stringField(record, "fallback");
  const fallbackActive = record.fallbackActive === true ? "yes" : "no";
  const summary = [
    `effective: ${effective}`,
    `engine: ${engine} (${engineAvailability})`,
    ...(fallback === undefined ? [] : [`fallback: ${fallback}`]),
    `fallback active: ${fallbackActive}`,
  ].join("; ");
  return [
    summary,
    ...stringFieldAsList(record, "detail"),
    ...stringFieldAsList(record, "warning").map((warning) => ui.style.yellow(warning)),
  ];
}

function describeProcessJobsProtectionMetadata(source: TraceSourceListItem): string[] {
  const processJobs = source.metadata?.processJobs;
  if (!isPlainRecord(processJobs) || !isPlainRecord(processJobs.protection)) return [];
  const protection = processJobs.protection;
  const mode = stringField(protection, "protection");
  if (mode === undefined) return [];
  return [
    `protection: ${mode}; retained roots: ${protection.retainedRoots === true ? "yes" : "no"}`,
    ...stringFieldAsList(protection, "warning").map((warning) => ui.style.yellow(warning)),
  ];
}

function describeSessionMetadata(source: TraceSourceListItem, nowMs: number): string[] {
  const session = source.metadata?.session;
  if (session === null || typeof session !== "object") {
    return [];
  }
  const record = session as Record<string, unknown>;
  const bucket = stringField(record, "currentBucketId");
  if (bucket === undefined) {
    return [];
  }
  const current = sessionSnapshotRecord(record, bucket);
  const hasSnapshot = Array.isArray(record.snapshot);
  const state = current === undefined
    ? hasSnapshot ? "cold" : stringField(record, "state") ?? stringField(record, "status") ?? "cold"
    : "warm";
  const event = stringField(record, "event");
  const providerSessionId = current?.providerSessionId ?? stringField(record, "providerSessionId");
  const nextRolloverAt = stringField(record, "nextRolloverAt");
  const reason = stringField(record, "reason");
  const createdAt = current?.createdAt ?? numberField(record, "createdAt");
  const summary = [
    `bucket: ${bucket}`,
    `state: ${state}`,
    `age: ${formatSessionAge(createdAt, nowMs)}`,
    ...(event === undefined ? [] : [`event: ${event}`]),
    ...(providerSessionId === undefined ? [] : [`provider: ${providerSessionId}`]),
    ...(nextRolloverAt === undefined ? [] : [`next rollover: ${nextRolloverAt}`]),
    ...(reason === undefined ? [] : [`reason: ${reason}`]),
  ];
  return [summary.join("; ")];
}

function sessionSnapshotRecord(
  record: Record<string, unknown>,
  bucket: string,
): { providerSessionId: string; createdAt: number } | undefined {
  const snapshot = record.snapshot;
  if (!Array.isArray(snapshot)) {
    return undefined;
  }
  for (const item of snapshot) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (stringField(entry, "conversationId") !== bucket) {
      continue;
    }
    const providerSessionId = stringField(entry, "providerSessionId");
    const createdAt = numberField(entry, "createdAt");
    if (providerSessionId !== undefined && createdAt !== undefined) {
      return { providerSessionId, createdAt };
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatSessionAge(createdAt: number | undefined, nowMs: number): string {
  if (createdAt === undefined) {
    return "unknown";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - createdAt) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h`;
  }
  return `${Math.floor(elapsedHours / 24)}d`;
}

function stringFieldAsList(record: Record<string, unknown>, key: string): string[] {
  const value = stringField(record, key);
  return value === undefined ? [] : [value];
}

/** ` --config <path>` when a non-default config is in play, else empty. */
function configFlag(target: InstanceTarget): string {
  const defaultPath = resolve(target.cwd, "mono-agent.config.json");
  return target.configPath === defaultPath ? "" : ` --config ${shellCommandArgument(target.configPath)}`;
}

export function commandFlags(target: InstanceTarget): string {
  return `${configFlag(target)}${target.envFile === undefined ? "" : ` --env-file ${shellCommandArgument(target.envFile)}`}`;
}

function shellCommandArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatChannels(source: TraceSourceListItem): ReturnType<typeof formatHumanChannelSections> {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") {
    return [];
  }
  return formatHumanChannelSections(Object.entries(channels as Record<string, unknown>).map(([id, value]) => {
    const { kind, text } = describeChannel(value);
    return { id, kind, text };
  }));
}

export function describeChannel(value: unknown): { kind: string; text: string } {
  if (value === null || typeof value !== "object") {
    return { kind: "unknown", text: formatChannelFactValue(value) };
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  if (kind === "running") {
    // Route every fact through the shared recursive formatter so a nested object
    // (e.g. the webhook `invokeUrls` map) never renders as `[object Object]` —
    // the E4 bug that persisted on this backgrounded-start summary path after the
    // `status`-line render was fixed.
    const facts = Object.entries(record)
      .filter(([key]) => key !== "kind")
      .map(([key, fact]) => `${key}=${formatChannelFactValue(fact)}`)
      .join(" ");
    return { kind, text: facts.length === 0 ? "running" : `running (${facts})` };
  }
  const reason = typeof record.reason === "string" ? record.reason : "";
  return { kind, text: reason.length === 0 ? kind : `${kind}: ${reason}` };
}
