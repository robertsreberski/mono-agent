import { chmod, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { EffortLevel } from "@mono-agent/config";

const execFile = promisify(execFileCallback);

export type WizardModelSource = "claude" | "pi" | "codex" | "opencode" | "ollama" | "lmstudio" | "custom";

export interface WizardModelCandidate {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly source: WizardModelSource;
  readonly discovered?: boolean;
  readonly setupRequired?: boolean;
  readonly defaultEffort?: EffortLevel;
}

export interface ModelDiscoveryStatus {
  readonly provider: "Codex" | "Pi" | "OpenCode" | "Ollama" | "LM Studio";
  readonly status: "detected" | "setup_available" | "unavailable";
  readonly detail: string;
}

export interface ModelDiscoveryResult {
  readonly candidates: readonly WizardModelCandidate[];
  readonly statuses: readonly ModelDiscoveryStatus[];
}

interface ExecResult {
  readonly stdout: string;
}

export interface DiscoverWizardModelsOptions {
  readonly execFile?: (file: string, args: readonly string[], opts: {
    readonly timeout: number;
    readonly env?: Record<string, string | undefined>;
  }) => Promise<ExecResult>;
  readonly fetch?: typeof fetch;
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly piAuthPath?: string;
  readonly timeoutMs?: number;
}

interface DiscoveredModelEntry {
  readonly id: string;
  readonly reasoning?: boolean;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1200;
const DEFAULT_OPENCODE_DISCOVERY_TIMEOUT_MS = 5000;
const PI_OPENAI_CODEX_PROVIDER = "openai-codex";

interface CuratedOpenAiCodexModel {
  readonly id: string;
  readonly name: string;
  readonly minimumCodexCliVersion?: readonly [major: number, minor: number, patch: number];
}

const OPENAI_CODEX_MODELS: readonly CuratedOpenAiCodexModel[] = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", minimumCodexCliVersion: [0, 144, 0] },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", minimumCodexCliVersion: [0, 144, 0] },
];

export const STATIC_MODEL_CANDIDATES: readonly WizardModelCandidate[] = [
  ...OPENAI_CODEX_MODELS.map(staticDirectCodexCandidate),
  ...OPENAI_CODEX_MODELS.map(staticPiOpenAiCodexCandidate),
  { value: "claude:claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "claude", defaultEffort: "medium" },
  { value: "pi:ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local", source: "ollama", defaultEffort: "none" },
];

export async function discoverWizardModelCandidates(
  opts: DiscoverWizardModelsOptions = {},
): Promise<ModelDiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const [codex, pi, opencode, ollama, lmstudio] = await Promise.all([
    discoverDirectCodex({ ...opts, timeoutMs }),
    discoverPiOpenAiCodex({ ...opts, timeoutMs }),
    discoverOpenCodeModels({
      ...opts,
      timeoutMs: opts.timeoutMs ?? DEFAULT_OPENCODE_DISCOVERY_TIMEOUT_MS,
    }),
    discoverOllamaModels({ ...opts, timeoutMs }),
    discoverLmStudioModels({ ...opts, timeoutMs }),
  ]);

  return {
    candidates: rankWizardModelCandidates([
      ...STATIC_MODEL_CANDIDATES,
      ...codex.candidates,
      ...pi.candidates,
      ...opencode.candidates,
      ...ollama.candidates,
      ...lmstudio.candidates,
    ]),
    statuses: [codex.status, pi.status, opencode.status, ollama.status, lmstudio.status],
  };
}

export function rankWizardModelCandidates(
  candidates: readonly WizardModelCandidate[],
): WizardModelCandidate[] {
  const byValue = new Map<string, WizardModelCandidate>();
  for (const candidate of candidates) {
    const existing = byValue.get(candidate.value);
    byValue.set(candidate.value, existing === undefined ? candidate : mergeCandidate(existing, candidate));
  }
  return [...byValue.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

export function formatModelDiscoveryStatus(statuses: readonly ModelDiscoveryStatus[]): string {
  return statuses.map((status) => `${status.provider}: ${status.detail}`).join("\n");
}

export function defaultEffortForModelRef(modelRef: string, reasoning?: boolean): EffortLevel | undefined {
  if (reasoning === true) {
    return "medium";
  }
  if (reasoning === false) {
    return "none";
  }

  if (modelRef.startsWith("claude:") || modelRef.startsWith("codex:") || modelRef.startsWith("pi:openai-codex:")) {
    return "medium";
  }

  if (!modelRef.startsWith("pi:")) {
    return undefined;
  }

  const [, provider, ...modelParts] = modelRef.split(":");
  const model = modelParts.join(":");
  if (provider === "opencode-go" || provider === "ollama" || provider === "lmstudio") {
    return localModelDefaultEffort(model);
  }

  return undefined;
}

/** Detect the direct Codex CLI and verify that its login is usable. */
async function discoverDirectCodex(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = opts.execFile ?? execFile;
  let version = "";
  try {
    const result = await run("codex", ["--version"], { timeout: opts.timeoutMs });
    version = firstOutputLine(result.stdout);
  } catch {
    return {
      candidates: directCodexCandidates("install-required"),
      status: {
        provider: "Codex",
        status: "setup_available",
        detail: "CLI not found; install Codex and sign in before the readiness check",
      },
    };
  }

  try {
    await run("codex", ["login", "status"], { timeout: opts.timeoutMs });
    const candidates = directCodexCandidates("ready", version);
    const setupModels = candidates.filter((candidate) => candidate.setupRequired === true);
    const setupDetails = [...new Set(setupModels.map((candidate) => candidate.hint ?? `${candidate.label} setup required`))];
    return {
      candidates,
      status: {
        provider: "Codex",
        status: setupModels.length === 0 ? "detected" : "setup_available",
        detail: `${version.length > 0 ? `${version}; ` : ""}signed in${
          setupModels.length === 0
            ? ""
            : `; ${setupDetails.join("; ")}`
        }`,
      },
    };
  } catch {
    return {
      candidates: directCodexCandidates("login-required", version),
      status: {
        provider: "Codex",
        status: "setup_available",
        detail: `${version.length > 0 ? `${version}; ` : "CLI installed; "}sign-in required`,
      },
    };
  }
}

async function discoverPiOpenAiCodex(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const read = opts.readFile ?? readFile;
  const authPath = opts.piAuthPath ?? join(homedir(), ".pi", "agent", "auth.json");
  try {
    const auth = parseJsonObject(await read(authPath, "utf8"));
    const providers = readPiAuthProviderMap(auth);
    if (providers[PI_OPENAI_CODEX_PROVIDER] !== undefined) {
      return {
        candidates: piOpenAiCodexCandidates("authenticated"),
        status: { provider: "Pi", status: "detected", detail: "OpenAI-Codex credentials found" },
      };
    }
    return {
      candidates: piOpenAiCodexCandidates("setup-required"),
      status: { provider: "Pi", status: "setup_available", detail: "OpenAI-Codex credentials not found; auth setup available" },
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        candidates: piOpenAiCodexCandidates("setup-required"),
        status: { provider: "Pi", status: "setup_available", detail: "auth store not found; OpenAI-Codex auth setup available" },
      };
    }
    return { candidates: [], status: { provider: "Pi", status: "unavailable", detail: "auth store unreadable" } };
  }
}

function readPiAuthProviderMap(auth: Record<string, unknown>): Record<string, unknown> {
  const nestedProviders = auth.providers === undefined ? {} : parseJsonObject(auth.providers);
  return { ...nestedProviders, ...auth };
}

async function discoverOpenCodeModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = opts.execFile ?? execFile;
  let isolation: Awaited<ReturnType<typeof createOpenCodeDiscoveryIsolation>> | undefined;
  try {
    isolation = await createOpenCodeDiscoveryIsolation();
    const { stdout } = await run("opencode", ["models", "opencode-go", "--pure"], {
      timeout: opts.timeoutMs,
      env: isolation.env,
    });
    const models = parseOpenCodeGoModels(stdout);
    return {
      candidates: models.map((model) => {
        const value = `pi:opencode-go:${model}`;
        const defaultEffort = defaultEffortForModelRef(value);
        return {
          value,
          label: `OpenCode ${displayModelName(model)}`,
          hint: "discovered from opencode",
          source: "opencode",
          discovered: true,
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        };
      }),
      status: models.length > 0
        ? { provider: "OpenCode", status: "detected", detail: `${models.length} model(s) found` }
        : { provider: "OpenCode", status: "unavailable", detail: "no models returned" },
    };
  } catch {
    return { candidates: [], status: { provider: "OpenCode", status: "unavailable", detail: "`opencode models opencode-go --pure` unavailable" } };
  } finally {
    await isolation?.cleanup();
  }
}

async function createOpenCodeDiscoveryIsolation(): Promise<{
  readonly env: Record<string, string | undefined>;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-opencode-discovery-"));
  try {
    await chmod(root, 0o700);
    const home = await createPrivateDirectory(root, "home");
    const config = await createPrivateDirectory(root, "config");
    const opencodeConfig = await createPrivateDirectory(config, "opencode");
    if (process.platform !== "win32") await chmod(opencodeConfig, 0o500);
    const data = await createPrivateDirectory(root, "data");
    const state = await createPrivateDirectory(root, "state");
    const cache = await createPrivateDirectory(root, "cache");
    const opencodeData = await createPrivateDirectory(data, "opencode");
    const database = join(opencodeData, "opencode.db");
    const handle = await open(database, "wx", 0o600);
    await handle.close();
    await chmod(database, 0o600);
    const env = safeDiscoveryProcessEnv();
    Object.assign(env, {
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CONFIG_DIRS: config,
      XDG_DATA_HOME: data,
      XDG_DATA_DIRS: data,
      XDG_STATE_HOME: state,
      XDG_CACHE_HOME: cache,
      OPENCODE_DB: database,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled", autoshare: false }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_SHARE: "true",
      OPENCODE_AUTO_SHARE: "false",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    });
    return {
      env,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function safeDiscoveryProcessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

async function createPrivateDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function discoverOllamaModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = opts.execFile ?? execFile;
  try {
    const { stdout } = await run("ollama", ["list"], { timeout: opts.timeoutMs });
    const models = parseOllamaList(stdout);
    return {
      candidates: models.map((model) => {
        const value = `pi:ollama:${model}`;
        return {
          value,
          label: `Ollama ${model}`,
          hint: "discovered locally",
          source: "ollama",
          discovered: true,
          defaultEffort: defaultEffortForModelRef(value) ?? "none",
        };
      }),
      status: models.length > 0
        ? { provider: "Ollama", status: "detected", detail: `${models.length} model(s) found` }
        : { provider: "Ollama", status: "unavailable", detail: "no local models returned" },
    };
  } catch {
    return { candidates: [], status: { provider: "Ollama", status: "unavailable", detail: "`ollama list` unavailable" } };
  }
}

async function discoverLmStudioModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const fetchImpl = opts.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await fetchImpl("http://localhost:1234/v1/models", { signal: controller.signal });
    if (!response.ok) {
      return { candidates: [], status: { provider: "LM Studio", status: "unavailable", detail: "server did not return models" } };
    }
    const body: unknown = await response.json();
    const models = parseOpenAiModelEntriesBody(body);
    return {
      candidates: models.map((model) => {
        const value = `pi:lmstudio:${model.id}`;
        return {
          value,
          label: `LM Studio ${model.id}`,
          hint: "discovered locally",
          source: "lmstudio",
          discovered: true,
          defaultEffort: defaultEffortForModelRef(value, model.reasoning) ?? "none",
        };
      }),
      status: models.length > 0
        ? { provider: "LM Studio", status: "detected", detail: `${models.length} model(s) found` }
        : { provider: "LM Studio", status: "unavailable", detail: "no models returned" },
    };
  } catch {
    return { candidates: [], status: { provider: "LM Studio", status: "unavailable", detail: "local server unavailable" } };
  } finally {
    clearTimeout(timer);
  }
}

function mergeCandidate(left: WizardModelCandidate, right: WizardModelCandidate): WizardModelCandidate {
  const { setupRequired: leftSetupRequired, defaultEffort: leftDefaultEffort, ...leftRest } = left;
  const { setupRequired: rightSetupRequired, defaultEffort: rightDefaultEffort, ...rightRest } = right;
  const rightHasDiscoveryState = right.discovered === true || right.setupRequired === true;
  const hint = rightHasDiscoveryState ? right.hint ?? left.hint : left.hint ?? right.hint;
  const discovered = left.discovered === true || right.discovered === true;
  const defaultEffort = rightDefaultEffort ?? leftDefaultEffort;
  return {
    ...leftRest,
    ...rightRest,
    ...(hint === undefined ? {} : { hint }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    discovered,
    ...(discovered || !(leftSetupRequired === true || rightSetupRequired === true) ? {} : { setupRequired: true }),
  };
}

function rank(candidate: WizardModelCandidate): number {
  const directCodexRank = OPENAI_CODEX_MODELS.findIndex((model) => candidate.value === directCodexRef(model));
  if (directCodexRank >= 0) return directCodexRank;
  const piOpenAiCodexRank = OPENAI_CODEX_MODELS.findIndex((model) => candidate.value === piOpenAiCodexRef(model));
  if (piOpenAiCodexRank >= 0) return 10 + piOpenAiCodexRank;
  if (candidate.value === "claude:claude-sonnet-4-6") {
    return 20;
  }
  if (candidate.source === "opencode") {
    return 30;
  }
  if (candidate.source === "ollama") {
    return candidate.discovered === true ? 40 : 45;
  }
  if (candidate.source === "lmstudio") {
    return 50;
  }
  return 90;
}

function directCodexRef(model: CuratedOpenAiCodexModel): string {
  return `codex:${model.id}`;
}

function piOpenAiCodexRef(model: CuratedOpenAiCodexModel): string {
  return `pi:${PI_OPENAI_CODEX_PROVIDER}:${model.id}`;
}

function staticDirectCodexCandidate(model: CuratedOpenAiCodexModel): WizardModelCandidate {
  return {
    value: directCodexRef(model),
    label: `Codex ${model.name}`,
    ...(model.minimumCodexCliVersion === undefined
      ? {}
      : { hint: `requires Codex CLI ${formatVersion(model.minimumCodexCliVersion)}+` }),
    source: "codex",
    defaultEffort: "medium",
  };
}

function staticPiOpenAiCodexCandidate(model: CuratedOpenAiCodexModel): WizardModelCandidate {
  return {
    value: piOpenAiCodexRef(model),
    label: `Pi OpenAI-Codex ${model.name}`,
    hint: "auth setup available",
    source: "pi",
    setupRequired: true,
    defaultEffort: "medium",
  };
}

function piOpenAiCodexCandidates(state: "authenticated" | "setup-required"): WizardModelCandidate[] {
  return OPENAI_CODEX_MODELS.map((model) => ({
    value: piOpenAiCodexRef(model),
    label: `Pi OpenAI-Codex ${model.name}`,
    hint: state === "authenticated" ? "Pi auth configured" : "auth setup available",
    source: "pi",
    defaultEffort: "medium",
    ...(state === "authenticated" ? { discovered: true } : { setupRequired: true }),
  }));
}

function directCodexCandidates(
  state: "ready" | "install-required" | "login-required",
  version = "",
): WizardModelCandidate[] {
  return OPENAI_CODEX_MODELS.map((model) => directCodexCandidate(model, state, version));
}

function directCodexCandidate(
  model: CuratedOpenAiCodexModel,
  state: "ready" | "install-required" | "login-required",
  version = "",
): WizardModelCandidate {
  if (state === "install-required") {
    const minimum = model.minimumCodexCliVersion;
    return {
      value: directCodexRef(model),
      label: `Codex ${model.name}`,
      hint: minimum === undefined
        ? "install Codex CLI and sign in"
        : `install Codex CLI ${formatVersion(minimum)}+ and sign in`,
      source: "codex",
      setupRequired: true,
      defaultEffort: "medium",
    };
  }

  const prerequisites: string[] = [];
  const minimum = model.minimumCodexCliVersion;
  if (minimum !== undefined && !codexVersionMeetsMinimum(version, minimum)) {
    prerequisites.push(
      parseCodexVersion(version) === undefined
        ? `Codex CLI ${formatVersion(minimum)}+ required; installed version could not be verified`
        : `update Codex CLI to ${formatVersion(minimum)}+ (found ${version})`,
    );
  }
  if (state === "login-required") prerequisites.push("Codex sign-in required");

  if (prerequisites.length === 0) {
    return {
      value: directCodexRef(model),
      label: `Codex ${model.name}`,
      hint: `${version.length > 0 ? `${version}; ` : ""}signed in`,
      source: "codex",
      discovered: true,
      defaultEffort: "medium",
    };
  }

  return {
    value: directCodexRef(model),
    label: `Codex ${model.name}`,
    hint: prerequisites.join("; "),
    source: "codex",
    setupRequired: true,
    defaultEffort: "medium",
  };
}

function parseCodexVersion(version: string): readonly [major: number, minor: number, patch: number] | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/u.exec(version);
  if (match === null) return undefined;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return undefined;
  return [parts[0] as number, parts[1] as number, parts[2] as number];
}

function codexVersionMeetsMinimum(
  version: string,
  minimum: readonly [major: number, minor: number, patch: number],
): boolean {
  const parsed = parseCodexVersion(version);
  if (parsed === undefined) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const installedPart = parsed[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (installedPart !== minimumPart) return installedPart > minimumPart;
  }
  return true;
}

function formatVersion(version: readonly [major: number, minor: number, patch: number]): string {
  return version.join(".");
}

function parseOllamaList(stdout: string): string[] {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }
  return lines
    .slice(lines[0]?.toLowerCase().startsWith("name") ? 1 : 0)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((name): name is string => name !== undefined && name.length > 0);
}

function parseOpenCodeGoModels(stdout: string): string[] {
  const prefix = "opencode-go/";
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix) && line.length > prefix.length)
    .map((line) => line.slice(prefix.length));
}

function parseOpenAiModelEntriesBody(body: unknown): DiscoveredModelEntry[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return [];
  }
  return body.data.map(modelEntryFromUnknown).filter(isModelEntry);
}

function modelEntryFromUnknown(value: unknown): DiscoveredModelEntry | undefined {
  if (typeof value === "string") {
    return { id: value };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value.id ?? value.name ?? value.model;
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  const reasoning = readReasoningCapability(value);
  return {
    id: raw,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function displayModelName(model: string): string {
  return model.startsWith("pi:") ? model.split(":").slice(2).join(":") : model;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isRecord(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}

function firstOutputLine(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 120) ?? "";
}

function readReasoningCapability(value: Record<string, unknown>): boolean | undefined {
  for (const field of ["reasoning", "supportsReasoning", "supports_reasoning", "thinking", "supportsThinking", "supports_thinking"]) {
    const result = booleanCapability(value[field]);
    if (result !== undefined) {
      return result;
    }
  }
  for (const field of ["capabilities", "features"]) {
    const nested = value[field];
    const result = Array.isArray(nested) ? arrayCapability(nested) : isRecord(nested) ? readReasoningCapability(nested) : undefined;
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

function booleanCapability(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayCapability(value: readonly unknown[]): boolean | undefined {
  return value.some((entry) => typeof entry === "string" && /^(reasoning|thinking)$/iu.test(entry)) ? true : undefined;
}

function localModelDefaultEffort(model: string): EffortLevel {
  const normalized = model.toLowerCase();
  return ["gpt-oss", "qwen3", "qwq", "deepseek-r1", "reasoning", "thinking"].some((token) => normalized.includes(token))
    || /(?:^|[-_:/.\s])o[1345](?:$|[-_:/.\s])/u.test(normalized)
    ? "medium"
    : "none";
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelEntry(value: DiscoveredModelEntry | undefined): value is DiscoveredModelEntry {
  return value !== undefined;
}
