import { isAbsolute, resolve } from "node:path";

import {
  isLoopbackHost,
  parseMonitorProjection,
  parseMonitorProjections,
  type MonitorProjection,
} from "@mono-agent/agent-contracts";
import { listTraceSources, type TraceSourceListItem } from "@mono-agent/observability";

import { readBoundedOwnerOnlyFile } from "./continuation-store-fs.js";
import { discoverJobsSource } from "./jobs-command.js";
import { monitorOperatorToken } from "./monitors-store.js";
import { PROCESS_JOB_SECRET_FILE } from "./process-jobs-store.js";
import { tuiEndpointOf } from "./tui-command.js";

/** Monitor projections carry no output, so a live agent's whole list stays small. */
const MAX_MONITORS_RESPONSE_BYTES = 1024 * 1024;

export interface RunMonitorsCommandOptions {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
  readonly positionals: readonly string[];
  readonly agent?: string;
  readonly json?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly listSources?: typeof listTraceSources;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

/**
 * Authenticated, loopback-only monitor operator client for one live agent.
 *
 * Deliberately a separate command rather than a `--kind` flag on `jobs`: a
 * monitor and a background job share a state root but nothing else — different
 * states, different counters, different bearer — and one command that renders
 * two unrelated projections reads worse than two that each render one.
 */
export async function runMonitorsCommand(options: RunMonitorsCommandOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const [action = "list", monitorId, ...extra] = options.positionals;
  if (extra.length > 0 || !validUsage(action, monitorId)) {
    stderr("Usage: mono-agent monitors [list|get <monitor-id>|cancel <monitor-id>] [--agent <label|sourceId>] [--json]\n");
    return 2;
  }

  let source: TraceSourceListItem;
  try {
    source = await discoverJobsSource(options);
  } catch (error) {
    return writeFailure(stderr, options.json === true, codeOf(error) ?? "agent_unreachable", reasonOf(error));
  }

  const baseUrlValue = tuiEndpointOf(source);
  if (baseUrlValue === undefined) {
    return writeFailure(stderr, options.json === true, "agent_unreachable", "The selected agent has no running operator endpoint.");
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    return writeFailure(stderr, options.json === true, "agent_unreachable", "The selected agent advertised an invalid operator endpoint.");
  }
  if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    || !isLoopbackHost(baseUrl.hostname)
    || baseUrl.username.length > 0
    || baseUrl.password.length > 0) {
    return writeFailure(stderr, options.json === true, "remote_refused", "Monitor operator commands refuse non-loopback endpoints.");
  }

  let token: string;
  try {
    const stateDir = monitorStateDir(source);
    if (stateDir === undefined) {
      throw coded("monitor_disabled", "The selected live agent has no monitor controller.");
    }
    token = monitorOperatorToken(await readOwnerSecret(resolve(stateDir, PROCESS_JOB_SECRET_FILE)));
  } catch (error) {
    return writeFailure(
      stderr,
      options.json === true,
      codeOf(error) ?? "agent_unreachable",
      `Monitor operator credentials are unavailable: ${reasonOf(error)}`,
    );
  }

  let response: Response;
  try {
    response = await request(
      options.fetchImpl ?? fetch,
      baseUrl.toString().replace(/\/$/u, ""),
      token,
      action,
      monitorId,
    );
  } catch (error) {
    return writeFailure(stderr, options.json === true, "agent_unreachable", `Agent is unreachable: ${reasonOf(error)}`);
  }
  let body: unknown;
  try {
    body = await readBoundedJson(response);
  } catch (error) {
    return writeFailure(
      stderr,
      options.json === true,
      codeOf(error) ?? "monitor_invalid",
      `Agent returned an invalid monitor response: ${reasonOf(error)}`,
    );
  }
  if (!response.ok) {
    return writeFailure(stderr, options.json === true, errorCode(body) ?? "monitor_invalid", errorMessage(body, response.status));
  }
  try {
    const result = action === "list"
      ? { monitors: parseMonitorProjections(recordOf(body)?.monitors) }
      : parseMonitorProjection(body);
    stdout(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : renderHuman(action, result));
    return 0;
  } catch (error) {
    return writeFailure(stderr, options.json === true, "monitor_invalid", `Agent returned an invalid monitor projection: ${reasonOf(error)}`);
  }
}

async function request(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  action: string,
  monitorId?: string,
): Promise<Response> {
  const headers = { authorization: `Bearer ${token}` };
  if (action === "list") return await fetchImpl(`${baseUrl}/v1/monitors`, { headers, redirect: "error" });
  const path = `${baseUrl}/v1/monitors/${encodeURIComponent(monitorId as string)}`;
  return await fetchImpl(action === "cancel" ? `${path}/cancel` : path, {
    ...(action === "cancel" ? { method: "POST" } : {}),
    headers,
    redirect: "error",
  });
}

function validUsage(action: string, monitorId: string | undefined): boolean {
  return action === "list"
    ? monitorId === undefined
    : (action === "get" || action === "cancel")
      && monitorId !== undefined
      && monitorId.trim().length > 0
      && monitorId.length <= 256;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw coded("monitor_invalid", "response body is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MONITORS_RESPONSE_BYTES) {
        throw coded(
          "monitor_response_too_large",
          `response exceeds ${String(MAX_MONITORS_RESPONSE_BYTES)} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")) as unknown;
}

function renderHuman(
  action: string,
  result: MonitorProjection | { readonly monitors: readonly MonitorProjection[] },
): string {
  if (action !== "list") {
    const monitor = result as MonitorProjection;
    return `${monitor.monitorId}: ${monitor.state}${monitor.persistent ? " (persistent)" : ""} ${monitor.description}\n`;
  }
  const monitors = (result as { readonly monitors: readonly MonitorProjection[] }).monitors;
  if (monitors.length === 0) return "No monitors recorded.\n";
  return [
    "MONITOR                              STATE        SEQ   DROPPED  STARTED                  DESCRIPTION",
    ...monitors.map((monitor) => [
      monitor.monitorId.padEnd(36),
      monitor.state.padEnd(12),
      String(monitor.counters.seq).padEnd(5),
      String(monitor.counters.droppedLines).padEnd(8),
      monitor.timestamps.startedAt.padEnd(24),
      monitor.description,
    ].join(" ")),
    "",
  ].join("\n");
}

async function readOwnerSecret(path: string): Promise<Buffer> {
  const encoded = (await readBoundedOwnerOnlyFile(path, 256, "Monitor operator secret")).trim();
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
    throw new Error("secret contents are invalid");
  }
  return secret;
}

/**
 * Monitors share the process-job protected state root, so the live agent
 * advertises exactly one state directory and both operator surfaces read the
 * same owner-private secret file under different HMAC labels.
 */
function monitorStateDir(source: TraceSourceListItem): string | undefined {
  const channels = recordOf(source.metadata?.channels);
  const tui = recordOf(channels?.tui);
  const monitors = recordOf(tui?.monitors);
  if (monitors === undefined || tui?.kind !== "running") return undefined;
  // The monitor service publishes the root it actually opened. Falling back to
  // the process-job entry keeps an older live agent readable, but a monitor
  // controller that is up while process-job publication is degraded must still
  // be operable.
  const value = monitors.stateDir ?? recordOf(tui.processJobs)?.stateDir;
  return typeof value === "string" && isAbsolute(value) && value.length <= 16_384
    ? resolve(value)
    : undefined;
}

function writeFailure(stderr: (text: string) => void, json: boolean, code: string, message: string): number {
  stderr(json ? `${JSON.stringify({ error: { code, message } })}\n` : `${code}: ${message}\n`);
  return 1;
}

function coded(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function reasonOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function errorCode(value: unknown): string | undefined {
  const error = recordOf(recordOf(value)?.error);
  return typeof error?.code === "string" ? error.code : undefined;
}
function errorMessage(value: unknown, status: number): string {
  const error = recordOf(recordOf(value)?.error);
  return typeof error?.message === "string" ? error.message : `HTTP ${String(status)}`;
}
