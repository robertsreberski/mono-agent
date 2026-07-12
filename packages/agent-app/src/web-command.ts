import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

import { pruneTraceSources } from "@mono-agent/observability";
import { startSessionWebServer } from "@mono-agent/session-web";
import type { SessionWebServerHandle } from "@mono-agent/session-web";
import { generateBearerToken, isLoopbackHost, normalizeOptionalString } from "@mono-agent/agent-contracts";

import { resolveAppTraceRegistryDir, resolveGlobalTraceRegistryDir } from "./app-config.js";

export const DEFAULT_WEB_PORT = 4599;
const WEB_AUTH_TOKEN_ENV = "MONO_AGENT_WEB_AUTH_TOKEN";

export interface RunWebOptions {
  readonly configPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  /** --host: bind address (default 127.0.0.1). */
  readonly host?: string;
  /** --port: bind port (default 4599). */
  readonly port?: number;
  /** --no-open: suppress the browser launch (default: open). */
  readonly open?: boolean;
  /** --allow-non-loopback: bind a non-loopback host (refused by default). */
  readonly allowNonLoopback?: boolean;
  /** --show-auth-url: reveal a configured token only in an interactive terminal. */
  readonly showAuthUrl?: boolean;
  /** --include-memory: show memory-maintenance runs in the web operator surface. */
  readonly includeMemory?: boolean;
  /**
   * --max-runs: per-instance cap on the in-memory live-fold working set (and the
   * initial snapshot size). Disk paging remains the full history source, so this
   * only bounds memory; it does not limit how far "Load older" can reach.
   */
  readonly maxRunsPerInstance?: number;
}

/** Test seams: server boot, browser open, and the shutdown wait are injectable. */
export interface RunWebDeps {
  readonly startServer?: typeof startSessionWebServer;
  readonly openUrl?: (url: string) => void;
  readonly waitForShutdown?: () => Promise<void>;
  readonly onReady?: (handle: SessionWebServerHandle) => void;
  readonly stdout?: { write(text: string): void };
  readonly stderr?: { write(text: string): void };
  readonly interactive?: boolean;
  readonly discoverNetworkAddresses?: () => readonly WebNetworkAddress[];
}

export interface WebNetworkAddress {
  readonly address: string;
  readonly kind: "lan" | "tailscale";
}

interface AdvertisedUrl {
  readonly label: "Loopback" | "LAN" | "Tailscale" | "Web";
  readonly url: string;
}

/**
 * `mono-agent web`: discover every running agent on this machine (trace-source
 * registry, the same mechanism as `mono-agent tui`) and serve the read-only
 * Session Recorder PWA that visualises their runs live. Unlike `tui`, it shows
 * ALL instances at once and needs no TTY — it runs until interrupted.
 */
export async function runWeb(options: RunWebOptions, deps: RunWebDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const configuredRegistryDir = await resolveAppTraceRegistryDir({
    env: options.env,
    cwd: options.cwd,
    configPath: options.configPath,
  });
  const globalRegistryDir = resolveGlobalTraceRegistryDir(options.env);
  const registryDirs = dedupePaths([configuredRegistryDir, globalRegistryDir]);
  await Promise.all(registryDirs.map((registryDir) => pruneTraceSources({ registryDir })));
  const authRequired = requiresServerAuth(options.host);
  const interactive = deps.interactive ?? process.stdout.isTTY === true;
  const configuredAuthToken = authRequired
    ? normalizeOptionalString(options.env.MONO_AGENT_WEB_AUTH_TOKEN)
    : undefined;
  if (authRequired && configuredAuthToken === undefined && !interactive) {
    stderr.write(
      `Non-interactive non-loopback web serving requires ${WEB_AUTH_TOKEN_ENV}; refusing to generate a bearer secret into logs.\n`,
    );
    return 1;
  }
  const authToken = authRequired ? configuredAuthToken ?? generateBearerToken() : undefined;
  const generatedAuthToken = authToken !== undefined && configuredAuthToken === undefined;
  const port = options.port ?? DEFAULT_WEB_PORT;

  const startServer = deps.startServer ?? startSessionWebServer;
  let handle: SessionWebServerHandle;
  try {
    handle = await startServer({
      registryDirs,
      env: options.env,
      ...(options.host === undefined ? {} : { host: options.host }),
      port,
      ...(options.allowNonLoopback === undefined ? {} : { allowNonLoopback: options.allowNonLoopback }),
      ...(authToken === undefined ? {} : { authToken }),
      ...(options.includeMemory === undefined ? {} : { includeMemory: options.includeMemory }),
      ...(options.maxRunsPerInstance === undefined ? {} : { maxRunsPerInstance: options.maxRunsPerInstance }),
    });
  } catch (error) {
    stderr.write(`mono-agent web failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const networkAddresses = isWildcardUrl(handle.url)
    ? bestEffortNetworkAddresses(deps.discoverNetworkAddresses)
    : [];
  const advertisedUrls = resolveAdvertisedUrls(handle.url, networkAddresses);
  const primaryUrl = advertisedUrls[0]?.url ?? handle.url;
  const mayPrintConfiguredToken = configuredAuthToken !== undefined
    && options.showAuthUrl === true
    && interactive;
  const printableToken = generatedAuthToken || mayPrintConfiguredToken ? authToken : undefined;
  printAdvertisedUrls(stdout, advertisedUrls, printableToken);
  if (configuredAuthToken !== undefined && printableToken === undefined) {
    stdout.write(`Authentication: ${WEB_AUTH_TOKEN_ENV} is configured (token redacted).\n`);
  }
  if (configuredAuthToken !== undefined && options.showAuthUrl === true && !mayPrintConfiguredToken) {
    stderr.write("--show-auth-url was ignored because stdout is not an interactive terminal.\n");
  }
  stdout.write(
    `Watching ${registryDirs.length} registr${registryDirs.length === 1 ? "y" : "ies"} for agents. Press Ctrl-C to stop.\n`,
  );
  stdout.write(`${reverseProxyHint(primaryUrl)}\n`);
  stdout.write(`${reachabilityHint(handle.url)}\n`);

  if ((options.open ?? true) && authToken === undefined) {
    try {
      (deps.openUrl ?? openInBrowser)(primaryUrl);
    } catch {
      // Best-effort: a headless host without a browser is fine — the URL is printed.
    }
  } else if ((options.open ?? true) && authToken !== undefined) {
    stdout.write("Browser launch skipped in authenticated mode so the bearer token never enters process arguments.\n");
  }

  deps.onReady?.(handle);
  await (deps.waitForShutdown ?? waitForSignal)();
  await handle.stop();
  stdout.write("mono-agent web stopped.\n");
  return 0;
}

/**
 * A one-line hint about who can reach the server. Direct HTTP never depends on
 * Tailscale Serve; Serve is only an optional HTTPS/PWA-installability layer.
 */
function reachabilityHint(url: string): string {
  let port = "";
  let host = "";
  try {
    const parsed = new URL(url);
    port = parsed.port;
    host = parsed.hostname;
  } catch {
    /* leave blank */
  }
  if (host.length > 0 && !isLoopbackHost(host)) {
    return "Bound non-loopback: direct HTTP is available over your LAN/Tailnet at the URLs above. Tailscale Serve is optional and only needed for HTTPS + installable/offline PWA behavior.";
  }
  return `Loopback only. Re-run with --host 0.0.0.0 --allow-non-loopback for direct LAN/Tailnet HTTP. Tailscale Serve is optional for HTTPS + installable/offline PWA behavior (port ${port || "<port>"}).`;
}

function reverseProxyHint(url: string): string {
  let target = url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    target = parsed.toString();
  } catch {
    /* use the original URL */
  }
  return `Reverse proxies should target ${target} (default port ${DEFAULT_WEB_PORT}; override with --port).`;
}

function requiresServerAuth(host: string | undefined): boolean {
  return host !== undefined && !isLoopbackHost(host);
}

function withAuthToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

function printAdvertisedUrls(
  stdout: { write(text: string): void },
  urls: readonly AdvertisedUrl[],
  authToken: string | undefined,
): void {
  const printable = urls.map((entry) => ({
    ...entry,
    url: authToken === undefined ? entry.url : withAuthToken(entry.url, authToken),
  }));
  const primary = printable[0];
  if (primary === undefined) {
    return;
  }
  stdout.write(`mono-agent web  →  ${primary.url}\n`);
  for (const entry of printable.slice(1)) {
    stdout.write(`${entry.label.padEnd(9)} →  ${entry.url}\n`);
  }
}

function resolveAdvertisedUrls(url: string, networkAddresses: readonly WebNetworkAddress[]): AdvertisedUrl[] {
  if (!isWildcardUrl(url)) {
    return [{ label: isLoopbackUrl(url) ? "Loopback" : "Web", url }];
  }
  const urls: AdvertisedUrl[] = [{ label: "Loopback", url: replaceUrlHost(url, "127.0.0.1") }];
  for (const entry of networkAddresses) {
    urls.push({
      label: entry.kind === "tailscale" ? "Tailscale" : "LAN",
      url: replaceUrlHost(url, entry.address),
    });
  }
  return urls;
}

function replaceUrlHost(url: string, host: string): string {
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.toString();
}

function isWildcardUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "0.0.0.0" || host === "[::]" || host === "::";
  } catch {
    return false;
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function bestEffortNetworkAddresses(
  injected: (() => readonly WebNetworkAddress[]) | undefined,
): readonly WebNetworkAddress[] {
  try {
    return dedupeNetworkAddresses(injected?.() ?? discoverNetworkAddresses());
  } catch {
    return [];
  }
}

function discoverNetworkAddresses(): readonly WebNetworkAddress[] {
  const addresses: WebNetworkAddress[] = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.internal || info.family !== "IPv4") {
        continue;
      }
      const kind = classifyIpv4Address(info.address);
      if (kind !== undefined) {
        addresses.push({ address: info.address, kind });
      }
    }
  }
  return addresses;
}

function classifyIpv4Address(address: string): WebNetworkAddress["kind"] | undefined {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  const [first = -1, second = -1] = octets;
  if (first === 100 && second >= 64 && second <= 127) {
    return "tailscale";
  }
  if (
    first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
  ) {
    return "lan";
  }
  return undefined;
}

function dedupeNetworkAddresses(addresses: readonly WebNetworkAddress[]): readonly WebNetworkAddress[] {
  const seen = new Set<string>();
  return [...addresses]
    .filter((entry) => {
      if (seen.has(entry.address)) {
        return false;
      }
      seen.add(entry.address);
      return true;
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "lan" ? -1 : 1;
      }
      return left.address.localeCompare(right.address);
    });
}

/** Resolve + dedupe registry dirs, preserving precedence order. */
function dedupePaths(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const resolved = resolve(dir);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

/** Resolve once SIGINT/SIGTERM arrives — the foreground command's stop signal. */
function waitForSignal(): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolvePromise();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

/** Best-effort OS browser launch. Never throws into the caller's happy path. */
function openInBrowser(url: string): void {
  void (async () => {
    try {
      const { spawn } = await import("node:child_process");
      const platform = process.platform;
      const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
      const args = platform === "win32" ? ["/c", "start", "", url] : [url];
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => {
        /* no browser available — the URL was printed */
      });
      child.unref();
    } catch {
      /* ignore */
    }
  })();
}
