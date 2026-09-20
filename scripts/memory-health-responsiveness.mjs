#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);
const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

if (args.help === true) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const outputDir = optionalString(args.output);
const auditRoot = optionalString(args["audit-root"]);
const fixtureCount = optionalInteger(args["fixture-count"], "fixture-count", 1, 100_000);
const operatorUrl = optionalString(args.url);
if (auditRoot === undefined && fixtureCount === undefined && operatorUrl === undefined) {
  throw new Error("Select --audit-root, --fixture-count, or --url.\n\n" + usage());
}
if (auditRoot !== undefined && fixtureCount !== undefined) {
  throw new Error("Use only one of --audit-root and --fixture-count.");
}
if (outputDir !== undefined) await mkdir(outputDir, { recursive: true });

const report = {
  schema: "mono-agent.memory-health-responsiveness.v1",
  recordedAt: new Date().toISOString(),
};
let temporaryFixture;
try {
  if (auditRoot !== undefined || fixtureCount !== undefined) {
    let root = auditRoot;
    if (fixtureCount !== undefined) {
      temporaryFixture = await createFixture(fixtureCount);
      root = temporaryFixture;
    }
    report.audit = await auditProbe(root, {
      mode: optionalString(args["audit-mode"]) ?? "bujo",
      configuredEmbeddingModel: optionalString(args["embedding-model"])
        ?? (fixtureCount === undefined ? undefined : "responsiveness-probe:4"),
      configuredDimension: optionalInteger(args.dimension, "dimension", 1, 65_536)
        ?? (fixtureCount === undefined ? undefined : 4),
      fixtureCount,
    });
  }
  if (operatorUrl !== undefined) {
    report.operator = await operatorProbe(operatorUrl, {
      pid: optionalInteger(args.pid, "pid", 1, Number.MAX_SAFE_INTEGER),
      manifest: optionalString(args.manifest),
      intervalMs: integer(args["interval-ms"], 1_000, "interval-ms", 10, 60_000),
      timeoutMs: integer(args["timeout-ms"], 1_000, "timeout-ms", 10, 60_000),
      durationSeconds: integer(args["duration-seconds"], 360, "duration-seconds", 1, 86_400),
      outputDir,
    });
  }
} finally {
  if (temporaryFixture !== undefined) await rm(temporaryFixture, { recursive: true, force: true });
}

const encoded = `${JSON.stringify(report, null, 2)}\n`;
if (outputDir === undefined) process.stdout.write(encoded);
else {
  const reportPath = join(outputDir, "result.json");
  await writeFile(reportPath, encoded, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${reportPath}\n`);
}

async function auditProbe(root, options) {
  if (!new Set(["lite", "journal", "bujo"]).has(options.mode)) {
    throw new Error("--audit-mode must be lite, journal, or bujo.");
  }
  const workerUrl = new URL("../packages/agent-app/dist/memory-health-worker.js", import.meta.url);
  const workerStartedAt = performance.now();
  const worker = new Worker(workerUrl, { stdout: true, stderr: true });
  worker.stdout?.resume();
  worker.stderr?.resume();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  try {
    await waitForWorkerOnline(worker, 15_000);
    const workerStartupMs = performance.now() - workerStartedAt;
    const auditOptions = {
      root,
      mode: options.mode,
      maxStabilityAttempts: 1,
      ...(options.configuredEmbeddingModel === undefined
        ? {}
        : { configuredEmbeddingModel: options.configuredEmbeddingModel }),
      ...(options.configuredDimension === undefined
        ? {}
        : { configuredDimension: options.configuredDimension }),
    };
    const fullStartedAt = performance.now();
    const full = await requestAudit(worker, 1, auditOptions, 30_000);
    const fullAuditMs = performance.now() - fullStartedAt;
    const cachedStartedAt = performance.now();
    const cached = await requestAudit(worker, 2, auditOptions, 30_000);
    const canonicalCacheHitAuditMs = performance.now() - cachedStartedAt;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    return {
      ...(options.fixtureCount === undefined ? {} : { fixtureMemories: options.fixtureCount }),
      workerStartupMs: rounded(workerStartupMs),
      fullAuditMs: rounded(fullAuditMs),
      canonicalCacheHitAuditMs: rounded(canonicalCacheHitAuditMs),
      parentEventLoopDelayMs: delaySummary(delay),
      fullStatus: full.status,
      cacheHitStatus: cached.status,
    };
  } finally {
    delay.disable();
    await worker.terminate().catch(() => undefined);
  }
}

function waitForWorkerOnline(worker, timeoutMs) {
  return new Promise((resolveOnline, reject) => {
    const timer = setTimeout(() => finish(new Error("Memory health worker startup timed out.")), timeoutMs);
    timer.unref?.();
    const onOnline = () => finish();
    const onError = () => finish(new Error("Memory health worker startup failed."));
    const onExit = () => finish(new Error("Memory health worker exited during startup."));
    const finish = (error) => {
      clearTimeout(timer);
      worker.off("online", onOnline);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (error === undefined) resolveOnline();
      else reject(error);
    };
    worker.once("online", onOnline);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function requestAudit(worker, id, options, timeoutMs) {
  return new Promise((resolveAudit, reject) => {
    const timer = setTimeout(() => finish(new Error("Memory health audit timed out.")), timeoutMs);
    timer.unref?.();
    const onMessage = (value) => {
      if (value?.id !== id) return;
      if (value.type === "result" && value.report?.backend === "bujo") finish(undefined, value.report);
      else finish(new Error("Memory health worker returned an error or malformed response."));
    };
    const onError = () => finish(new Error("Memory health worker failed."));
    const onExit = () => finish(new Error("Memory health worker exited before returning a result."));
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (error === undefined) resolveAudit(value);
      else reject(error);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.postMessage({ type: "audit", id, options });
  });
}

async function operatorProbe(baseUrl, options) {
  if (options.timeoutMs > options.intervalMs) {
    throw new Error("--timeout-ms must not exceed --interval-ms so probes stay independently scheduled.");
  }
  const infoUrl = baseUrl.endsWith("/v1/info")
    ? new URL(baseUrl)
    : new URL("v1/info", `${baseUrl.replace(/\/+$/u, "")}/`);
  if (infoUrl.protocol !== "http:" && infoUrl.protocol !== "https:") {
    throw new Error("--url must use http or https.");
  }
  const token = process.env.MONO_AGENT_OPERATOR_TOKEN;
  const headers = token === undefined ? undefined : { authorization: `Bearer ${token}` };
  const startedAt = performance.now();
  const deadline = startedAt + options.durationSeconds * 1_000;
  const probes = [];
  let sampleCount = 0;
  let index = 0;
  while (performance.now() < deadline) {
    const scheduledAt = startedAt + index * options.intervalMs;
    index += 1;
    await sleep(Math.max(0, scheduledAt - performance.now()));
    if (performance.now() >= deadline) break;
    const probeStartedAt = performance.now();
    const wallTime = new Date().toISOString();
    let status;
    let outcome = "response";
    try {
      const response = await fetch(infoUrl, {
        headers,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch (error) {
      outcome = error?.name === "TimeoutError" ? "timeout" : "error";
      if (outcome === "timeout" && options.pid !== undefined && options.outputDir !== undefined && sampleCount < 3) {
        sampleCount += 1;
        await captureSample(options.pid, join(options.outputDir, `sample-${sampleCount}.txt`));
      }
    }
    const manifest = options.manifest === undefined ? undefined : await readManifestTiming(options.manifest);
    probes.push({
      at: wallTime,
      outcome,
      ...(status === undefined ? {} : { status }),
      latencyMs: rounded(performance.now() - probeStartedAt),
      ...(manifest === undefined ? {} : manifest),
    });
  }
  const latencies = probes.map((probe) => probe.latencyMs);
  return {
    requestedDurationSeconds: options.durationSeconds,
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
    probeCount: probes.length,
    timeoutCount: probes.filter((probe) => probe.outcome === "timeout").length,
    errorCount: probes.filter((probe) => probe.outcome === "error").length,
    maxLatencyMs: latencies.length === 0 ? 0 : Math.max(...latencies),
    probes,
  };
}

async function readManifestTiming(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const updatedAt = validDate(value?.updatedAt);
    const checkedAt = validDate(value?.memoryHealth?.checkedAt);
    return {
      ...(updatedAt === undefined ? {} : {
        traceUpdatedAt: updatedAt,
        traceAgeMs: Math.max(0, Date.now() - Date.parse(updatedAt)),
      }),
      ...(checkedAt === undefined ? {} : { memoryHealthCheckedAt: checkedAt }),
      ...(typeof value?.memoryHealth?.status === "string" ? { memoryHealthStatus: value.memoryHealth.status } : {}),
    };
  } catch {
    return { manifestRead: "unavailable" };
  }
}

async function captureSample(pid, outputPath) {
  try {
    await execFileAsync("/usr/bin/sample", [String(pid), "1", "1", "-file", outputPath], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Probe evidence already records the timeout. Sampling is best-effort and bounded.
  }
}

async function createFixture(count) {
  const root = await mkdtemp(join(tmpdir(), "memory-health-responsiveness-"));
  await mkdir(join(root, "daily"));
  const createdAt = "2026-01-01T00:00:00.000Z";
  const bullets = ["# 2026-01-01", ""];
  const graph = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(6, "0");
    const id = `M-${suffix}`;
    const name = `Entity${suffix}`;
    bullets.push(
      `- – ${name} durable fact`,
      `  <!--mem id=${id} type=note status=open salience=0.7 isInsight=0 created=${createdAt} refs=-->`,
    );
    graph.push(JSON.stringify({ kind: "entity", id: `entity:${suffix}`, name, createdAt }));
  }
  await Promise.all([
    writeFile(join(root, "daily", "2026-01-01.md"), `${bullets.join("\n")}\n`, "utf8"),
    writeFile(join(root, "graph.jsonl"), `${graph.join("\n")}\n`, "utf8"),
  ]);
  const { safeRebuildMemoryIndex } = await import(pathToFileURL(join(WORKTREE, "packages/memory/dist/bujo/index.js")));
  await safeRebuildMemoryIndex({
    root,
    tier: "bujo",
    embeddings: { id: "responsiveness-probe:4", embed: async (texts) => texts.map(() => [1, 0, 0, 0]) },
    dim: 4,
  });
  return root;
}

function delaySummary(histogram) {
  return {
    max: rounded(histogram.max / 1e6),
    p99: rounded(histogram.percentile(99) / 1e6),
    mean: rounded(histogram.mean / 1e6),
  };
}

function validDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      parsed.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate --${key}.`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function optionalString(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error("Argument values must be non-empty strings.");
  return value;
}

function integer(value, fallback, name, minimum, maximum) {
  return optionalInteger(value, name, minimum, maximum) ?? fallback;
}

function optionalInteger(value, name, minimum, maximum) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function usage() {
  return `Usage:
  node scripts/memory-health-responsiveness.mjs --fixture-count 3638 [--output DIR]
  node scripts/memory-health-responsiveness.mjs --audit-root DIR --audit-mode bujo [--embedding-model ID --dimension N] [--output DIR]
  MONO_AGENT_OPERATOR_TOKEN=... node scripts/memory-health-responsiveness.mjs --url URL \\
    [--pid PID --manifest FILE] [--interval-ms 1000 --timeout-ms 1000] \\
    [--duration-seconds 360] [--output DIR]

The audit probe reports worker startup, first full audit, canonical-cache-hit audit,
and parent-process event-loop delay separately. The operator probe records bounded
/v1/info latency plus trace heartbeat and memory-health timestamps. On at most
three timeouts, macOS sample output is captured when both --pid and --output are
provided. The bearer token is read only from MONO_AGENT_OPERATOR_TOKEN.`;
}
