import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type WizardModelSource = "claude" | "pi" | "codex" | "opencode" | "ollama" | "lmstudio" | "custom";

export interface WizardModelCandidate {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly source: WizardModelSource;
  readonly discovered?: boolean;
}

export interface ModelDiscoveryStatus {
  readonly provider: "Pi" | "OpenCode" | "Ollama" | "LM Studio";
  readonly status: "detected" | "unavailable";
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
  readonly execFile?: (file: string, args: readonly string[], opts: { readonly timeout: number }) => Promise<ExecResult>;
  readonly fetch?: typeof fetch;
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly piAuthPath?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1200;
const PI_OPENAI_CODEX = "pi:openai-codex:gpt-5.5";
const DIRECT_CODEX = "codex:gpt-5.5";

export const STATIC_MODEL_CANDIDATES: readonly WizardModelCandidate[] = [
  { value: "claude:claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "default", source: "claude" },
  { value: DIRECT_CODEX, label: "Codex GPT-5.5", source: "codex" },
  { value: "pi:ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local", source: "ollama" },
];

export async function discoverWizardModelCandidates(
  opts: DiscoverWizardModelsOptions = {},
): Promise<ModelDiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const [pi, opencode, ollama, lmstudio] = await Promise.all([
    discoverPiOpenAiCodex({ ...opts, timeoutMs }),
    discoverOpenCodeModels({ ...opts, timeoutMs }),
    discoverOllamaModels({ ...opts, timeoutMs }),
    discoverLmStudioModels({ ...opts, timeoutMs }),
  ]);

  return {
    candidates: rankWizardModelCandidates([
      ...STATIC_MODEL_CANDIDATES,
      ...pi.candidates,
      ...opencode.candidates,
      ...ollama.candidates,
      ...lmstudio.candidates,
    ]),
    statuses: [pi.status, opencode.status, ollama.status, lmstudio.status],
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

async function discoverPiOpenAiCodex(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const read = opts.readFile ?? readFile;
  const authPath = opts.piAuthPath ?? join(homedir(), ".pi", "agent", "auth.json");
  try {
    const auth = parseJsonObject(await read(authPath, "utf8"));
    const providers = parseJsonObject(auth.providers);
    if (providers["openai-codex"] !== undefined) {
      return {
        candidates: [
          {
            value: PI_OPENAI_CODEX,
            label: "Pi OpenAI-Codex GPT-5.5",
            hint: "recommended when Pi auth is configured",
            source: "pi",
            discovered: true,
          },
        ],
        status: { provider: "Pi", status: "detected", detail: "OpenAI-Codex credentials found" },
      };
    }
    return { candidates: [], status: { provider: "Pi", status: "unavailable", detail: "OpenAI-Codex credentials not found" } };
  } catch {
    return { candidates: [], status: { provider: "Pi", status: "unavailable", detail: "auth store not found" } };
  }
}

async function discoverOpenCodeModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = opts.execFile ?? execFile;
  try {
    const { stdout } = await run("opencode", ["models", "--json"], { timeout: opts.timeoutMs });
    const models = parseModelNames(stdout);
    return {
      candidates: models.map((model) => ({
        value: model.startsWith("pi:") ? model : `pi:opencode-go:${model}`,
        label: `OpenCode ${displayModelName(model)}`,
        hint: "discovered from opencode",
        source: "opencode",
        discovered: true,
      })),
      status: models.length > 0
        ? { provider: "OpenCode", status: "detected", detail: `${models.length} model(s) found` }
        : { provider: "OpenCode", status: "unavailable", detail: "no models returned" },
    };
  } catch {
    return { candidates: [], status: { provider: "OpenCode", status: "unavailable", detail: "`opencode models --json` unavailable" } };
  }
}

async function discoverOllamaModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = opts.execFile ?? execFile;
  try {
    const { stdout } = await run("ollama", ["list"], { timeout: opts.timeoutMs });
    const models = parseOllamaList(stdout);
    return {
      candidates: models.map((model) => ({
        value: `pi:ollama:${model}`,
        label: `Ollama ${model}`,
        hint: "discovered locally",
        source: "ollama",
        discovered: true,
      })),
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
    const models = parseOpenAiModelsBody(body);
    return {
      candidates: models.map((model) => ({
        value: `pi:lmstudio:${model}`,
        label: `LM Studio ${model}`,
        hint: "discovered locally",
        source: "lmstudio",
        discovered: true,
      })),
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
  const hint = right.discovered === true ? right.hint ?? left.hint : left.hint ?? right.hint;
  return {
    ...left,
    ...right,
    ...(hint === undefined ? {} : { hint }),
    discovered: left.discovered === true || right.discovered === true,
  };
}

function rank(candidate: WizardModelCandidate): number {
  if (candidate.value === "claude:claude-sonnet-4-6") {
    return 0;
  }
  if (candidate.value === PI_OPENAI_CODEX) {
    return 10;
  }
  if (candidate.value === DIRECT_CODEX) {
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

function parseModelNames(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      return parsed.map(modelNameFromUnknown).filter(isNonEmptyString);
    }
    if (isRecord(parsed)) {
      for (const key of ["models", "data"]) {
        const value = parsed[key];
        if (Array.isArray(value)) {
          return value.map(modelNameFromUnknown).filter(isNonEmptyString);
        }
      }
    }
  } catch {
    // Fall through to tolerant line parsing.
  }
  return stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)[0]).filter(isNonEmptyString);
}

function parseOpenAiModelsBody(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return [];
  }
  return body.data.map(modelNameFromUnknown).filter(isNonEmptyString);
}

function modelNameFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value.id ?? value.name ?? value.model;
  return typeof raw === "string" ? raw : undefined;
}

function displayModelName(model: string): string {
  return model.startsWith("pi:") ? model.split(":").slice(2).join(":") : model;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
