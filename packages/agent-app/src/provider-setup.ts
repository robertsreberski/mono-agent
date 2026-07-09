import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPiOAuthApiKeyResolver, modelReferenceKey, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

export type ProviderSetupKind = "auth" | "preflight";

export interface ProviderSetupCommandAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiLoginAction extends ProviderSetupCommandAction {
  readonly id: `pi-login:${string}`;
  readonly piAuthPath: string;
}

export interface ProviderSetupHttpAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly url: string;
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiApiKeyAction {
  readonly id: string;
  readonly kind: "auth";
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly provider: string;
  readonly envVar: string;
  readonly piAuthPath: string;
  readonly cwd: string;
  readonly detail: string;
}

export type ProviderSetupAction =
  | ProviderSetupPiLoginAction
  | ProviderSetupCommandAction
  | ProviderSetupHttpAction
  | ProviderSetupPiApiKeyAction;

export interface ProviderSetupPlan {
  readonly actions: readonly ProviderSetupAction[];
}

export type ProviderSetupStatus = "ok" | "failed" | "skipped";

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
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const PI_OAUTH_LOGIN_PROVIDERS = new Set(["anthropic", "github-copilot", "openai-codex"]);
const PI_API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
};

function resolvePiCliPath(): string {
  return fileURLToPath(new URL("../node_modules/@earendil-works/pi-ai/dist/cli.js", import.meta.url));
}

export function piLoginCommand(provider: string): readonly [string, ...string[]] {
  return [process.execPath, resolvePiCliPath(), "login", provider];
}

export function piLoginCommandLine(provider: string): string {
  return piAuthRecoveryCommand(provider);
}

export function piAuthRecoveryCommand(provider: string, piAuthPath?: string): string {
  return piAuthPath === undefined
    ? `mono-agent auth login ${provider}`
    : `mono-agent auth login ${provider} --pi-auth-path ${piAuthPath}`;
}

export function piAuthWorkingDirectory(piAuthPath: string | undefined, cwd = process.cwd()): string {
  return dirname(piAuthPath === undefined ? DEFAULT_PI_AUTH_PATH : resolve(cwd, piAuthPath));
}

export function piAuthPathForSetup(piAuthPath: string | undefined, cwd = process.cwd()): string {
  return piAuthPath === undefined ? DEFAULT_PI_AUTH_PATH : resolve(cwd, piAuthPath);
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
        id: "pi-api-key:opencode-go",
        kind: "auth",
        label: "OpenCode-Go API key",
        modelRefs: [refKey],
        provider: ref.provider,
        envVar: PI_API_KEY_PROVIDERS[ref.provider] ?? "OPENCODE_API_KEY",
        piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
        cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
        detail: "Stores the OpenCode-Go API key in the Pi auth store used by providers.piAuthPath.",
      });
      continue;
    }

    if (!PI_OAUTH_LOGIN_PROVIDERS.has(ref.provider)) {
      continue;
    }

    add({
      id: `pi-login:${ref.provider}`,
      kind: "auth",
      label: `Pi login for ${ref.provider}`,
      modelRefs: [refKey],
      command: piLoginCommand(ref.provider),
      piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
      cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
      detail: `Runs bundled Pi auth for provider \`${ref.provider}\` and securely replaces providers.piAuthPath.`,
    });
  }

  return { actions: [...actionsById.values()] };
}

export function providerSetupActionCommandLine(action: ProviderSetupAction): string {
  if ("command" in action) {
    if (isProviderSetupPiLoginAction(action)) {
      return piAuthRecoveryCommand(action.id.slice("pi-login:".length), action.piAuthPath);
    }
    return action.command.join(" ");
  }
  if (isProviderSetupPiApiKeyAction(action)) {
    return `${action.envVar} -> ${action.piAuthPath}`;
  }
  return `GET ${action.url}`;
}

export function isProviderSetupPiApiKeyAction(action: ProviderSetupAction): action is ProviderSetupPiApiKeyAction {
  return "provider" in action && "piAuthPath" in action && "envVar" in action;
}

export function isProviderSetupPiLoginAction(action: ProviderSetupAction): action is ProviderSetupPiLoginAction {
  return action.id.startsWith("pi-login:") && "piAuthPath" in action && "command" in action;
}

export async function executeProviderSetupPlan(
  plan: ProviderSetupPlan,
  options: ExecuteProviderSetupOptions = {},
): Promise<ProviderSetupResult[]> {
  const results: ProviderSetupResult[] = [];
  for (const action of plan.actions) {
    const result = isProviderSetupPiApiKeyAction(action)
      ? await runPiApiKeyAction(action, options.apiKeys ?? {})
      : "command" in action
      ? await runCommandAction(action, options.spawn ?? spawn)
      : await runHttpAction(action, options.fetch ?? fetch);
    results.push(result);
    if (result.status === "failed") {
      break;
    }
  }
  return results;
}

async function runPiApiKeyAction(
  action: ProviderSetupPiApiKeyAction,
  apiKeys: Readonly<Record<string, string | undefined>>,
): Promise<ProviderSetupResult> {
  const raw = apiKeys[action.id] ?? apiKeys[action.provider] ?? process.env[action.envVar];
  const key = raw?.trim();
  if (key === undefined || key.length === 0) {
    return {
      action,
      status: "skipped",
      detail: `${action.envVar} was not provided; skipped saving credentials for ${action.provider}.`,
    };
  }

  try {
    const resolver = createPiOAuthApiKeyResolver({ path: action.piAuthPath });
    if (resolver.modifyCredential === undefined) {
      throw new Error("Pi auth resolver does not support credential writes.");
    }
    await resolver.modifyCredential(action.provider, async () => ({ type: "api_key", key }));
    return {
      action,
      status: "ok",
      detail: `Saved API key credentials for ${action.provider} to the Pi auth store.`,
    };
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runCommandAction(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
): Promise<ProviderSetupResult> {
  if (isProviderSetupPiLoginAction(action)) {
    return await runPiLoginAction(action, spawnImpl);
  }
  const [file, ...args] = action.command;
  return await runSpawnedCommand(action, spawnImpl, action.cwd);
}

async function runPiLoginAction(
  action: ProviderSetupPiLoginAction,
  spawnImpl: typeof spawn,
): Promise<ProviderSetupResult> {
  let stagingDir: string | undefined;
  try {
    await mkdir(dirname(action.piAuthPath), { recursive: true, mode: 0o700 });
    stagingDir = await mkdtemp(join(dirname(action.piAuthPath), ".mono-agent-pi-auth-"));
    const stagedAuthPath = join(stagingDir, "auth.json");
    try {
      await copyFile(action.piAuthPath, stagedAuthPath);
      await chmod(stagedAuthPath, 0o600);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    const result = await runSpawnedCommand(action, spawnImpl, stagingDir);
    if (result.status !== "ok") {
      return result;
    }
    await chmod(stagedAuthPath, 0o600);
    await rename(stagedAuthPath, action.piAuthPath);
    await chmod(action.piAuthPath, 0o600);
    return {
      action,
      status: "ok",
      detail: `${providerSetupActionCommandLine(action)} saved credentials to ${action.piAuthPath}.`,
    };
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (stagingDir !== undefined) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function runSpawnedCommand(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
  cwd: string,
): Promise<ProviderSetupResult> {
  const [file, ...args] = action.command;
  return new Promise((resolve) => {
    const child = spawnImpl(file, args, {
      cwd,
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
