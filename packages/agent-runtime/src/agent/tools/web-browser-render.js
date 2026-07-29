// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { passthroughSandbox } from "../sandbox-seam.js";
import { runPreparedProcess } from "./shared/process-runner.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

const BROWSER_TIMEOUT_MS = 20_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_BROWSER_NAMESPACE_CHARS = 16;

/**
 * Render one public page in a fresh anonymous agent-browser session.
 *
 * @param {string} url
 * @param {{browserCommand?: string, namespace?: string, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, signal?: AbortSignal, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} [options]
 */
export async function renderWithAgentBrowser(
  url,
  {
    browserCommand = "agent-browser",
    namespace = "mono-agent-web",
    sandboxPolicy,
    sandboxEngine,
    ctx,
    signal,
    registerCleanup,
  } = {},
) {
  const parsed = new URL(url);
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const workspace = resolve(resolvedCtx.workspace || process.cwd());
  const browserNamespace = compactBrowserNamespace(namespace);
  const session = `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const allowedDomains = browserAllowedDomains(parsed.hostname);
  let tempDir = null;
  let unregister = () => {};
  let closed = false;

  async function closeSession() {
    if (closed) return;
    closed = true;
    try {
      await run(["close"], BROWSER_CLOSE_TIMEOUT_MS, null);
    } catch { /* best-effort browser teardown */ }
    if (tempDir !== null) {
      try { await rm(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    unregister();
  }

  /**
   * @param {string[]} commandArgs
   * @param {number} [timeoutMs]
   * @param {AbortSignal|null} [abortSignal]
   */
  async function run(commandArgs, timeoutMs = BROWSER_TIMEOUT_MS, abortSignal = signal) {
    if (tempDir === null) throw new Error("agent-browser isolated config is not initialized");
    const configPath = join(tempDir, "agent-browser.json");
    const baseArgs = [
      "--namespace",
      browserNamespace,
      "--session",
      session,
      "--config",
      configPath,
      "--allowed-domains",
      allowedDomains,
      "--content-boundaries",
      "--max-output",
      String(BROWSER_OUTPUT_BYTES),
      "--json",
    ];
    const prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
      command: {
        command: browserCommand,
        args: [...baseArgs, ...commandArgs],
        cwd: workspace,
        env: {
          // Delete every documented agent-browser behavior/auth/persistence
          // override inherited from the host. Empty strings are not safe here:
          // agent-browser treats some of them (notably SESSION_NAME) as
          // configured-but-invalid values.
          AGENT_BROWSER_ACTION_POLICY: undefined,
          AGENT_BROWSER_ALLOWED_DOMAINS: undefined,
          AGENT_BROWSER_ANNOTATE: undefined,
          AGENT_BROWSER_ARGS: undefined,
          AGENT_BROWSER_COLOR_SCHEME: undefined,
          AGENT_BROWSER_CONFIRM_ACTIONS: undefined,
          AGENT_BROWSER_CONFIRM_INTERACTIVE: undefined,
          AGENT_BROWSER_CONTENT_BOUNDARIES: undefined,
          AGENT_BROWSER_DEFAULT_TIMEOUT: undefined,
          AGENT_BROWSER_DOWNLOAD_PATH: undefined,
          AGENT_BROWSER_ENABLE: undefined,
          AGENT_BROWSER_ENCRYPTION_KEY: undefined,
          AGENT_BROWSER_ENGINE: undefined,
          AGENT_BROWSER_EXECUTABLE_PATH: undefined,
          AGENT_BROWSER_EXTENSIONS: undefined,
          AGENT_BROWSER_HEADED: undefined,
          AGENT_BROWSER_HIDE_SCROLLBARS: undefined,
          AGENT_BROWSER_IDLE_TIMEOUT_MS: undefined,
          AGENT_BROWSER_INIT_SCRIPTS: undefined,
          AGENT_BROWSER_IOS_DEVICE: undefined,
          AGENT_BROWSER_IOS_UDID: undefined,
          AGENT_BROWSER_MAX_OUTPUT: undefined,
          AGENT_BROWSER_NAMESPACE: undefined,
          AGENT_BROWSER_NO_AUTO_DIALOG: undefined,
          AGENT_BROWSER_NO_XVFB: undefined,
          AGENT_BROWSER_PLUGINS: undefined,
          AGENT_BROWSER_PROFILE: undefined,
          AGENT_BROWSER_PROVIDER: undefined,
          AGENT_BROWSER_PROXY: undefined,
          AGENT_BROWSER_PROXY_BYPASS: undefined,
          AGENT_BROWSER_RESTORE: undefined,
          AGENT_BROWSER_RESTORE_CHECK_FN: undefined,
          AGENT_BROWSER_RESTORE_CHECK_TEXT: undefined,
          AGENT_BROWSER_RESTORE_CHECK_URL: undefined,
          AGENT_BROWSER_SCREENSHOT_DIR: undefined,
          AGENT_BROWSER_SCREENSHOT_FORMAT: undefined,
          AGENT_BROWSER_SCREENSHOT_QUALITY: undefined,
          AGENT_BROWSER_SESSION: undefined,
          AGENT_BROWSER_SESSION_NAME: undefined,
          AGENT_BROWSER_SKILLS_DIR: undefined,
          AGENT_BROWSER_SOCKET_DIR: undefined,
          AGENT_BROWSER_STATE: undefined,
          AGENT_BROWSER_STATE_EXPIRE_DAYS: undefined,
          AGENT_BROWSER_STREAM_PORT: undefined,
          AGENT_BROWSER_USER_AGENT: undefined,
          AGENT_BROWSER_WEBGPU: undefined,
          AGENT_BROWSER_AUTO_CONNECT: "false",
          AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
          AGENT_BROWSER_CDP: undefined,
          AGENT_BROWSER_CONFIG: configPath,
          AGENT_BROWSER_RESTORE_SAVE: "never",
          NO_COLOR: "1",
        },
      },
    });
    try {
      const result = await runPreparedProcess(prepared, {
        timeoutMs,
        signal: abortSignal,
        maxBufferBytes: BROWSER_OUTPUT_BYTES,
      });
      if (result.timedOut) throw new Error(`agent-browser timed out after ${timeoutMs}ms`);
      if (result.aborted) throw new Error("agent-browser was aborted");
      if (result.bufferExceeded) throw new Error("agent-browser output exceeded its byte limit");
      if (result.spawnError) throw result.spawnError;
      if (result.signal) throw new Error(`agent-browser terminated by ${result.signal}`);
      if (result.code !== 0) {
        throw new Error(`agent-browser exited ${result.code}: ${String(result.stderr || result.stdout).trim()}`);
      }
      return String(result.stdout || "").trim();
    } finally {
      await prepared.cleanup?.();
    }
  }

  try {
    tempDir = await mkdtemp(join(workspace, ".mono-agent-web-"));
    await writeFile(join(tempDir, "agent-browser.json"), "{}\n", { encoding: "utf8", mode: 0o600 });
    unregister = registerCleanup?.(closeSession) ?? (() => {});
    await run(["open", parsed.href]);
    await run(["wait", "--load", "domcontentloaded"]);
    const output = await run(["read"]);
    const text = extractBrowserText(output);
    if (!text) throw new Error("agent-browser returned no readable rendered content");
    return text;
  } finally {
    await closeSession();
  }
}

function compactBrowserNamespace(value) {
  const candidate = String(value || "").trim();
  if (/^[A-Za-z0-9_-]+$/u.test(candidate) && candidate.length <= MAX_BROWSER_NAMESPACE_CHARS) {
    return candidate;
  }
  const digest = createHash("sha256").update(candidate).digest("hex").slice(0, 10);
  return `mw-${digest}`;
}

export function extractBrowserText(output) {
  const raw = String(output || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return findText(parsed) || "";
  } catch {
    return raw;
  }
}

function findText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((entry) => findText(entry, depth + 1)).filter(Boolean).join("\n").trim();
  }
  if (typeof value !== "object") return "";
  for (const key of ["markdown", "content", "text", "result", "output", "data"]) {
    if (!(key in value)) continue;
    const text = findText(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function browserAllowedDomains(hostname) {
  const host = hostname.toLowerCase();
  if (host.includes(":") || /^\d+(?:\.\d+){3}$/u.test(host)) return host;
  return `${host},*.${host}`;
}
