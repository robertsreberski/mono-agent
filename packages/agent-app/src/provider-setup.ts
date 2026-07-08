import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { modelReferenceKey, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

export type ProviderSetupKind = "auth" | "preflight";

export type ProviderSetupAction =
  | {
      readonly id: string;
      readonly kind: ProviderSetupKind;
      readonly label: string;
      readonly modelRefs: readonly string[];
      readonly command: readonly [string, ...string[]];
      readonly cwd: string;
      readonly detail: string;
    }
  | {
      readonly id: string;
      readonly kind: ProviderSetupKind;
      readonly label: string;
      readonly modelRefs: readonly string[];
      readonly url: string;
      readonly cwd: string;
      readonly detail: string;
    };

export interface ProviderSetupPlan {
  readonly actions: readonly ProviderSetupAction[];
}

export type ProviderSetupStatus = "ok" | "failed";

export interface ProviderSetupResult {
  readonly action: ProviderSetupAction;
  readonly status: ProviderSetupStatus;
  readonly detail: string;
}

export interface PlanProviderSetupOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly piAuthPath?: string;
}

export interface ExecuteProviderSetupOptions {
  readonly spawn?: typeof spawn;
  readonly fetch?: typeof fetch;
}

const DEFAULT_PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export function piLoginCommand(provider: string): readonly [string, ...string[]] {
  return ["npx", "@earendil-works/pi-ai", "login", provider];
}

export function piLoginCommandLine(provider: string): string {
  return piLoginCommand(provider).join(" ");
}

export function piAuthWorkingDirectory(piAuthPath: string | undefined, cwd = process.cwd()): string {
  return dirname(piAuthPath === undefined ? DEFAULT_PI_AUTH_PATH : resolve(cwd, piAuthPath));
}

export function planProviderSetup(options: PlanProviderSetupOptions): ProviderSetupPlan {
  const piAuthPath = options.piAuthPath ?? DEFAULT_PI_AUTH_PATH;
  const actionsById = new Map<string, ProviderSetupAction>();

  for (const raw of options.modelRefs) {
    let ref;
    try {
      ref = parseMonoRuntimeModelReference(raw);
    } catch {
      continue;
    }

    const refKey = modelReferenceKey(ref);
    const add = (action: ProviderSetupAction) => {
      const existing = actionsById.get(action.id);
      if (existing === undefined) {
        actionsById.set(action.id, action);
        return;
      }
      actionsById.set(action.id, {
        ...existing,
        modelRefs: [...new Set([...existing.modelRefs, ...action.modelRefs])],
      } as ProviderSetupAction);
    };

    if (ref.sdk === "claude") {
      add({
        id: "claude-login",
        kind: "auth",
        label: "Claude login",
        modelRefs: [refKey],
        command: ["claude", "/login"],
        cwd: options.cwd,
        detail: "Runs the Claude Code login flow for Claude model references.",
      });
      continue;
    }

    if (ref.sdk === "codex") {
      add({
        id: "codex-login",
        kind: "auth",
        label: "Codex login",
        modelRefs: [refKey],
        command: ["codex", "login"],
        cwd: options.cwd,
        detail: "Runs the Codex login flow for direct Codex model references.",
      });
      continue;
    }

    if (ref.sdk === "opencode") {
      add({
        id: "opencode-models",
        kind: "preflight",
        label: "OpenCode model preflight",
        modelRefs: [refKey],
        command: ["opencode", "models", "--json"],
        cwd: options.cwd,
        detail: "Checks that OpenCode can list configured models.",
      });
      continue;
    }

    if (ref.sdk !== "pi" || typeof ref.provider !== "string") {
      continue;
    }

    if (ref.provider === "ollama") {
      add({
        id: "ollama-list",
        kind: "preflight",
        label: "Ollama model preflight",
        modelRefs: [refKey],
        command: ["ollama", "list"],
        cwd: options.cwd,
        detail: "Checks that the local Ollama server and CLI can list installed models.",
      });
      continue;
    }

    if (ref.provider === "lmstudio") {
      add({
        id: "lmstudio-models",
        kind: "preflight",
        label: "LM Studio model preflight",
        modelRefs: [refKey],
        url: "http://localhost:1234/v1/models",
        cwd: options.cwd,
        detail: "Checks that LM Studio's OpenAI-compatible local server exposes models.",
      });
      continue;
    }

    if (ref.provider === "opencode-go") {
      add({
        id: "opencode-models",
        kind: "preflight",
        label: "OpenCode model preflight",
        modelRefs: [refKey],
        command: ["opencode", "models", "--json"],
        cwd: options.cwd,
        detail: "Checks that OpenCode can list configured models.",
      });
      continue;
    }

    add({
      id: `pi-login:${ref.provider}`,
      kind: "auth",
      label: `Pi login for ${ref.provider}`,
      modelRefs: [refKey],
      command: piLoginCommand(ref.provider),
      cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
      detail: `Runs Pi auth for provider \`${ref.provider}\` from the providers.piAuthPath directory.`,
    });
  }

  return { actions: [...actionsById.values()] };
}

export function providerSetupActionCommandLine(action: ProviderSetupAction): string {
  if ("command" in action) {
    return action.command.join(" ");
  }
  return `GET ${action.url}`;
}

export async function executeProviderSetupPlan(
  plan: ProviderSetupPlan,
  options: ExecuteProviderSetupOptions = {},
): Promise<ProviderSetupResult[]> {
  const results: ProviderSetupResult[] = [];
  for (const action of plan.actions) {
    const result = "command" in action
      ? await runCommandAction(action, options.spawn ?? spawn)
      : await runHttpAction(action, options.fetch ?? fetch);
    results.push(result);
    if (result.status === "failed") {
      break;
    }
  }
  return results;
}

async function runCommandAction(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
): Promise<ProviderSetupResult> {
  const [file, ...args] = action.command;
  return new Promise((resolve) => {
    const child = spawnImpl(file, args, {
      cwd: action.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      resolve({ action, status: "failed", detail: error.message });
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ action, status: "ok", detail: `${providerSetupActionCommandLine(action)} exited 0.` });
        return;
      }
      resolve({
        action,
        status: "failed",
        detail: signal === null
          ? `${providerSetupActionCommandLine(action)} exited ${code ?? "unknown"}.`
          : `${providerSetupActionCommandLine(action)} terminated by ${signal}.`,
      });
    });
  });
}

async function runHttpAction(
  action: Extract<ProviderSetupAction, { readonly url: string }>,
  fetchImpl: typeof fetch,
): Promise<ProviderSetupResult> {
  try {
    const response = await fetchImpl(action.url);
    if (response.ok) {
      return { action, status: "ok", detail: `GET ${action.url} returned ${response.status}.` };
    }
    return { action, status: "failed", detail: `GET ${action.url} returned ${response.status}.` };
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
