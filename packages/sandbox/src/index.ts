import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SandboxMode = "native" | "off";
export type SandboxEngineId = "srt" | string;
export type SandboxFallback = "fail-closed" | "unsafe-host-process";
export type SandboxNetworkMode = "none" | "localhost" | "allowlist" | "all";

export interface SandboxNetworkPolicyInput {
  readonly mode?: SandboxNetworkMode;
  readonly allowlist?: readonly string[];
}

export interface SandboxPolicyInput {
  readonly mode?: SandboxMode;
  readonly engine?: SandboxEngineId;
  readonly root?: string;
  readonly readableRoots?: readonly string[];
  readonly writableRoots?: readonly string[];
  readonly tempRoot?: string;
  readonly network?: SandboxNetworkPolicyInput;
  readonly fallback?: SandboxFallback;
  readonly unsafeAllowHostProcess?: boolean;
}

export interface SandboxNetworkPolicy {
  readonly mode: SandboxNetworkMode;
  readonly allowlist: readonly string[];
}

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  readonly engine: SandboxEngineId;
  readonly root: string;
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly tempRoot: string;
  readonly network: SandboxNetworkPolicy;
  readonly fallback: SandboxFallback;
  readonly unsafeAllowHostProcess: boolean;
  readonly required: boolean;
}

export type SandboxErrorCode =
  | "invalid_sandbox_policy"
  | "sandbox_unavailable";

export class SandboxPolicyError extends Error {
  readonly code: SandboxErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SandboxErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SandboxPolicyError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export class SandboxUnavailableError extends SandboxPolicyError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("sandbox_unavailable", message, details);
    this.name = "SandboxUnavailableError";
  }
}

export interface SandboxCommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface PreparedSandboxCommand extends SandboxCommandSpec {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sandboxed: boolean;
  readonly sandboxSettingsPath?: string;
  readonly cleanup?: () => Promise<void>;
}

export interface SandboxEngine {
  readonly id: SandboxEngineId;
  isAvailable(): Promise<boolean>;
  prepareCommand(command: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand>;
}

export interface PrepareSandboxedCommandInput {
  readonly policy?: SandboxPolicy;
  readonly command: SandboxCommandSpec;
  readonly engine?: SandboxEngine;
}

export interface SandboxPolicyRuntimeOptions {
  readonly sandboxPolicy: SandboxPolicy;
}

export interface SrtNetworkSettings {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly allowLocalBinding: boolean;
  readonly allowAllUnixSockets: boolean;
}

export interface SrtFilesystemSettings {
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

export interface SrtSettings {
  readonly network: SrtNetworkSettings;
  readonly filesystem: SrtFilesystemSettings;
}

export interface SrtSandboxEngineOptions {
  readonly command?: string;
}

export function createSandboxPolicy(input: SandboxPolicyInput = {}): SandboxPolicy {
  const mode = input.mode ?? "native";
  const root = normalizePath(input.root ?? process.cwd(), "root");
  const fallback = input.fallback ?? "fail-closed";
  const unsafeAllowHostProcess = input.unsafeAllowHostProcess === true;
  if (fallback === "unsafe-host-process" && !unsafeAllowHostProcess) {
    throw new SandboxPolicyError(
      "invalid_sandbox_policy",
      "unsafe-host-process fallback requires unsafeAllowHostProcess: true.",
      { field: "unsafeAllowHostProcess" },
    );
  }

  const readableRoots = normalizePathList(input.readableRoots ?? [root], root, "readableRoots");
  const writableRoots = normalizePathList(input.writableRoots ?? [root], root, "writableRoots");
  const tempRoot = normalizePath(input.tempRoot ?? resolve(root, ".mono-agent", "tmp"), "tempRoot");
  const network = normalizeNetworkPolicy(input.network);

  return {
    mode,
    engine: normalizeNonEmptyString(input.engine ?? "srt", "engine"),
    root,
    readableRoots,
    writableRoots,
    tempRoot,
    network,
    fallback,
    unsafeAllowHostProcess,
    required: mode !== "off" && fallback === "fail-closed",
  };
}

export function failClosedSandboxPolicy(input: Omit<SandboxPolicyInput, "mode" | "fallback" | "unsafeAllowHostProcess"> = {}): SandboxPolicy {
  return createSandboxPolicy({
    ...input,
    mode: "native",
    fallback: "fail-closed",
    unsafeAllowHostProcess: false,
    network: input.network ?? { mode: "none" },
  });
}

export function sandboxPolicyToRuntimeOptions(policy: SandboxPolicy): SandboxPolicyRuntimeOptions {
  return { sandboxPolicy: policy };
}

export function mergeSandboxPolicies(
  configured: SandboxPolicy | undefined,
  request: SandboxPolicy | undefined,
): SandboxPolicy | undefined {
  if (configured === undefined) {
    return request;
  }
  if (request === undefined || configured.mode === "native") {
    return {
      ...configured,
      network: mergeNetworkPolicies(configured.network, request?.network),
      required: configured.mode !== "off" && configured.fallback === "fail-closed",
    };
  }
  return request.mode === "native" ? request : configured;
}

export function createSrtSandboxEngine(options: SrtSandboxEngineOptions = {}): SandboxEngine {
  const command = options.command ?? "srt";
  return {
    id: "srt",
    async isAvailable(): Promise<boolean> {
      try {
        await execFileAsync(command, ["--version"], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },
    async prepareCommand(spec: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand> {
      const cwd = resolve(spec.cwd ?? policy.root);
      await mkdir(policy.tempRoot, { recursive: true });
      const settingsDir = await mkdtemp(resolve(policy.tempRoot, "srt-"));
      const settingsPath = resolve(settingsDir, "settings.json");
      await writeFile(settingsPath, `${JSON.stringify(srtSettingsForPolicy(policy), null, 2)}\n`, "utf8");
      return {
        ...spec,
        command,
        args: ["--settings", settingsPath, spec.command, ...(spec.args ?? [])],
        cwd,
        sandboxed: true,
        sandboxSettingsPath: settingsPath,
        cleanup: async () => {
          await rm(settingsDir, { recursive: true, force: true });
        },
      };
    },
  };
}

export async function prepareSandboxedCommand(input: PrepareSandboxedCommandInput): Promise<PreparedSandboxCommand> {
  const policy = input.policy;
  const command = normalizeCommandSpec(input.command, policy?.root);
  if (policy == null || policy.mode === "off") {
    return { ...command, sandboxed: false };
  }

  const engine = input.engine ?? createSrtSandboxEngine();
  const available = await engine.isAvailable();
  if (!available) {
    if (policy.fallback === "unsafe-host-process" && policy.unsafeAllowHostProcess) {
      return { ...command, sandboxed: false };
    }
    throw new SandboxUnavailableError("Sandbox engine is unavailable and policy is fail-closed.", {
      engine: engine.id,
      command: command.command,
    });
  }
  return engine.prepareCommand(command, policy);
}

export function srtSettingsForPolicy(policy: SandboxPolicy): SrtSettings {
  return {
    network: {
      allowedDomains: domainsForNetworkPolicy(policy.network),
      deniedDomains: [],
      allowLocalBinding: policy.network.mode === "localhost",
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead: denyReadRootsForPolicy(policy),
      allowRead: [...policy.readableRoots],
      allowWrite: [...policy.writableRoots],
      denyWrite: [".env", ".env.*", ".git/config", ".git/hooks/**"],
    },
  };
}

export function networkPolicyAllowsUrl(policy: SandboxPolicy | undefined, url: string): boolean {
  if (policy == null || policy.mode === "off") {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (policy.network.mode === "all") {
    return true;
  }
  if (policy.network.mode === "none") {
    return false;
  }
  if (policy.network.mode === "localhost") {
    return isLocalhost(host);
  }
  return policy.network.allowlist.some((domain) => domainMatches(host, domain));
}

function normalizeCommandSpec(spec: SandboxCommandSpec, fallbackCwd: string | undefined): PreparedSandboxCommand {
  const command = normalizeNonEmptyString(spec.command, "command");
  const cwd = resolve(spec.cwd ?? fallbackCwd ?? process.cwd());
  return {
    command,
    args: normalizeStringList(spec.args ?? [], "args"),
    cwd,
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    sandboxed: false,
  };
}

function normalizeNetworkPolicy(input: SandboxNetworkPolicyInput | undefined): SandboxNetworkPolicy {
  const mode = input?.mode ?? "none";
  if (!["none", "localhost", "allowlist", "all"].includes(mode)) {
    throw new SandboxPolicyError("invalid_sandbox_policy", "Invalid sandbox network mode.", { mode });
  }
  const allowlist = normalizeStringList(input?.allowlist ?? [], "network.allowlist")
    .map((domain) => domain.toLowerCase());
  if (mode === "allowlist" && allowlist.length === 0) {
    throw new SandboxPolicyError("invalid_sandbox_policy", "allowlist network mode requires at least one domain.", {
      field: "network.allowlist",
    });
  }
  return {
    mode,
    allowlist: mode === "allowlist" ? allowlist : [],
  };
}

function mergeNetworkPolicies(
  configured: SandboxNetworkPolicy,
  request: SandboxNetworkPolicy | undefined,
): SandboxNetworkPolicy {
  if (request === undefined) {
    return configured;
  }
  const rank: Record<SandboxNetworkMode, number> = {
    none: 0,
    localhost: 1,
    allowlist: 2,
    all: 3,
  };
  const mode = rank[configured.mode] <= rank[request.mode] ? configured.mode : request.mode;
  if (mode !== "allowlist") {
    return { mode, allowlist: [] };
  }
  const configuredDomains = new Set(configured.allowlist);
  const requestDomains = new Set(request.allowlist);
  const allowlist = [...configuredDomains].filter((domain) => requestDomains.has(domain)).sort();
  return { mode, allowlist };
}

function domainsForNetworkPolicy(policy: SandboxNetworkPolicy): readonly string[] {
  if (policy.mode === "all") {
    return ["*"];
  }
  if (policy.mode === "localhost") {
    return ["localhost", "127.0.0.1", "::1"];
  }
  if (policy.mode === "allowlist") {
    return [...policy.allowlist];
  }
  return [];
}

function denyReadRootsForPolicy(policy: SandboxPolicy): readonly string[] {
  const roots = new Set<string>();
  for (const readableRoot of policy.readableRoots) {
    const home = homedir();
    if (readableRoot === home || readableRoot.startsWith(`${home}/`)) {
      roots.add(dirname(home));
    }
    if (readableRoot.startsWith("/Users/")) {
      roots.add("/Users");
    }
    if (readableRoot.startsWith("/home/")) {
      roots.add("/home");
    }
  }
  roots.add(resolve(homedir(), ".ssh"));
  return removeCoveredRoots([...roots].sort());
}

function normalizePath(value: string, field: string): string {
  return resolve(normalizeNonEmptyString(value, field));
}

function normalizePathList(values: readonly string[], root: string, field: string): readonly string[] {
  const paths = normalizeStringList(values, field).map((value) => resolve(root, value));
  return [...new Set(paths)];
}

function normalizeStringList(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values)) {
    throw new SandboxPolicyError("invalid_sandbox_policy", `${field} must be an array.`, { field });
  }
  return values.map((value, index) => normalizeNonEmptyString(value, `${field}[${index}]`));
}

function normalizeNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SandboxPolicyError("invalid_sandbox_policy", `${field} must be a string.`, { field });
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new SandboxPolicyError("invalid_sandbox_policy", `${field} must not be empty.`, { field });
  }
  return normalized;
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

function domainMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function removeCoveredRoots(paths: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (out.some((root) => path === root || path.startsWith(`${root}/`))) {
      continue;
    }
    out.push(path);
  }
  return out;
}
