import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAppCoreConfig } from "./app-config.js";
import { createConfiguredAgentRuntime } from "./configured-agent.js";
import type { WizardPlan } from "./wizard/answers.js";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";

export interface ReadinessProbeOptions {
  readonly plan: WizardPlan;
  /** The selected required module secrets, held only for this process. */
  readonly secretValues?: Readonly<Record<string, string>>;
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
    config.runtime = { ...runtime };
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
    await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await mkdir(join(dir, ".mono-agent", "workspace"), { recursive: true });
    await mkdir(join(dir, ".mono-agent", "artifacts"), { recursive: true });
    // The overlay is passed only to config loading. It never mutates process.env.
    const overlay = { ...process.env, ...(options.secretValues ?? {}) };
    const loaded = await loadAppCoreConfig({
      cwd: dir,
      configPath: join(dir, "mono-agent.config.json"),
      env: overlay,
    });
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
