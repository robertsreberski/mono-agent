// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { passthroughSandbox } from "../sandbox-seam.js";
import { runPreparedProcess } from "./shared/process-runner.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";
import { assertNoWebAccessInterstitial } from "./web-access-interstitial.js";

const BROWSER_TIMEOUT_MS = 20_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_BROWSER_NAMESPACE_CHARS = 16;
const BROWSER_HOST_ENV_KEYS = [
  "COMSPEC", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "PATHEXT",
  "SHELL", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USER", "WINDIR",
];
const BLOCKED_BROWSER_ENV_KEYS = [
  "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "all_proxy", "http_proxy", "https_proxy", "no_proxy",
  "AGENT_BROWSER_ACTION_POLICY", "AGENT_BROWSER_ALLOWED_DOMAINS", "AGENT_BROWSER_ALLOW_FILE_ACCESS",
  "AGENT_BROWSER_ANNOTATE", "AGENT_BROWSER_ARGS", "AGENT_BROWSER_CDP", "AGENT_BROWSER_COLOR_SCHEME",
  "AGENT_BROWSER_CONFIRM_ACTIONS", "AGENT_BROWSER_CONFIRM_INTERACTIVE", "AGENT_BROWSER_CONTENT_BOUNDARIES",
  "AGENT_BROWSER_DEFAULT_TIMEOUT", "AGENT_BROWSER_DOWNLOAD_PATH", "AGENT_BROWSER_ENABLE",
  "AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_ENGINE", "AGENT_BROWSER_EXECUTABLE_PATH",
  "AGENT_BROWSER_EXTENSIONS", "AGENT_BROWSER_HEADED", "AGENT_BROWSER_HIDE_SCROLLBARS",
  "AGENT_BROWSER_IDLE_TIMEOUT_MS", "AGENT_BROWSER_IGNORE_HTTPS_ERRORS", "AGENT_BROWSER_INIT_SCRIPTS",
  "AGENT_BROWSER_IOS_DEVICE", "AGENT_BROWSER_IOS_UDID", "AGENT_BROWSER_MAX_OUTPUT",
  "AGENT_BROWSER_NAMESPACE", "AGENT_BROWSER_NO_AUTO_DIALOG", "AGENT_BROWSER_NO_XVFB",
  "AGENT_BROWSER_PLUGINS", "AGENT_BROWSER_PROFILE", "AGENT_BROWSER_PROVIDER", "AGENT_BROWSER_PROXY",
  "AGENT_BROWSER_PROXY_BYPASS", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_RESTORE_CHECK_FN",
  "AGENT_BROWSER_RESTORE_CHECK_TEXT", "AGENT_BROWSER_RESTORE_CHECK_URL", "AGENT_BROWSER_SANDBOX_VERSION",
  "AGENT_BROWSER_SCREENSHOT_DIR", "AGENT_BROWSER_SCREENSHOT_FORMAT", "AGENT_BROWSER_SCREENSHOT_QUALITY",
  "AGENT_BROWSER_SESSION", "AGENT_BROWSER_SESSION_NAME", "AGENT_BROWSER_SKILLS_DIR",
  "AGENT_BROWSER_SNAPSHOT_ID", "AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_STATE",
  "AGENT_BROWSER_STATE_EXPIRE_DAYS", "AGENT_BROWSER_STREAM_PORT", "AGENT_BROWSER_USER_AGENT",
  "AGENT_BROWSER_WEBGPU",
];

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
  const renderDeadlineAt = Date.now() + BROWSER_TIMEOUT_MS;

  function remainingRenderMs() {
    const remaining = renderDeadlineAt - Date.now();
    if (remaining <= 0) throw Object.assign(new Error(`agent-browser timed out after ${BROWSER_TIMEOUT_MS}ms`), { code: "browser_render_failed" });
    return remaining;
  }

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
          ...isolatedBrowserEnvironment(),
          AGENT_BROWSER_AUTO_CONNECT: "false",
          AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
          AGENT_BROWSER_CONFIG: configPath,
          AGENT_BROWSER_RESTORE_SAVE: "never",
          NO_COLOR: "1",
        },
      },
    });
    try {
      const result = await runPreparedProcess({
        ...prepared,
        env: isolatedBrowserEnvironment(prepared.env, configPath),
      }, {
        timeoutMs,
        signal: abortSignal,
        maxBufferBytes: BROWSER_OUTPUT_BYTES,
        exactEnvironment: true,
      });
      if (result.timedOut) throw new Error(`agent-browser timed out after ${timeoutMs}ms`);
      if (result.aborted) throw new Error("agent-browser was aborted");
      if (result.bufferExceeded) throw new Error("agent-browser output exceeded its byte limit");
      if (result.spawnError) throw result.spawnError;
      if (result.signal) throw new Error(`agent-browser terminated by ${result.signal}`);
      if (result.code !== 0) {
        throw new Error(`agent-browser exited ${result.code}`);
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
    await run(["open", parsed.href], remainingRenderMs());
    await run(["wait", "--load", "domcontentloaded"], remainingRenderMs());
    const finalUrlOutput = await run(["get", "url"], remainingRenderMs());
    const finalUrl = validateFinalUrl(extractBrowserText(finalUrlOutput), parsed, sandbox, policy);
    const output = await run(["read"], remainingRenderMs());
    const text = extractBrowserText(output);
    if (!text) throw new Error("agent-browser returned no readable rendered content");
    assertNoWebAccessInterstitial({ url: finalUrl, text });
    return { text, finalUrl };
  } finally {
    await closeSession();
  }
}

function validateFinalUrl(value, requested, sandbox, policy) {
  let finalUrl;
  try { finalUrl = new URL(String(value || "").trim()); }
  catch { throw Object.assign(new Error("agent-browser returned an invalid final URL"), { code: "browser_render_failed" }); }
  if (!["http:", "https:"].includes(finalUrl.protocol) || finalUrl.username || finalUrl.password) {
    throw Object.assign(new Error("agent-browser navigated to an unsupported final URL"), { code: "network_denied" });
  }
  const requestedHost = requested.hostname.toLowerCase();
  const finalHost = finalUrl.hostname.toLowerCase();
  if (!(finalHost === requestedHost || finalHost.endsWith(`.${requestedHost}`))
    || !sandbox.networkAllowsUrl(policy, finalUrl.href)) {
    throw Object.assign(new Error("agent-browser final URL is outside the allowed domain policy"), { code: "network_denied" });
  }
  return finalUrl.href;
}

function isolatedBrowserEnvironment(source = process.env, configPath) {
  /** @type {Record<string, string|undefined>} */
  const env = {};
  for (const key of BROWSER_HOST_ENV_KEYS) {
    const value = source?.[key];
    if (value !== undefined) env[key] = value;
  }
  // Undefined means deletion to the sandbox seam. runPreparedProcess then
  // receives this map as an exact environment, so omitted host variables
  // cannot reappear during its ordinary process.env merge.
  for (const key of BLOCKED_BROWSER_ENV_KEYS) env[key] = undefined;
  env.AGENT_BROWSER_AUTO_CONNECT = "false";
  env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS = "0";
  if (configPath !== undefined) env.AGENT_BROWSER_CONFIG = configPath;
  env.AGENT_BROWSER_RESTORE_SAVE = "never";
  env.NO_COLOR = "1";
  return env;
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
  for (const key of ["markdown", "content", "text", "url", "result", "output", "data"]) {
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
