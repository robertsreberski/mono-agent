// Test-only RuntimeSandbox fixture + policy factory.
//
// agent-runtime's kernel has ZERO workspace-package imports (see
// ../../agent/sandbox-seam.js and its passthroughSandbox default); production
// hosts inject @mono-agent/turn/host's implementation from
// packages/turn/src/host/sandbox/index.ts (via host/sandbox/implementation.ts).
// This fixture reimplements just enough of host integration's pure policy algebra
// (monotonic merge, engine-delegated command prep, network-mode allow checks)
// for turn's OWN tool-enforcement tests (agent/tools.test.ts,
// pi-bridge.test.js, tool-context.test.js) to exercise realistic sandbox
// behavior without a workspace dependency. It intentionally omits the real
// SRT engine integration — every test that needs `prepareCommand` to do real
// work supplies its own fake `sandboxEngine`, exactly as it did before this
// seam existed.
//
// This is a fixture, not a product path: the byte-identical real
// implementation is wired in by turn host.

const DEFAULT_DENY_WRITE = [".env", ".env.*", ".git/config", ".git/hooks/**"];

/**
 * Builds a native-mode, fail-closed policy object shaped like host integration's
 * `failClosedSandboxPolicy({...})` output — enough for
 * path-resolver.js (which reads `root`/`readableRoots`/`writableRoots`/
 * `denyWrite` directly off whatever the injected `mergePolicies` returns) to
 * enforce realistic root/write restrictions in tests.
 */
export function testSandboxPolicy({
  root,
  readableRoots,
  writableRoots,
  protectedRoots = [],
  denyWrite = DEFAULT_DENY_WRITE,
  network = { mode: "none", allowlist: [] },
}: { root?: string; readableRoots?: string[]; writableRoots?: string[]; protectedRoots?: string[]; denyWrite?: string[]; network?: import("../../agent/sandbox-seam.js").SandboxNetworkPolicyLike } = {}) {
  return {
    mode: "native",
    engine: "srt",
    root,
    readableRoots: readableRoots ?? [root],
    writableRoots: writableRoots ?? [root],
    protectedRoots,
    denyWrite,
    tempRoot: `${root}/.mono-agent/tmp`,
    network,
    fallback: "fail-closed",
    unsafeAllowHostProcess: false,
  };
}

function pathContains(root: string, target: string) {
  return target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
}

function removeCoveredRoots(paths: string[]) {
  const out: string[] = [];
  for (const path of paths) {
    if (out.some((existing) => pathContains(existing, path))) continue;
    out.push(path);
  }
  return out;
}

function intersectRoots(configured: string[] | undefined, request: string[] | undefined) {
  const out = new Set<string>();
  for (const configuredRoot of configured || []) {
    for (const requestRoot of request || []) {
      if (pathContains(configuredRoot, requestRoot)) out.add(requestRoot);
      else if (pathContains(requestRoot, configuredRoot)) out.add(configuredRoot);
    }
  }
  return removeCoveredRoots([...out].sort());
}

function isLocalhost(host: string) {
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || String(host).startsWith("127.");
}

function mergeNetwork(configured: import("../../agent/sandbox-seam.js").SandboxNetworkPolicyLike | undefined, request: import("../../agent/sandbox-seam.js").SandboxNetworkPolicyLike | undefined) {
  if (!request) return configured;
  if (!configured) return request;
  if (configured.mode === "none" || request.mode === "none") return { mode: "none", allowlist: [] };
  if (configured.mode === "all") return { mode: request.mode, allowlist: [...(request.allowlist || [])] };
  if (request.mode === "all") return { mode: configured.mode, allowlist: [...(configured.allowlist || [])] };
  if (configured.mode === "localhost" && request.mode === "localhost") return { mode: "localhost", allowlist: [] };
  if (configured.mode === "allowlist" && request.mode === "allowlist") {
    const requestDomains = new Set(request.allowlist || []);
    const allowlist = (configured.allowlist || []).filter((domain) => requestDomains.has(domain)).sort();
    return allowlist.length === 0 ? { mode: "none", allowlist: [] } : { mode: "allowlist", allowlist };
  }
  const loopback = ((configured.mode === "allowlist" ? configured.allowlist : request.allowlist) || [])
    .filter(isLocalhost)
    .sort();
  return loopback.length === 0 ? { mode: "none", allowlist: [] } : { mode: "allowlist", allowlist: loopback };
}

function mergePolicies(configured: import("../../agent/sandbox-seam.js").SandboxPolicy | undefined, request: import("../../agent/sandbox-seam.js").SandboxPolicy | undefined) {
  if (configured === undefined) return request;
  if (request === undefined) return configured;
  const protectedRoots = [...new Set([
    ...(configured.protectedRoots ?? []),
    ...(request.protectedRoots ?? []),
  ])].sort();
  if (configured.mode === "off") {
    return { ...(request.mode === "native" ? request : configured), protectedRoots };
  }
  if (request.mode === "off") return { ...configured, protectedRoots };
  return {
    ...configured,
    readableRoots: intersectRoots(configured.readableRoots, request.readableRoots),
    writableRoots: intersectRoots(configured.writableRoots, request.writableRoots),
    denyWrite: [...new Set([...(configured.denyWrite ?? []), ...(request.denyWrite ?? [])])],
    protectedRoots,
    network: mergeNetwork(configured.network, request.network),
    fallback: configured.fallback === "fail-closed" || request.fallback === "fail-closed" ? "fail-closed" : configured.fallback,
    unsafeAllowHostProcess: configured.unsafeAllowHostProcess && request.unsafeAllowHostProcess,
  };
}

async function prepareCommand({ policy, engine, command }: import("../../agent/sandbox-seam.js").PrepareSandboxedCommandInput) {
  if (policy == null || policy.mode === "off") {
    return { ...command, args: command.args ?? [], cwd: command.cwd ?? process.cwd(), sandboxed: false };
  }
  if (engine && (await engine.isAvailable())) {
    return engine.prepareCommand(command, policy);
  }
  if (policy.fallback === "unsafe-host-process" && policy.unsafeAllowHostProcess) {
    return { ...command, args: command.args ?? [], cwd: command.cwd ?? process.cwd(), sandboxed: false };
  }
  const error = new Error("Sandbox engine is unavailable and policy is fail-closed.") as Error & { code?: string; details?: { code: string } };
  error.name = "SandboxUnavailableError";
  error.code = "sandbox_unavailable";
  error.details = { code: "sandbox_unavailable" };
  throw error;
}

function domainMatches(host: string, pattern: string) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function networkAllowsUrl(policy: import("../../agent/sandbox-seam.js").SandboxPolicy | undefined, url: string) {
  if (policy == null || policy.mode === "off") return true;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const net = policy.network || { mode: "none", allowlist: [] };
  if (net.mode === "all") return true;
  if (net.mode === "none") return false;
  if (net.mode === "localhost") return isLocalhost(host);
  return (net.allowlist || []).some((domain: string) => domainMatches(host, domain));
}

/** Builds a fresh RuntimeSandbox fixture (see module doc). */
export function createFakeSandbox() {
  return { mergePolicies, prepareCommand, networkAllowsUrl };
}
