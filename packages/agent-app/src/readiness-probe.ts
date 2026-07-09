import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAppCoreConfig } from "./app-config.js";
import { createConfiguredAgentRuntime } from "./configured-agent.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type { WizardPlan } from "./wizard/answers.js";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";

export interface ReadinessProbeOptions {
  readonly plan: WizardPlan;
  /** The selected required module secrets, held only for this process. */
  readonly secretValues?: Readonly<Record<string, string>>;
  /** Test seam; production preserves its non-mono-agent host environment. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Test seam; production calls the configured runtime directly. */
  readonly run?: (input: {
    readonly config: Awaited<ReturnType<typeof loadAppCoreConfig>>;
    readonly options: RuntimeRunOptions;
  }) => Promise<RuntimeResult>;
}

export type ReadinessProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * The probe must not inherit a configured agent from the shell it happens to
 * run in. Provider auth/runtime variables remain available, while every
 * ambient MONO_AGENT_* override is excluded before layered config loading.
 * Selected wizard secrets are an in-memory overlay and are intentionally added
 * afterwards; they are never written to the disposable workspace.
 */
export function readinessProbeEnvironment(
  hostEnv: Readonly<Record<string, string | undefined>>,
  secretValues: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  const sanitized = Object.fromEntries(
    Object.entries(hostEnv).filter(([name]) => !name.startsWith("MONO_AGENT_")),
  ) as Record<string, string | undefined>;
  return { ...sanitized, ...secretValues };
}

/**
 * Make one real assistant turn in a disposable directory before init writes the
 * selected target. This deliberately never starts an app/channel/harness and
 * tests only the selected primary model (never its fallback chain).
 */
export async function runReadinessProbe(options: ReadinessProbeOptions): Promise<ReadinessProbeResult> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-readiness-"));
  try {
    const config = structuredClone(options.plan.configJson) as Record<string, unknown>;
    config.tools = { allowedTools: [], disallowedTools: [] };
    const runtime = config.runtime as Record<string, unknown>;
    config.runtime = { ...runtime, workspace: ".mono-agent/workspace" };
    delete (config.runtime as Record<string, unknown>).fallbackModels;
    delete (config.runtime as Record<string, unknown>).session;
    delete config.memory;
    delete config.artifacts;
    delete config.traceability;
    delete config.observability;
    const providers = config.providers as Record<string, unknown> | undefined;
    if (providers?.piNative !== undefined && typeof providers.piNative === "object" && providers.piNative !== null) {
      const piNative = { ...(providers.piNative as Record<string, unknown>) };
      delete piNative.piSessionsRoot;
      config.providers = { ...providers, piNative };
    }
    delete config.webhook;
    delete config.telegram;
    delete config.slack;
    delete config.openaiApi;
    delete config.cron;
    // The target's context can point to files outside this ephemeral workspace.
    // A probe validates a known-good, self-contained identity instead.
    config.context = { identityPath: "./IDENTITY.md", selectedSkills: [] };
    await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "IDENTITY.md"),
      "# Readiness probe identity\n\nYou are checking that the selected model can produce one concise response.\n",
      { mode: 0o600 },
    );
    await mkdir(join(dir, ".mono-agent", "workspace"), { recursive: true });
    await mkdir(join(dir, ".mono-agent", "artifacts"), { recursive: true });
    const overlay = readinessProbeEnvironment(options.hostEnv ?? process.env, options.secretValues);
    const loaded = await loadAppCoreConfig({
      cwd: dir,
      configPath: join(dir, "mono-agent.config.json"),
      env: overlay,
    });
    // This checks the generated config plus its IDENTITY.md before contacting a
    // provider. No channel driver is loaded, no liveness probe runs, and writes
    // are disabled; the disposable probe remains side-effect free.
    const validation = await validateMonoAgentFolder({
      cwd: dir,
      configPath: join(dir, "mono-agent.config.json"),
      env: overlay,
      drivers: [],
      liveness: false,
      allowFilesystemWrites: false,
    });
    if (!validation.ok) {
      return { ok: false, message: validation.sections.flatMap((section) => section.details).join(" ") };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const runOptions: RuntimeRunOptions = {
        model: loaded.runtime.model,
        ...(loaded.runtime.executionMode === undefined ? {} : { executionMode: loaded.runtime.executionMode }),
        messages: [{ role: "user", content: "Reply with a short readiness acknowledgement." }],
        abortSignal: controller.signal,
        cwd: dir,
        maxTurns: 1,
        allowedTools: [],
        disallowedTools: [],
        mcpServers: {},
        // Codex honors this extension; other runtime bridges ignore it.
        sessionKeepAlive: false,
      };
      const result = options.run === undefined
        ? await createConfiguredAgentRuntime(loaded).run("Reply concisely. Do not use tools.", runOptions)
        : await options.run({ config: loaded, options: runOptions });
      const text = result.text ?? "";
      return text.trim().length > 0 && (result.error === undefined || result.error === null)
        ? { ok: true }
        : { ok: false, message: result.error ?? "The selected model returned an empty first response." };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
