import { resolve } from "node:path";

import { pruneTraceSources } from "@mono-agent/observability";
import { startSessionWebServer } from "@mono-agent/session-web";
import type { SessionWebServerHandle } from "@mono-agent/session-web";
import { generateBearerToken, isLoopbackHost } from "@mono-agent/agent-contracts";

import { resolveAppTraceRegistryDir, resolveGlobalTraceRegistryDir } from "./app-config.js";

export const DEFAULT_WEB_PORT = 4599;

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
  /** --include-memory: show memory-maintenance runs in the web operator surface. */
  readonly includeMemory?: boolean;
}

/** Test seams: server boot, browser open, and the shutdown wait are injectable. */
export interface RunWebDeps {
  readonly startServer?: typeof startSessionWebServer;
  readonly openUrl?: (url: string) => void;
  readonly waitForShutdown?: () => Promise<void>;
  readonly onReady?: (handle: SessionWebServerHandle) => void;
  readonly stdout?: { write(text: string): void };
  readonly stderr?: { write(text: string): void };
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
  const authToken = requiresServerAuth(options.host) ? generateBearerToken() : undefined;
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
    });
  } catch (error) {
    stderr.write(`mono-agent web failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const browserUrl = authToken === undefined ? handle.url : withAuthToken(handle.url, authToken);
  stdout.write(`mono-agent web  →  ${browserUrl}\n`);
  stdout.write(
    `Watching ${registryDirs.length} registr${registryDirs.length === 1 ? "y" : "ies"} for agents. Press Ctrl-C to stop.\n`,
  );
  stdout.write(`${reverseProxyHint(handle.url)}\n`);
  stdout.write(`${reachabilityHint(handle.url)}\n`);

  if (options.open ?? true) {
    try {
      (deps.openUrl ?? openInBrowser)(browserUrl);
    } catch {
      // Best-effort: a headless host without a browser is fine — the URL is printed.
    }
  }

  deps.onReady?.(handle);
  await (deps.waitForShutdown ?? waitForSignal)();
  await handle.stop();
  stdout.write("mono-agent web stopped.\n");
  return 0;
}

/**
 * A one-line hint about who can reach the server and how to expose it over a
 * tailnet. Loopback (default) → recommend `tailscale serve` (adds HTTPS + a
 * MagicDNS name, keeping the PWA installable). Non-loopback → note it is already
 * reachable over the LAN/tailnet at this port.
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
    return "Bound non-loopback: reachable over your LAN/Tailnet at this port (use the machine's Tailscale IP or MagicDNS name). For HTTPS + a PWA-installable URL, prefer `tailscale serve` instead.";
  }
  return `Loopback only. To reach it over Tailscale with HTTPS + your MagicDNS name (keeps the PWA installable): tailscale serve --bg ${port || "<port>"}`;
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
