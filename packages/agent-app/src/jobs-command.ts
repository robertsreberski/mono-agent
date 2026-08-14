import { createHmac } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  isLoopbackHost,
  parseProcessJobProjection,
  parseProcessJobProjections,
  type ProcessJobProjection,
} from "@mono-agent/agent-contracts";
import { listTraceSources, mergeTraceSources, type TraceSourceListItem } from "@mono-agent/observability";

import { resolveAppTraceRegistryDir, resolveGlobalTraceRegistryDir } from "./app-config.js";
import { readBoundedOwnerOnlyFile } from "./continuation-store-fs.js";
import { PROCESS_JOB_SECRET_FILE } from "./process-jobs-store.js";
import { tuiEndpointOf } from "./tui-command.js";

const MAX_PROCESS_JOBS_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface RunJobsCommandOptions {
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

/** Authenticated, loopback-only operator client for one discovered live agent. */
export async function runJobsCommand(options: RunJobsCommandOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const [action = "list", jobId, ...extra] = options.positionals;
  if (extra.length > 0 || !validUsage(action, jobId)) {
    stderr("Usage: mono-agent jobs [list|get <job-id>|cancel <job-id>] [--agent <label|sourceId>] [--json]\n");
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
  if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || !isLoopbackHost(baseUrl.hostname)) {
    return writeFailure(stderr, options.json === true, "remote_refused", "Process-job operator commands refuse non-loopback endpoints.");
  }
  let token: string;
  try {
    const stateDir = processJobsStateDir(source);
    if (stateDir === undefined) {
      throw coded("process_job_disabled", "The selected live agent has no process-job controller.");
    }
    token = operatorToken(await readOwnerSecret(resolve(stateDir, PROCESS_JOB_SECRET_FILE)));
  } catch (error) {
    return writeFailure(stderr, options.json === true, codeOf(error) ?? "agent_unreachable", `Process-job operator credentials are unavailable: ${reasonOf(error)}`);
  }

  let response: Response;
  try {
    response = await request(options.fetchImpl ?? fetch, baseUrl.toString().replace(/\/$/u, ""), token, action, jobId);
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
      codeOf(error) ?? "process_job_invalid",
      `Agent returned an invalid process-job response: ${reasonOf(error)}`,
    );
  }
  if (!response.ok) {
    return writeFailure(stderr, options.json === true, errorCode(body) ?? "process_job_invalid", errorMessage(body, response.status));
  }
  try {
    const result = action === "list"
      ? { jobs: parseProcessJobProjections(recordOf(body)?.jobs) }
      : parseProcessJobProjection(body);
    stdout(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : renderHuman(action, result));
    return 0;
  } catch (error) {
    return writeFailure(stderr, options.json === true, "process_job_invalid", `Agent returned an invalid process-job projection: ${reasonOf(error)}`);
  }
}

export async function discoverJobsSource(options: Pick<RunJobsCommandOptions, "cwd" | "configPath" | "env" | "agent" | "listSources">): Promise<TraceSourceListItem> {
  const configuredRegistry = await resolveAppTraceRegistryDir({
    cwd: options.cwd,
    configPath: options.configPath,
    env: options.env,
  });
  const globalRegistry = resolveGlobalTraceRegistryDir(options.env);
  const list = options.listSources ?? listTraceSources;
  const primary = await list({ registryDir: configuredRegistry });
  const secondary = resolve(primary.registryDir) === resolve(globalRegistry)
    ? undefined
    : await list({ registryDir: globalRegistry });
  const sources = secondary === undefined
    ? primary.sources
    : mergeTraceSources(primary.sources, secondary.sources);
  const live = sources.filter((entry) => entry.health !== "stopped" && entry.status !== "stopped");
  if (options.agent !== undefined) {
    const selected = live.find((entry) => entry.label === options.agent || entry.sourceId === options.agent);
    if (selected === undefined) throw coded("agent_unreachable", `No running agent matches ${options.agent}.`);
    return selected;
  }
  const configuredPath = resolve(options.configPath);
  const configured = live.filter((entry) => entry.configPath !== undefined && resolve(entry.configPath) === configuredPath);
  if (configured.length === 1 && configured[0] !== undefined) return configured[0];
  if (configured.length > 1) throw coded("agent_unreachable", "Multiple running agents claim this config; select one with --agent.");
  if (live.length === 1 && live[0] !== undefined) return live[0];
  if (live.length === 0) throw coded("agent_unreachable", "No running local agents were discovered.");
  throw coded("agent_unreachable", "Multiple running agents were discovered; select one with --agent.");
}

async function request(fetchImpl: typeof fetch, baseUrl: string, token: string, action: string, jobId?: string): Promise<Response> {
  const headers = { authorization: `Bearer ${token}` };
  if (action === "list") return await fetchImpl(`${baseUrl}/v1/jobs`, { headers });
  const path = `${baseUrl}/v1/jobs/${encodeURIComponent(jobId as string)}`;
  return await fetchImpl(action === "cancel" ? `${path}/cancel` : path, {
    ...(action === "cancel" ? { method: "POST" } : {}),
    headers,
  });
}

function validUsage(action: string, jobId: string | undefined): boolean {
  return action === "list"
    ? jobId === undefined
    : (action === "get" || action === "cancel")
      && jobId !== undefined
      && jobId.trim().length > 0
      && jobId.length <= 256;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw coded("process_job_invalid", "response body is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROCESS_JOBS_RESPONSE_BYTES) {
        throw coded(
          "process_job_response_too_large",
          `response exceeds ${String(MAX_PROCESS_JOBS_RESPONSE_BYTES)} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")) as unknown;
}

function renderHuman(action: string, result: ProcessJobProjection | { readonly jobs: readonly ProcessJobProjection[] }): string {
  if (action !== "list") {
    const job = result as ProcessJobProjection;
    return `${job.jobId}: ${job.state} ${job.tool} ${job.summary}\n`;
  }
  const jobs = (result as { readonly jobs: readonly ProcessJobProjection[] }).jobs;
  if (jobs.length === 0) return "No process jobs recorded.\n";
  return [
    "JOB                                  STATE          TOOL  ADMITTED                 SUMMARY",
    ...jobs.map((job) => `${job.jobId.padEnd(36)} ${job.state.padEnd(14)} ${job.tool.padEnd(5)} ${job.timestamps.admittedAt.padEnd(24)} ${job.summary}`),
    "",
  ].join("\n");
}

async function readOwnerSecret(path: string): Promise<Buffer> {
  const encoded = (await readBoundedOwnerOnlyFile(path, 256, "Process-job operator secret")).trim();
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) throw new Error("secret contents are invalid");
  return secret;
}

function processJobsStateDir(source: TraceSourceListItem): string | undefined {
  const channels = recordOf(source.metadata?.channels);
  const tui = recordOf(channels?.tui);
  const processJobs = recordOf(tui?.processJobs);
  const value = processJobs?.stateDir;
  return tui?.kind === "running" && typeof value === "string" && isAbsolute(value) && value.length <= 16_384
    ? resolve(value)
    : undefined;
}

function operatorToken(secret: Uint8Array): string {
  return createHmac("sha256", secret).update("mono-agent-process-job-operator-v1").digest("base64url");
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
function recordOf(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function errorCode(value: unknown): string | undefined { const error = recordOf(recordOf(value)?.error); return typeof error?.code === "string" ? error.code : undefined; }
function errorMessage(value: unknown, status: number): string { const error = recordOf(recordOf(value)?.error); return typeof error?.message === "string" ? error.message : `HTTP ${String(status)}`; }
