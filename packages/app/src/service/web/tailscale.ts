import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import process from "node:process";

import { isLoopbackHost } from "@mono-agent/contracts";

import { writeOwnerPrivateLaunchdFile } from "../launchd/plist-files.js";
import type { ManagedWebPaths } from "./web-maintenance-paths.js";
import { commandDetail, errorMessage, urlHost } from "./presentation.js";
import { isRecord } from "./record.js";
import { TAILSCALE_OWNERSHIP_SCHEMA } from "./types.js";
import type {
  CommandResult,
  CommandRunner,
  OwnedRouteInspection,
  RunWebCommandDeps,
  TailscaleCleanupResult,
  TailscaleOwnershipRead,
  TailscaleServeOwnership,
  TailscaleServeResult,
  TailscaleStatusRead,
} from "./types.js";
const TAILSCALE_FALLBACK_PORT_START = 8443;
const TAILSCALE_FALLBACK_PORT_END = 8499;
const TAILSCALE_STATUS_ATTEMPTS = 3;
const TAILSCALE_STATUS_RETRY_MS = 200;

export async function ensureTailscaleServe(
  paths: ManagedWebPaths,
  bindHost: string,
  appPort: number,
  env: Record<string, string | undefined>,
  deps: RunWebCommandDeps,
  expectedDnsName?: string,
  /**
   * Whether a missing route may be created. Only an explicit `--share-tailnet`
   * passes true; an existing exact owned route is always verified/migrated, and
   * a record whose handler is provably absent is cleared but never replaced
   * without the explicit flag.
   */
  allowCreate = true,
): Promise<TailscaleServeResult> {
  const runner = deps.tailscale ?? makeTailscaleRunner(env);
  const proxyTarget = tailscaleProxyTarget(bindHost, appPort);
  const ownershipRead = await readTailscaleOwnership(paths.tailscalePath);
  if (ownershipRead.kind === "invalid") {
    return { kind: "unavailable", detail: ownershipRead.detail, routeOutcome: "none" };
  }
  let existing = ownershipRead.kind === "valid" ? ownershipRead.ownership : undefined;
  let priorMigration: { readonly ownership: TailscaleServeOwnership; readonly contents: string } | undefined;
  let attemptedHttpsPort: number | undefined;
  let replacementClaimAttempted = false;
  const attempted = (): { readonly httpsPort?: number; readonly proxyTarget?: string } => ({
    ...(attemptedHttpsPort === undefined ? {} : { httpsPort: attemptedHttpsPort }),
    ...(proxyTarget === undefined ? {} : { proxyTarget }),
  });
  const failMigration = async (detail: string): Promise<TailscaleServeResult> => {
    if (priorMigration === undefined) {
      return {
        kind: "unavailable",
        detail,
        routeOutcome: attemptedHttpsPort === undefined ? "none" : "uncertain",
        attempted: attempted(),
      };
    }
    const restored = await restorePriorTailscaleRoute(
      paths,
      priorMigration.ownership,
      priorMigration.contents,
      runner,
      deps,
    );
    // The replacement handler was never claimed (or was never confirmed), so a
    // claim attempt leaves its removal unproven.
    const replacementHandlerRemoved = !replacementClaimAttempted;
    return {
      kind: "unavailable",
      detail: `${detail}; ${restored.detail}`,
      requiresServiceRollback: true,
      priorRouteRestored: restored.ok,
      replacementHandlerRemoved,
      routeOutcome: restored.ok && replacementHandlerRemoved ? "restored" : "uncertain",
      attempted: {
        httpsPort: priorMigration.ownership.httpsPort,
        proxyTarget: priorMigration.ownership.proxyTarget,
      },
    };
  };
  /**
   * Finalize a failure that happened AFTER a new handler was claimed. When this
   * command migrated an existing owned route, the prior route and its ownership
   * record are already gone, so the replacement worker must be rolled back
   * unless the prior exact route is safely restored first — every post-claim
   * failure funnels through here instead of returning ad hoc results.
   */
  const failAfterClaim = async (
    detail: string,
    replacementCleanup: TailscaleCleanupResult,
    attempt: { readonly httpsPort: number; readonly proxyTarget: string },
  ): Promise<TailscaleServeResult> => {
    if (priorMigration === undefined) {
      return {
        kind: "unavailable",
        detail: `${detail}; ${replacementCleanup.detail}`,
        routeOutcome: replacementCleanup.ok ? "rolled-back" : "uncertain",
        attempted: attempt,
      };
    }
    const restored = await restorePriorTailscaleRoute(
      paths,
      priorMigration.ownership,
      priorMigration.contents,
      runner,
      deps,
    );
    return {
      kind: "unavailable",
      detail: `${detail}; replacement cleanup: ${replacementCleanup.detail}; prior route: ${restored.detail}`,
      requiresServiceRollback: true,
      priorRouteRestored: restored.ok,
      replacementHandlerRemoved: replacementCleanup.ok,
      // "restored" requires both: a live prior route must never imply that the
      // replacement handler was removed.
      routeOutcome: restored.ok && replacementCleanup.ok ? "restored" : "uncertain",
      // The uncertain handler is the replacement attempt; the restore outcome is
      // stated in the detail above.
      attempted: attempt,
    };
  };
  if (proxyTarget === undefined) {
    return {
      kind: "unavailable",
      detail: `bind host ${bindHost} is not reachable through a loopback proxy; use --host 0.0.0.0, --host ::, or --loopback`,
      routeOutcome: "none",
    };
  }
  if (existing !== undefined) {
    const inspection = await inspectOwnedTailscaleRoute(existing, deps, runner);
    if (inspection.kind === "absent") {
      const cleared = await clearProvablyAbsentTailscaleOwnership(paths, existing, runner);
      if (cleared.kind === "unavailable") {
        return { kind: "unavailable", detail: cleared.detail, routeOutcome: "none" };
      }
      existing = undefined;
    } else if (inspection.kind !== "exact") {
      return {
        kind: "unavailable",
        detail: inspection.kind === "unavailable"
          ? inspection.detail
          : "the prior Tailscale ownership record no longer matches its exact handler; refusing to overwrite it",
        routeOutcome: "none",
      };
    }
  }
  // No exact owned route remains. Creating one requires the explicit flag: a
  // proven-absent ownership record never authorizes a new route on its own.
  if (existing === undefined && !allowCreate) return { kind: "not-requested" };
  if (existing !== undefined) {
    if (expectedDnsName !== undefined && tailscaleWebHostname(existing.webKey) !== expectedDnsName) {
      return {
        kind: "unavailable",
        detail: "the owned Tailscale handler hostname does not match this node's exact DNS name; refusing to reuse or replace it",
        routeOutcome: "none",
      };
    }
    if (proxyTarget !== undefined && existing.proxyTarget === proxyTarget) {
      return { kind: "active", ownership: existing, reused: true };
    }
    if (ownershipRead.kind !== "valid") {
      return {
        kind: "unavailable",
        detail: "the prior Tailscale ownership record changed during migration; refusing to remove its handler",
        routeOutcome: "none",
      };
    }
    priorMigration = { ownership: existing, contents: ownershipRead.contents };
    const removed = await removeOwnedTailscaleServe(paths, { ...deps, tailscale: runner });
    if (removed.kind === "unavailable") {
      return await failMigration(`could not migrate the prior exact Tailscale handler: ${removed.detail}`);
    }
    attemptedHttpsPort = existing.httpsPort;
  }
  // Reaching this point means a route must be created: either no owned route
  // existed (the explicit flag was required and was checked above) or an exact
  // owned route was just migrated to this worker's target, whose replacement is
  // part of the install's existing exposure rather than a new one.
  const initial = await readTailscaleServeStatus(runner);
  if (initial.kind === "error") return await failMigration(initial.detail);
  const httpsPort = chooseTailscaleHttpsPort(initial.status);
  if (httpsPort === undefined) {
    return await failMigration("ports 443 and 8443-8499 are already assigned; no handler was changed");
  }
  attemptedHttpsPort = httpsPort;
  replacementClaimAttempted = true;
  const configured = await runner(["serve", "--bg", `--https=${String(httpsPort)}`, proxyTarget]);
  if (configured.code !== 0) {
    return await failMigration(commandDetail(configured) || `tailscale serve exited ${String(configured.code)}`);
  }
  const [after, observedDnsName] = await Promise.all([
    readTailscaleServeStatus(runner),
    readTailscaleDnsName(runner, deps.sleep),
  ]);
  if (after.kind === "error") {
    const rollback = await rollbackJustCreatedTailscaleRoute(
      runner,
      httpsPort,
      proxyTarget,
      expectedDnsName ?? observedDnsName,
    );
    return await failAfterClaim(
      `handler command succeeded but verification failed: ${after.detail}`,
      rollback,
      { httpsPort, proxyTarget },
    );
  }
  if (expectedDnsName !== undefined && observedDnsName !== expectedDnsName) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, observedDnsName);
    return await failAfterClaim(
      "handler command succeeded but the node's exact Tailscale DNS name changed or became unavailable",
      rollback,
      { httpsPort, proxyTarget },
    );
  }
  const dnsName = expectedDnsName ?? observedDnsName;
  const webKey = findTailscaleWebKey(after.status, httpsPort, proxyTarget, dnsName);
  if (webKey === undefined) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, dnsName);
    return await failAfterClaim(
      "handler command succeeded but the exact proxy target could not be verified",
      rollback,
      { httpsPort, proxyTarget },
    );
  }
  if (!isExactExpectedTailscaleRoute(after.status, webKey, httpsPort, proxyTarget)) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, dnsName);
    return await failAfterClaim(
      "handler command succeeded but its TCP or Web handler set was not the exact root Proxy-only shape",
      rollback,
      { httpsPort, proxyTarget },
    );
  }
  if (expectedDnsName !== undefined && tailscaleWebHostname(webKey) !== expectedDnsName) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, dnsName);
    return await failAfterClaim(
      "handler command succeeded under an unexpected Tailscale hostname",
      rollback,
      { httpsPort, proxyTarget },
    );
  }
  const hostname = webKey.slice(0, webKey.lastIndexOf(":"));
  const ownership: TailscaleServeOwnership = {
    schema: TAILSCALE_OWNERSHIP_SCHEMA,
    webKey,
    httpsPort,
    proxyTarget,
    configSha256: tailscalePortConfigSha256(after.status, webKey, httpsPort),
    url: `https://${hostname}${httpsPort === 443 ? "" : `:${String(httpsPort)}`}/`,
    configuredAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  try {
    await (deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile)(
      paths.tailscalePath,
      `${JSON.stringify(ownership, undefined, 2)}\n`,
    );
  } catch (error) {
    const rollback = await rollbackExactTailscaleRoute(runner, after.status, ownership);
    return await failAfterClaim(
      `could not durably record Tailscale handler ownership: ${errorMessage(error)}`,
      rollback,
      { httpsPort, proxyTarget },
    );
  }
  return { kind: "active", ownership, reused: false };
}

async function restorePriorTailscaleRoute(
  paths: ManagedWebPaths,
  ownership: TailscaleServeOwnership,
  ownershipContents: string,
  runner: CommandRunner,
  deps: RunWebCommandDeps,
): Promise<TailscaleCleanupResult> {
  const before = await readTailscaleServeStatus(runner);
  if (before.kind === "error") {
    return {
      ok: false,
      detail: `the prior HTTPS route could not be restored because status failed: ${before.detail}`,
    };
  }
  if (attemptedPortState(before.status, ownership.httpsPort) !== "absent") {
    return {
      ok: false,
      detail: "the prior HTTPS route could not be restored because its port still has a handler or an unreadable inventory; its old ownership record was not republished",
    };
  }
  const configured = await runner([
    "serve",
    "--bg",
    `--https=${String(ownership.httpsPort)}`,
    ownership.proxyTarget,
  ]);
  if (configured.code !== 0) {
    return {
      ok: false,
      detail: `the prior HTTPS route could not be restored: ${commandDetail(configured) || `exit ${String(configured.code)}`}`,
    };
  }
  const after = await readTailscaleServeStatus(runner);
  if (after.kind === "error" || !routeMatches(after.status, ownership)) {
    if (after.kind === "ok") {
      await rollbackJustCreatedTailscaleRoute(
        runner,
        ownership.httpsPort,
        ownership.proxyTarget,
        undefined,
      );
    }
    return {
      ok: false,
      detail: "the prior HTTPS route command succeeded but its exact previous handler set was not restored",
    };
  }
  try {
    await (deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile)(paths.tailscalePath, ownershipContents);
  } catch (error) {
    const rollback = await rollbackExactTailscaleRoute(runner, after.status, ownership);
    return {
      ok: false,
      detail: `the prior HTTPS route was recreated but ownership could not be republished (${errorMessage(error)}); ${rollback.detail}`,
    };
  }
  return { ok: true, detail: "the prior exact HTTPS route and ownership record were restored" };
}

export function tailscaleProxyTarget(bindHost: string, appPort: number): string | undefined {
  const normalized = bindHost.startsWith("[") && bindHost.endsWith("]")
    ? bindHost.slice(1, -1).toLowerCase()
    : bindHost.toLowerCase();
  if (normalized === "0.0.0.0") {
    return `http://127.0.0.1:${String(appPort)}`;
  }
  if (normalized === "::") return `http://[::1]:${String(appPort)}`;
  // Node may resolve localhost to either loopback family. Without the actual
  // bound address, publishing a numeric Serve target could point at the other
  // family. --loopback is the deterministic 127.0.0.1 spelling.
  if (normalized === "localhost") return undefined;
  if (!isLoopbackHost(normalized)) return undefined;
  return `http://${urlHost(normalized)}:${String(appPort)}`;
}

/**
 * Whether the attempted HTTPS port is provably free of every handler. Only an
 * absent — or empty — TCP/Web inventory proves that: a handler on the port under
 * a different key, or a present but malformed container, cannot.
 */
function attemptedPortState(status: Record<string, unknown>, httpsPort: number): "absent" | "occupied" {
  if (status.TCP !== undefined && !isRecord(status.TCP)) return "occupied";
  if (status.Web !== undefined && !isRecord(status.Web)) return "occupied";
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const web = isRecord(status.Web) ? status.Web : {};
  if (Object.hasOwn(tcp, String(httpsPort))) return "occupied";
  return Object.keys(web).some((key) => key.endsWith(`:${String(httpsPort)}`)) ? "occupied" : "absent";
}

async function rollbackJustCreatedTailscaleRoute(
  runner: CommandRunner,
  httpsPort: number,
  proxyTarget: string,
  dnsName: string | undefined,
): Promise<TailscaleCleanupResult> {
  const current = await readTailscaleServeStatus(runner);
  if (current.kind === "error") {
    return {
      ok: false,
      detail: `rollback could not verify an exact handler (${current.detail}); no unrelated handler was changed`,
    };
  }
  const webKey = findTailscaleWebKey(current.status, httpsPort, proxyTarget, dnsName);
  if (webKey === undefined) {
    // No exact match is not the same as no route: only a port with no handler at
    // all proves the attempted route is gone.
    return attemptedPortState(current.status, httpsPort) === "absent"
      ? { ok: true, detail: `no handler remained on HTTPS port ${String(httpsPort)}` }
      : {
          ok: false,
          detail: `HTTPS port ${String(httpsPort)} still has a handler that does not match the exact created shape; nothing was removed`,
        };
  }
  if (!isExactExpectedTailscaleRoute(current.status, webKey, httpsPort, proxyTarget)) {
    return {
      ok: false,
      detail: "rollback refused because the newly-created port no longer had the exact root Proxy-only shape",
    };
  }
  const ownership: TailscaleServeOwnership = {
    schema: TAILSCALE_OWNERSHIP_SCHEMA,
    webKey,
    httpsPort,
    proxyTarget,
    configSha256: tailscalePortConfigSha256(current.status, webKey, httpsPort),
    url: "",
    configuredAt: new Date(0).toISOString(),
  };
  return await rollbackExactTailscaleRoute(runner, current.status, ownership);
}

async function rollbackExactTailscaleRoute(
  runner: CommandRunner,
  status: Record<string, unknown>,
  ownership: TailscaleServeOwnership,
): Promise<TailscaleCleanupResult> {
  if (!routeMatches(status, ownership)) {
    return { ok: false, detail: "rollback refused because the handler no longer matched exactly" };
  }
  const removed = await runner(["serve", `--https=${String(ownership.httpsPort)}`, "off"]);
  if (removed.code !== 0) {
    return {
      ok: false,
      detail: `rollback of the exact handler failed: ${commandDetail(removed) || `exit ${String(removed.code)}`}`,
    };
  }
  // A zero exit is not proof of removal: re-read status and require the exact
  // handler to be provably absent before claiming it was rolled back.
  const after = await readTailscaleServeStatus(runner);
  if (after.kind === "error") {
    return {
      ok: false,
      detail: `the off command succeeded but the handler's absence could not be verified: ${after.detail}`,
    };
  }
  if (attemptedPortState(after.status, ownership.httpsPort) !== "absent") {
    return {
      ok: false,
      detail: `the off command succeeded but HTTPS port ${String(ownership.httpsPort)} still has a handler or an unreadable inventory; nothing else was touched`,
    };
  }
  return { ok: true, detail: "the exact handler was removed and its absence was verified" };
}

export async function removeOwnedTailscaleServe(
  paths: ManagedWebPaths,
  deps: RunWebCommandDeps,
): Promise<{ readonly kind: "removed" | "absent" } | { readonly kind: "unavailable"; readonly detail: string }> {
  const ownershipRead = await readTailscaleOwnership(paths.tailscalePath);
  if (ownershipRead.kind === "absent") return { kind: "absent" };
  if (ownershipRead.kind === "invalid") return { kind: "unavailable", detail: ownershipRead.detail };
  const ownership = ownershipRead.ownership;
  const runner = deps.tailscale ?? makeTailscaleRunner(process.env);
  const inspection = await inspectOwnedTailscaleRoute(ownership, deps, runner);
  if (inspection.kind === "absent") {
    return await clearProvablyAbsentTailscaleOwnership(paths, ownership, runner);
  }
  if (inspection.kind !== "exact") {
    return { kind: "unavailable", detail: "the recorded handler no longer matches its exact host, port, and proxy target; refusing to remove it" };
  }
  const removed = await runner(["serve", `--https=${String(ownership.httpsPort)}`, "off"]);
  if (removed.code !== 0) {
    return { kind: "unavailable", detail: commandDetail(removed) || `tailscale serve off exited ${String(removed.code)}` };
  }
  const after = await readTailscaleServeStatus(runner);
  if (after.kind === "error" || routeMatches(after.status, ownership)) {
    return { kind: "unavailable", detail: after.kind === "error" ? after.detail : "the handler is still present after tailscale serve off" };
  }
  await rm(paths.tailscalePath, { force: true });
  return { kind: "removed" };
}

export async function inspectOwnedTailscaleRoute(
  ownership: TailscaleServeOwnership,
  deps: RunWebCommandDeps,
  suppliedRunner?: CommandRunner,
): Promise<OwnedRouteInspection> {
  const status = await readTailscaleServeStatus(suppliedRunner ?? deps.tailscale ?? makeTailscaleRunner(process.env));
  if (status.kind === "error") return { kind: "unavailable", detail: status.detail };
  return classifyOwnedTailscaleRoute(status.status, ownership);
}

function classifyOwnedTailscaleRoute(
  status: Record<string, unknown>,
  ownership: TailscaleServeOwnership,
): OwnedRouteInspection {
  if (routeMatches(status, ownership)) return { kind: "exact" };
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const web = isRecord(status.Web) ? status.Web : {};
  if (!Object.hasOwn(tcp, String(ownership.httpsPort)) && !Object.hasOwn(web, ownership.webKey)) {
    return { kind: "absent" };
  }
  return { kind: "changed" };
}

async function clearProvablyAbsentTailscaleOwnership(
  paths: ManagedWebPaths,
  ownership: TailscaleServeOwnership,
  runner: CommandRunner,
): Promise<{ readonly kind: "absent" } | { readonly kind: "unavailable"; readonly detail: string }> {
  const confirmation = await readTailscaleServeStatus(runner);
  if (confirmation.kind === "error") return { kind: "unavailable", detail: confirmation.detail };
  if (classifyOwnedTailscaleRoute(confirmation.status, ownership).kind !== "absent") {
    return { kind: "unavailable", detail: "the recorded Tailscale handler changed while confirming its absence; ownership was preserved" };
  }
  await rm(paths.tailscalePath, { force: true });
  return { kind: "absent" };
}

async function readTailscaleServeStatus(runner: CommandRunner): Promise<TailscaleStatusRead> {
  const result = await runner(["serve", "status", "--json"]);
  if (result.code !== 0) {
    return { kind: "error", detail: commandDetail(result) || `tailscale serve status exited ${String(result.code)}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!isRecord(parsed)) throw new Error("expected an object");
    return { kind: "ok", status: parsed };
  } catch (error) {
    return { kind: "error", detail: `tailscale serve status returned invalid JSON: ${errorMessage(error)}` };
  }
}

export function chooseTailscaleHttpsPort(status: Record<string, unknown>): number | undefined {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  for (const port of [443, ...integerRange(TAILSCALE_FALLBACK_PORT_START, TAILSCALE_FALLBACK_PORT_END)]) {
    if (!Object.hasOwn(tcp, String(port))) return port;
  }
  return undefined;
}

function findTailscaleWebKey(
  status: Record<string, unknown>,
  port: number,
  proxyTarget: string,
  dnsName: string | undefined,
): string | undefined {
  const web = isRecord(status.Web) ? status.Web : {};
  const preferred = dnsName === undefined ? undefined : `${dnsName}:${String(port)}`;
  if (preferred !== undefined && webHandlerProxy(web[preferred]) === proxyTarget) return preferred;
  return Object.keys(web).find((key) => key.endsWith(`:${String(port)}`) && webHandlerProxy(web[key]) === proxyTarget);
}

export function tailscaleWebHostname(webKey: string): string {
  return webKey.slice(0, webKey.lastIndexOf(":"));
}

function routeMatches(status: Record<string, unknown>, ownership: TailscaleServeOwnership): boolean {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const port = tcp[String(ownership.httpsPort)];
  const web = isRecord(status.Web) ? status.Web : {};
  return isRecord(port)
    && port.HTTPS === true
    && webHandlerProxy(web[ownership.webKey]) === ownership.proxyTarget
    && tailscalePortConfigSha256(status, ownership.webKey, ownership.httpsPort) === ownership.configSha256;
}

function isExactExpectedTailscaleRoute(
  status: Record<string, unknown>,
  webKey: string,
  httpsPort: number,
  proxyTarget: string,
): boolean {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const port = tcp[String(httpsPort)];
  const web = isRecord(status.Web) ? status.Web : {};
  const entry = web[webKey];
  if (!isRecord(port) || !hasExactKeys(port, ["HTTPS"]) || port.HTTPS !== true) return false;
  if (!isRecord(entry) || !hasExactKeys(entry, ["Handlers"]) || !isRecord(entry.Handlers)) return false;
  if (!hasExactKeys(entry.Handlers, ["/"]) || !isRecord(entry.Handlers["/"])) return false;
  return hasExactKeys(entry.Handlers["/"], ["Proxy"])
    && entry.Handlers["/"].Proxy === proxyTarget;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function tailscalePortConfigSha256(status: Record<string, unknown>, webKey: string, httpsPort: number): string {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const web = isRecord(status.Web) ? status.Web : {};
  const canonical = canonicalJson({ tcp: tcp[String(httpsPort)], web: web[webKey] });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function webHandlerProxy(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.Handlers) || !isRecord(value.Handlers["/"])) return undefined;
  return typeof value.Handlers["/"].Proxy === "string" ? value.Handlers["/"].Proxy : undefined;
}

export async function readTailscaleDnsName(
  runner: CommandRunner,
  suppliedSleep?: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const sleep = suppliedSleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  for (let attempt = 0; attempt < TAILSCALE_STATUS_ATTEMPTS; attempt += 1) {
    const result = await runner(["status", "--json"]);
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        if (isRecord(parsed) && isRecord(parsed.Self) && typeof parsed.Self.DNSName === "string") {
          return parsed.Self.DNSName.replace(/\.$/u, "").toLowerCase();
        }
      } catch {
        // A transiently truncated LocalAPI response is retried below.
      }
    }
    if (attempt + 1 < TAILSCALE_STATUS_ATTEMPTS) await sleep(TAILSCALE_STATUS_RETRY_MS);
  }
  return undefined;
}

export function makeTailscaleRunner(env: Record<string, string | undefined>): CommandRunner {
  return (args) => spawnCapture("tailscale", args, env);
}

function spawnCapture(command: string, args: readonly string[], env: Record<string, string | undefined>): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

export async function readTailscaleOwnership(path: string): Promise<TailscaleOwnershipRead> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", detail: "the Tailscale ownership record is unreadable; refusing to change any Serve handler" };
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return { kind: "invalid", detail: "the Tailscale ownership record is malformed; refusing to change any Serve handler" };
  }
  if (!isRecord(value) || value.schema !== TAILSCALE_OWNERSHIP_SCHEMA
    || typeof value.webKey !== "string" || typeof value.proxyTarget !== "string" || typeof value.url !== "string"
    || typeof value.configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.configSha256)
    || typeof value.configuredAt !== "string" || !Number.isSafeInteger(value.httpsPort)
    || (value.httpsPort as number) < 1 || (value.httpsPort as number) > 65_535) {
    return { kind: "invalid", detail: "the Tailscale ownership record has an invalid schema; refusing to change any Serve handler" };
  }
  return { kind: "valid", ownership: value as unknown as TailscaleServeOwnership, contents };
}

function integerRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
