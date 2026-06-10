import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { CodedError } from "@mono-agent/agent-contracts";

const execFileAsync = promisify(execFile);

export const SANDBOX_MODES = ["native", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const SANDBOX_NETWORK_MODES = ["none", "localhost", "allowlist", "all"] as const;
export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];

export const SANDBOX_FALLBACKS = ["fail-closed", "unsafe-host-process"] as const;
export type SandboxFallback = (typeof SANDBOX_FALLBACKS)[number];

export type SandboxEngineId = string;

export const DEFAULT_DENY_WRITE = [".env", ".env.*", ".git/config", ".git/hooks/**"] as const;

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
  readonly denyWrite?: readonly string[];
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
  readonly denyWrite: readonly string[];
  readonly tempRoot: string;
  readonly network: SandboxNetworkPolicy;
  readonly fallback: SandboxFallback;
  readonly unsafeAllowHostProcess: boolean;
}

export type SandboxErrorCode =
  | "invalid_sandbox_policy"
  | "sandbox_unavailable";

export class SandboxPolicyError extends CodedError<SandboxErrorCode> {}

export class SandboxUnavailableError extends SandboxPolicyError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("sandbox_unavailable", message, details);
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
  const denyWrite = normalizeStringList(input.denyWrite ?? DEFAULT_DENY_WRITE, "denyWrite");
  const tempRoot = normalizePath(input.tempRoot ?? resolve(root, ".mono-agent", "tmp"), "tempRoot");
  const network = normalizeNetworkPolicy(input.network);

  return {
    mode,
    engine: normalizeNonEmptyString(input.engine ?? "srt", "engine"),
    root,
    readableRoots,
    writableRoots,
    denyWrite,
    tempRoot,
    network,
    fallback,
    unsafeAllowHostProcess,
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

export function sandboxRequired(policy: SandboxPolicy): boolean {
  return policy.mode !== "off" && policy.fallback === "fail-closed";
}

export function sandboxPolicyToRuntimeOptions(policy: SandboxPolicy): SandboxPolicyRuntimeOptions {
  return { sandboxPolicy: policy };
}

/**
 * Monotonic merge: the result is never more permissive than `configured`.
 * A request-scoped policy can only tighten roots, network access, and the
 * fallback; it can never re-enable host execution or widen filesystem access.
 */
export function mergeSandboxPolicies(
  configured: SandboxPolicy | undefined,
  request: SandboxPolicy | undefined,
): SandboxPolicy | undefined {
  if (configured === undefined) {
    return request;
  }
  if (request === undefined) {
    return configured;
  }
  if (configured.mode === "off") {
    return request.mode === "native" ? request : configured;
  }
  if (request.mode === "off") {
    return configured;
  }
  return {
    ...configured,
    readableRoots: intersectRoots(configured.readableRoots, request.readableRoots),
    writableRoots: intersectRoots(configured.writableRoots, request.writableRoots),
    denyWrite: [...new Set([...(configured.denyWrite ?? []), ...(request.denyWrite ?? [])])],
    network: mergeNetworkPolicies(configured.network, request.network),
    fallback: configured.fallback === "fail-closed" || request.fallback === "fail-closed"
      ? "fail-closed"
      : configured.fallback,
    unsafeAllowHostProcess: configured.unsafeAllowHostProcess && request.unsafeAllowHostProcess,
  };
}

export function createSrtSandboxEngine(options: SrtSandboxEngineOptions = {}): SandboxEngine {
  const command = options.command ?? "srt";
  // Availability cannot change mid-session in a way we can act on, and the
  // probe spawns a process — resolve it once per engine instance.
  let availability: Promise<boolean> | null = null;
  return {
    id: "srt",
    isAvailable(): Promise<boolean> {
      availability ??= execFileAsync(command, ["--version"], { timeout: 5_000 })
        .then(() => true, () => false);
      return availability;
    },
    async prepareCommand(spec: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand> {
      const cwd = resolve(spec.cwd ?? policy.root);
      const settingsPath = await writeSrtSettingsFile(policy);
      return {
        ...spec,
        command,
        args: ["--settings", settingsPath, spec.command, ...(spec.args ?? [])],
        cwd,
        sandboxed: true,
        sandboxSettingsPath: settingsPath,
      };
    },
  };
}

const defaultEngines = new Map<SandboxEngineId, SandboxEngine>();

function resolveDefaultEngine(policy: SandboxPolicy): SandboxEngine | undefined {
  if (policy.engine !== "srt") {
    return undefined;
  }
  let engine = defaultEngines.get(policy.engine);
  if (engine === undefined) {
    engine = createSrtSandboxEngine();
    defaultEngines.set(policy.engine, engine);
  }
  return engine;
}

export async function prepareSandboxedCommand(input: PrepareSandboxedCommandInput): Promise<PreparedSandboxCommand> {
  const policy = input.policy;
  const command = normalizeCommandSpec(input.command, policy?.root);
  if (policy == null || policy.mode === "off") {
    return { ...command, sandboxed: false };
  }

  const engine = input.engine ?? resolveDefaultEngine(policy);
  if (engine === undefined || !(await engine.isAvailable())) {
    if (policy.fallback === "unsafe-host-process" && policy.unsafeAllowHostProcess) {
      return { ...command, sandboxed: false };
    }
    throw new SandboxUnavailableError(
      engine === undefined
        ? `No sandbox engine is registered for "${policy.engine}" and policy is fail-closed.`
        : "Sandbox engine is unavailable and policy is fail-closed.",
      {
        engine: engine?.id ?? policy.engine,
        command: command.command,
      },
    );
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
      denyWrite: [...(policy.denyWrite ?? DEFAULT_DENY_WRITE)],
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
  // URL.hostname keeps IPv6 hosts bracketed ("[::1]"); match on the bare host.
  const host = stripIpv6Brackets(parsed.hostname.toLowerCase());
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
    args: normalizeArgs(spec.args ?? []),
    cwd,
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    sandboxed: false,
  };
}

// argv entries may legitimately be empty (e.g. `--prefix ""`) and whitespace is
// significant, so unlike policy fields they are only type-checked.
function normalizeArgs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new SandboxPolicyError("invalid_sandbox_policy", "args must be an array.", { field: "args" });
  }
  return values.map((value, index) => {
    if (typeof value !== "string") {
      throw new SandboxPolicyError("invalid_sandbox_policy", `args[${index}] must be a string.`, { field: `args[${index}]` });
    }
    return value;
  });
}

function normalizeNetworkPolicy(input: SandboxNetworkPolicyInput | undefined): SandboxNetworkPolicy {
  const mode = input?.mode ?? "none";
  if (!SANDBOX_NETWORK_MODES.includes(mode)) {
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

/**
 * Intersection semantics: the merged policy allows a host only if both
 * policies allow it. Incomparable modes (localhost vs allowlist) reduce to the
 * allowlist entries that are loopback hosts; an empty intersection is "none",
 * never an invalid empty allowlist.
 */
function mergeNetworkPolicies(
  configured: SandboxNetworkPolicy,
  request: SandboxNetworkPolicy | undefined,
): SandboxNetworkPolicy {
  if (request === undefined) {
    return configured;
  }
  if (configured.mode === "none" || request.mode === "none") {
    return { mode: "none", allowlist: [] };
  }
  if (configured.mode === "all") {
    return { mode: request.mode, allowlist: [...request.allowlist] };
  }
  if (request.mode === "all") {
    return { mode: configured.mode, allowlist: [...configured.allowlist] };
  }
  if (configured.mode === "localhost" && request.mode === "localhost") {
    return { mode: "localhost", allowlist: [] };
  }
  if (configured.mode === "allowlist" && request.mode === "allowlist") {
    const requestDomains = new Set(request.allowlist);
    const allowlist = configured.allowlist.filter((domain) => requestDomains.has(domain)).sort();
    return allowlist.length === 0 ? { mode: "none", allowlist: [] } : { mode: "allowlist", allowlist };
  }
  const loopbackEntries = (configured.mode === "allowlist" ? configured.allowlist : request.allowlist)
    .filter((domain) => isLocalhost(domain))
    .sort();
  return loopbackEntries.length === 0
    ? { mode: "none", allowlist: [] }
    : { mode: "allowlist", allowlist: loopbackEntries };
}

function intersectRoots(configured: readonly string[], request: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const configuredRoot of configured) {
    for (const requestRoot of request) {
      if (pathContains(configuredRoot, requestRoot)) {
        out.add(requestRoot);
      } else if (pathContains(requestRoot, configuredRoot)) {
        out.add(configuredRoot);
      }
    }
  }
  return removeCoveredRoots([...out].sort());
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
  const home = homedir();
  // Secrets live under the home directory; deny it unless the policy
  // explicitly grants it. More-specific allowRead roots inside home still win.
  const homeReadable = policy.readableRoots.some((root) => pathContains(root, home));
  if (!homeReadable) {
    roots.add(home);
  }
  for (const readableRoot of policy.readableRoots) {
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
  roots.add(resolve(home, ".ssh"));
  return removeCoveredRoots([...roots].sort());
}

// srt settings are a pure function of the policy, so the file is
// content-addressed and shared across every command run under that policy.
async function writeSrtSettingsFile(policy: SandboxPolicy): Promise<string> {
  const content = `${JSON.stringify(srtSettingsForPolicy(policy), null, 2)}\n`;
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const settingsPath = resolve(policy.tempRoot, `srt-settings-${digest}.json`);
  if (existsSync(settingsPath)) {
    return settingsPath;
  }
  await mkdir(policy.tempRoot, { recursive: true });
  const stagingPath = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(stagingPath, content, "utf8");
  await rename(stagingPath, settingsPath);
  return settingsPath;
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

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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

function pathContains(root: string, target: string): boolean {
  return target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
}

function removeCoveredRoots(paths: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (out.some((root) => pathContains(root, path))) {
      continue;
    }
    out.push(path);
  }
  return out;
}
