import { homedir } from "node:os";
import { join } from "node:path";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { EFFORT_LEVELS, type EffortLevel } from "@mono-agent/config";
import {
  inspectPiAuthStore as inspectDefaultPiAuthStore,
  type PiAuthStoreInspection,
} from "../pi-auth-store-inspection.js";
import { runBoundedProviderCommand } from "../provider-setup.js";

export type WizardModelSource = "pi" | "ollama" | "lmstudio" | "custom";
export type WizardModelAvailability = "catalog_available";
export type WizardModelAuthState = "auth_required" | "credential_detected" | "verified" | "not_required";

/** Cloud Pi providers that guided onboarding can authenticate and prove end to end. */
export const GUIDED_PI_PROVIDER_IDS = [
  "anthropic",
  "github-copilot",
  "openai-codex",
  "opencode-go",
] as const;

const GUIDED_PI_PROVIDERS = new Set<string>(GUIDED_PI_PROVIDER_IDS);
const GUIDED_LOCAL_PI_PROVIDERS = new Set(["ollama", "lmstudio"]);
const PI_API_KEY_ENV_BY_PROVIDER: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
};

/** Whether a selected Pi route has an API key in the destination agent environment. */
export function hasDurablePiEnvironmentCredential(
  rawModelRef: string,
  persistedEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  const separator = rawModelRef.indexOf(":");
  if (separator <= 0) return false;
  const provider = rawModelRef.slice(0, separator);
  const apiKeyEnv = PI_API_KEY_ENV_BY_PROVIDER[provider];
  return apiKeyEnv !== undefined && (persistedEnv[apiKeyEnv]?.trim().length ?? 0) > 0;
}

/** Reject known unsupported remote Pi integrations while leaving custom local ids available. */
export function guidedPiProviderProblem(provider: string): string | undefined {
  if (GUIDED_PI_PROVIDERS.has(provider) || GUIDED_LOCAL_PI_PROVIDERS.has(provider)) {
    return undefined;
  }
  return builtinModels().getProvider(provider) === undefined
    ? "Custom Pi providers require a hand-authored providers.local[] entry. Guided init supports discovered Ollama and LM Studio routes."
    : "Guided init supports Pi Anthropic, GitHub Copilot, OpenAI Codex, OpenCode-Go, Ollama, and LM Studio. Configure other Pi providers manually.";
}

export interface WizardModelCandidate {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly source: WizardModelSource;
  readonly discovered?: boolean;
  readonly setupRequired?: boolean;
  readonly availability?: WizardModelAvailability;
  readonly authState?: WizardModelAuthState;
  readonly supportedEfforts?: readonly EffortLevel[];
  readonly defaultEffort?: EffortLevel;
  /** Provider-declared default model; curated offline Codex fallback uses Terra. */
  readonly providerDefault?: boolean;
}

export interface ModelDiscoveryStatus {
  readonly provider: "Pi" | "Ollama" | "LM Studio";
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

type DiscoveryCommandRunner = NonNullable<DiscoverWizardModelsOptions["execFile"]>;

export interface DiscoverWizardModelsOptions {
  readonly execFile?: (file: string, args: readonly string[], opts: {
    readonly timeout: number;
    readonly env?: Record<string, string | undefined>;
    readonly abortSignal?: AbortSignal;
  }) => Promise<ExecResult>;
  readonly fetch?: typeof fetch;
  /** Deterministic inspection seam for tests; production uses the hardened filesystem inspector. */
  readonly inspectPiAuthStore?: (path: string) => Promise<PiAuthStoreInspection>;
  readonly piAuthPath?: string;
  /** Values parsed from the destination `.env`; ambient shell credentials are intentionally excluded. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly verifiedModelRefs?: readonly string[];
}

function providerDiscoveryCommand(opts: DiscoverWizardModelsOptions): DiscoveryCommandRunner {
  if (opts.execFile !== undefined) {
    return (file, args, commandOptions) => opts.execFile!(file, args, {
      ...commandOptions,
      env: commandOptions.env ?? safeDiscoveryProcessEnv(),
      ...(opts.abortSignal === undefined ? {} : { abortSignal: opts.abortSignal }),
    });
  }
  return (file, args, commandOptions) => runBoundedProviderCommand(file, args, {
    ...commandOptions,
    cwd: process.cwd(),
    env: commandOptions.env ?? safeDiscoveryProcessEnv(),
    ...(opts.abortSignal === undefined ? {} : { abortSignal: opts.abortSignal }),
  });
}

interface DiscoveredModelEntry {
  readonly id: string;
  readonly reasoning?: boolean;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1200;
const KNOWN_EFFORTS = new Set<string>(EFFORT_LEVELS);

function normalizeEfforts(values: readonly unknown[]): EffortLevel[] {
  return [...new Set(values
    .map((value) => value === "off" ? "none" : value)
    .filter((value): value is EffortLevel => typeof value === "string" && KNOWN_EFFORTS.has(value)))];
}

export const STATIC_MODEL_CANDIDATES: readonly WizardModelCandidate[] = [
  {
    value: "openai-codex:gpt-5.6-terra",
    label: "Pi OpenAI Codex · GPT-5.6 Terra",
    hint: "OAuth setup available",
    source: "pi",
    availability: "catalog_available",
    authState: "auth_required",
    setupRequired: true,
    supportedEfforts: [],
    providerDefault: true,
  },
  {
    value: "openai-codex:gpt-5.6-sol",
    label: "Pi OpenAI Codex · GPT-5.6 Sol",
    hint: "OAuth setup available",
    source: "pi",
    availability: "catalog_available",
    authState: "auth_required",
    setupRequired: true,
    supportedEfforts: [],
  },
];

export async function discoverWizardModelCandidates(
  opts: DiscoverWizardModelsOptions = {},
): Promise<ModelDiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const [pi, ollama, lmstudio] = await Promise.all([
    discoverPiModels({ ...opts, timeoutMs }),
    discoverOllamaModels({ ...opts, timeoutMs }),
    discoverLmStudioModels({ ...opts, timeoutMs }),
  ]);

  return {
    candidates: rankWizardModelCandidates([
      ...pi.candidates,
      ...ollama.candidates,
      ...lmstudio.candidates,
    ]),
    statuses: [pi.status, ollama.status, lmstudio.status],
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

  const separator = modelRef.indexOf(":");
  if (separator <= 0 || separator === modelRef.length - 1) return undefined;
  const provider = modelRef.slice(0, separator);
  const model = modelRef.slice(separator + 1);
  if (provider === "opencode-go" || provider === "ollama" || provider === "lmstudio") {
    return localModelDefaultEffort(model);
  }

  return undefined;
}

async function discoverPiModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const inspectAuthStore = opts.inspectPiAuthStore ?? inspectDefaultPiAuthStore;
  const authPath = opts.piAuthPath ?? join(homedir(), ".pi", "agent", "auth.json");
  let credentialProviders = new Set<string>();
  let status: ModelDiscoveryStatus;
  try {
    const inspection = await inspectAuthStore(authPath);
    if (inspection.status === "missing") {
      status = { provider: "Pi", status: "setup_available", detail: "auth store not found; provider setup is available" };
    } else if (inspection.status === "unsafe") {
      status = {
        provider: "Pi",
        status: "unavailable",
        detail: `auth store rejected as unsafe (${inspection.reason}); catalog remains available`,
      };
    } else {
      const providers = readPiAuthProviderMap(inspection.auth);
      credentialProviders = new Set(Object.entries(providers)
        .filter(([provider, credential]) => GUIDED_PI_PROVIDERS.has(provider) && hasUsablePiCredential(credential))
        .map(([provider]) => provider));
      status = credentialProviders.size > 0
        ? {
            provider: "Pi",
            status: "detected",
            detail: `${credentialProviders.size} provider credential entr${credentialProviders.size === 1 ? "y" : "ies"} detected (not yet verified)`,
          }
        : { provider: "Pi", status: "setup_available", detail: "credential store is empty; setup is available" };
    }
  } catch {
    status = { provider: "Pi", status: "unavailable", detail: "auth store unreadable; catalog remains available" };
  }

  const preEnvironmentStatus = status;
  for (const provider of GUIDED_PI_PROVIDER_IDS) {
    if (hasDurablePiEnvironmentCredential(`${provider}:credential-check`, opts.persistedEnv ?? {})) {
      credentialProviders.add(provider);
    }
  }
  if (credentialProviders.size > 0 && preEnvironmentStatus.status !== "detected") {
    status = {
      provider: "Pi",
      status: "detected",
      detail: `${credentialProviders.size} provider credential source${credentialProviders.size === 1 ? "" : "s"} detected (not yet verified); ${preEnvironmentStatus.detail}`,
    };
  } else if (
    credentialProviders.size === 0
    && hasDurablePiEnvironmentCredential("opencode-go:credential-check", process.env)
  ) {
    status = {
      provider: "Pi",
      status: "setup_available",
      detail: `${preEnvironmentStatus.detail}; shell-only OPENCODE_API_KEY ignored until persisted in the agent .env or Pi auth store`,
    };
  }

  const verified = new Set(opts.verifiedModelRefs ?? []);
  const models = builtinModels();
  const oauthProviders = new Set(
    models.getProviders()
      .filter((provider) => provider.auth.oauth !== undefined)
      .map((provider) => provider.id),
  );
  const providerNames = new Map(models.getProviders().map((provider) => [provider.id, provider.name]));
  const candidates = models.getModels()
    .filter((model) => GUIDED_PI_PROVIDERS.has(model.provider))
    .map((model): WizardModelCandidate => {
      const value = `${model.provider}:${model.id}`;
      const supportedEfforts = normalizeEfforts(getSupportedThinkingLevels(model));
      const authState: WizardModelAuthState = verified.has(value)
        ? "verified"
        : credentialProviders.has(model.provider)
          ? "credential_detected"
          : "auth_required";
      const defaultEffort = exactDefaultEffortWhenUnambiguous(supportedEfforts);
      const shellOnlyCredential = authState === "auth_required"
        && hasDurablePiEnvironmentCredential(value, process.env);
      const providerLabel = model.provider === "opencode-go"
        ? "OpenCode-Go"
        : providerNames.get(model.provider) ?? model.provider;
      return {
        value,
        label: `Pi ${providerLabel} · ${model.name || model.id}`,
        hint: authState === "verified"
          ? "verified by live readiness"
          : authState === "credential_detected"
            ? "credential detected; live readiness pending"
            : shellOnlyCredential
              ? "shell-only credential ignored; persist it in the agent .env or provider store"
              : oauthProviders.has(model.provider)
                ? "OAuth setup available"
                : "API key or provider environment required",
        source: "pi",
        availability: "catalog_available",
        authState,
        supportedEfforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        ...(authState === "verified" ? { discovered: true } : {}),
        ...(authState === "auth_required" ? { setupRequired: true } : {}),
      };
    });
  return { candidates, status };
}

function readPiAuthProviderMap(auth: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const nestedProviders = auth.providers === undefined ? {} : parseJsonObject(auth.providers);
  const { providers: _providers, ...topLevelProviders } = auth;
  return { ...nestedProviders, ...topLevelProviders };
}

function hasUsablePiCredential(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "oauth") {
    return isCredentialString(value.access) || isCredentialString(value.refresh);
  }
  return value.type === "api_key" && isCredentialString(value.key);
}

function isCredentialString(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 65_536
    && !value.includes("\0");
}

function safeDiscoveryProcessEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
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
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

async function discoverOllamaModels(
  opts: Required<Pick<DiscoverWizardModelsOptions, "timeoutMs">> & DiscoverWizardModelsOptions,
): Promise<{ candidates: WizardModelCandidate[]; status: ModelDiscoveryStatus }> {
  const run = providerDiscoveryCommand(opts);
  try {
    const { stdout } = await run("ollama", ["list"], { timeout: opts.timeoutMs });
    const models = parseOllamaList(stdout);
    return {
      candidates: models.map((model) => {
        const value = `ollama:${model}`;
        return {
          value,
          label: `Ollama ${model}`,
          hint: "discovered locally",
          source: "ollama",
          discovered: true,
          availability: "catalog_available",
          authState: "not_required",
          supportedEfforts: [],
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
  const onAbort = () => controller.abort();
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl("http://localhost:1234/v1/models", { signal: controller.signal });
    if (!response.ok) {
      return { candidates: [], status: { provider: "LM Studio", status: "unavailable", detail: "server did not return models" } };
    }
    const body: unknown = await response.json();
    const models = parseOpenAiModelEntriesBody(body);
    return {
      candidates: models.map((model) => {
        const value = `lmstudio:${model.id}`;
        return {
          value,
          label: `LM Studio ${model.id}`,
          hint: "discovered locally",
          source: "lmstudio",
          discovered: true,
          availability: "catalog_available",
          authState: "not_required",
          supportedEfforts: model.reasoning === false ? ["none"] : [],
          ...(model.reasoning === false ? { defaultEffort: "none" as const } : {}),
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
    opts.abortSignal?.removeEventListener("abort", onAbort);
  }
}

function mergeCandidate(left: WizardModelCandidate, right: WizardModelCandidate): WizardModelCandidate {
  const {
    setupRequired: leftSetupRequired,
    defaultEffort: leftDefaultEffort,
    supportedEfforts: leftSupportedEfforts,
    ...leftRest
  } = left;
  const {
    setupRequired: rightSetupRequired,
    defaultEffort: rightDefaultEffort,
    supportedEfforts: rightSupportedEfforts,
    ...rightRest
  } = right;
  const rightHasDiscoveryState = right.discovered === true
    || right.setupRequired === true
    || right.availability !== undefined
    || right.authState !== undefined;
  const preserveBuiltinPiMetadata = left.source === "pi"
    && (right.source === "ollama" || right.source === "lmstudio");
  const hint = preserveBuiltinPiMetadata
    ? left.hint
    : rightHasDiscoveryState ? right.hint ?? left.hint : left.hint ?? right.hint;
  const discovered = left.discovered === true || right.discovered === true;
  const rightReplacesCatalogMetadata = right.availability === "catalog_available"
    && left.source === right.source;
  const defaultEffort = preserveBuiltinPiMetadata
    ? leftDefaultEffort
    : rightReplacesCatalogMetadata
      ? rightDefaultEffort
      : rightDefaultEffort ?? leftDefaultEffort;
  const authState = preserveBuiltinPiMetadata
    ? left.authState
    : strongerAuthState(left.authState, right.authState);
  const setupRequired = preserveBuiltinPiMetadata
    ? leftSetupRequired === true || authState === "auth_required"
    : rightSetupRequired === true || authState === "auth_required"
      || (right.authState === undefined && !discovered && leftSetupRequired === true);
  return {
    ...leftRest,
    ...rightRest,
    ...(preserveBuiltinPiMetadata ? { source: left.source } : {}),
    ...(authState === undefined ? {} : { authState }),
    supportedEfforts: preserveBuiltinPiMetadata
      ? [...(leftSupportedEfforts ?? [])]
      : [...(rightSupportedEfforts ?? leftSupportedEfforts ?? [])],
    ...(hint === undefined ? {} : { hint }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    discovered,
    ...(setupRequired ? { setupRequired: true } : {}),
  };
}

function rank(candidate: WizardModelCandidate): number {
  const authRank = candidate.authState === "verified"
    ? 0
    : candidate.authState === "credential_detected" || candidate.authState === "not_required"
      ? 1
      : 2;
  return authRank * 1_000 + modelRank(candidate);
}

function modelRank(candidate: WizardModelCandidate): number {
  if (candidate.providerDefault === true) return -100;
  if (candidate.value === "openai-codex:gpt-5.6-terra") return 0;
  if (candidate.value === "openai-codex:gpt-5.6-sol") return 1;
  if (candidate.source === "pi") return 20;
  if (candidate.source === "ollama") {
    return candidate.discovered === true ? 40 : 45;
  }
  if (candidate.source === "lmstudio") {
    return 50;
  }
  return 90;
}

function strongerAuthState(
  left: WizardModelAuthState | undefined,
  right: WizardModelAuthState | undefined,
): WizardModelAuthState {
  const order: Record<WizardModelAuthState, number> = {
    auth_required: 0,
    not_required: 1,
    credential_detected: 2,
    verified: 3,
  };
  if (left === undefined) return right ?? "auth_required";
  if (right === undefined) return left;
  return order[right] > order[left] ? right : left;
}


function exactDefaultEffortWhenUnambiguous(
  supportedEfforts: readonly EffortLevel[],
): EffortLevel | undefined {
  return supportedEfforts.length === 1 ? supportedEfforts[0] : undefined;
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

export function parseOpenCodeGoModels(stdout: string): string[] {
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isRecord(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelEntry(value: DiscoveredModelEntry | undefined): value is DiscoveredModelEntry {
  return value !== undefined;
}
