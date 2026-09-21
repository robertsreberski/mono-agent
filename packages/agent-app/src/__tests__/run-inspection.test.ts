import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../cli.js";
import { runInspection } from "../run-inspection.js";

const tempDirs: string[] = [];
const CREDENTIAL = `sk-${"A".repeat(48)}`;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-run-inspection-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runs list/show diagnostics", () => {
  it("lists at most 50 newest agent runs while preserving totalRuns and source metadata", async () => {
    const artifacts = await tempDir();
    await mkdir(join(artifacts, "memory"), { recursive: true });
    for (let index = 0; index < 52; index += 1) {
      await writeSummary(artifacts, `run-${String(index)}`, {
        source: index === 51 ? "web" : "telegram",
        sourceDetail: index === 51 ? "operator" : undefined,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    }
    await writeSummary(join(artifacts, "memory"), "mem-only", {
      conversationId: "memory:capture",
      source: "memory",
      updatedAt: "2027-01-01T00:00:00.000Z",
    });

    const result = await captureCli(() => runCli(["runs", "list", "--artifacts", artifacts, "--json"]));
    const body = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly totalRuns: number;
      readonly runs: readonly Record<string, unknown>[];
      readonly warnings: readonly string[];
    };

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(body.ok).toBe(true);
    expect(body.totalRuns).toBe(52);
    expect(body.runs).toHaveLength(50);
    expect(body.runs[0]).toMatchObject({
      runId: "run-51",
      source: "web",
      sourceDetail: "operator",
      summaryFileName: "run-51.summary.json",
    });
    expect(body.runs.some((run) => run.runId === "mem-only")).toBe(false);
    expect(body.warnings).toEqual([]);
  });

  it("includes memory summaries only on request and keeps their namespace visible", async () => {
    const artifacts = await tempDir();
    await mkdir(join(artifacts, "memory"), { recursive: true });
    await writeSummary(artifacts, "agent-run", { source: "web" });
    await writeSummary(join(artifacts, "memory"), "mem-run", {
      conversationId: "memory:capture",
      source: "memory",
    });

    const result = await captureCli(() => runCli([
      "runs", "list", "--artifacts", artifacts, "--include-memory", "--json",
    ]));
    const body = JSON.parse(result.stdout) as {
      readonly totalRuns: number;
      readonly runs: readonly { readonly runId: string; readonly source?: string; readonly summaryFileName?: string }[];
    };
    const memory = body.runs.find((run) => run.runId === "mem-run");

    expect(result.code).toBe(0);
    expect(body.totalRuns).toBe(2);
    expect(memory).toMatchObject({ source: "memory", summaryFileName: "memory/mem-run.summary.json" });
  });

  it("shows capped head/tail events with output-boundary redaction, control escaping, and numeric usage", async () => {
    const artifacts = await tempDir();
    const longText = "x".repeat(40_000);
    await writeSummary(artifacts, "safe-run", {
      conversationId: "conversation\u001b[2J\u202e",
      source: "web\u2028source",
      userInput: `credential ${CREDENTIAL}`,
      usage: { input_tokens: 123, output_tokens: 45 },
      diagnostics: { password: "do-not-print", note: longText },
      eventCount: 502,
    });
    const events = Array.from({ length: 502 }, (_, index) => JSON.stringify({
      type: "runtime_warning",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      message: index === 0 ? `first\u001b]8;;bad\u0007 ${CREDENTIAL}` : index === 501 ? "last\u202e" : `event-${String(index)}`,
      usage: { input_tokens: index },
      authorization: "Bearer should-not-print",
      nested: { secret: CREDENTIAL, value: index },
      ...(index === 0 ? {
        collection: Array.from({ length: 1_002 }, (_, item) => item),
        ["unsafe\u001bkey"]: "value\u202e",
        [CREDENTIAL]: "credential-key",
      } : {}),
    })).join("\n");
    await writeFile(join(artifacts, "safe-run.events.jsonl"), `${events}\n`, "utf8");
    const beforeSummary = await readFile(join(artifacts, "safe-run.summary.json"), "utf8");
    const beforeEvents = await readFile(join(artifacts, "safe-run.events.jsonl"), "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("run inspection must stay offline");
    });

    const result = await captureCli(() => runCli([
      "runs", "show", "safe-run", "--artifacts", artifacts, "--json",
    ]));
    const body = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly run: {
        readonly summary: Record<string, unknown> & { readonly usage: { readonly input_tokens: number }; readonly diagnostics: { readonly password: string; readonly note: string } };
        readonly events: readonly { readonly index: number; readonly summary: string; readonly payload: Record<string, unknown> }[];
        readonly warnings: readonly string[];
      };
    };

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(body.ok).toBe(true);
    expect(body.run.events).toHaveLength(500);
    expect(body.run.events[0]?.index).toBe(0);
    expect(body.run.events.at(-1)?.index).toBe(501);
    expect(body.run.warnings).toContain("Event list was capped at 500 events using first-and-last selection.");
    expect(body.run.summary.usage.input_tokens).toBe(123);
    expect(body.run.summary.diagnostics.password).toBe("[redacted]");
    const firstPayload = body.run.events[0]!.payload as { readonly collection: readonly unknown[] };
    expect(firstPayload.collection).toHaveLength(1_001);
    expect(firstPayload.collection.at(-1)).toBe("[max-items]");
    expect(Object.keys(firstPayload)).toContain("unsafe\\u001bkey");
    expect(Object.keys(firstPayload)).toContain("[redacted]");
    expect(Buffer.byteLength(body.run.summary.diagnostics.note, "utf8")).toBeLessThanOrEqual(32 * 1_024);
    expect(result.stdout).not.toContain(CREDENTIAL);
    expect(result.stdout).not.toContain("do-not-print");
    expect(result.stdout).not.toContain("Bearer should-not-print");
    expect(result.stdout).not.toMatch(/[\u001b\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
    expect(JSON.stringify(body)).toContain("[redacted]");
    expect(JSON.stringify(body)).toContain("\\u001b");
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(readFile(join(artifacts, "safe-run.summary.json"), "utf8")).resolves.toBe(beforeSummary);
    await expect(readFile(join(artifacts, "safe-run.events.jsonl"), "utf8")).resolves.toBe(beforeEvents);
  });

  it("renders human list/show output with inert controls and redacted credentials", async () => {
    const artifacts = await tempDir();
    await writeSummary(artifacts, "human-run", {
      conversationId: "human\u001b[31m",
      source: "web\u202e",
      userInput: CREDENTIAL,
      eventCount: 1,
    });
    await writeFile(join(artifacts, "human-run.events.jsonl"), `${JSON.stringify({
      type: "runtime_warning",
      message: `warning\u001b[2J ${CREDENTIAL}`,
      payload: { api_key: "plaintext" },
    })}\n`, "utf8");

    const list = await captureCli(() => runCli(["runs", "list", "--artifacts", artifacts]));
    const show = await captureCli(() => runCli(["runs", "show", "human-run", "--artifacts", artifacts]));

    expect(list.code).toBe(0);
    expect(list.stdout).toContain("human-run");
    expect(list.stdout).toContain("source=web\\u202e");
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("Run summary");
    expect(show.stdout).toContain("\\u001b");
    expect(show.stdout).toContain("[redacted]");
    expect(`${list.stdout}${show.stdout}`).not.toContain(CREDENTIAL);
    expect(`${list.stdout}${show.stdout}`).not.toMatch(/[\u001b\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
  });

  it("uses agent-first precedence for identical IDs and memory only as fallback", async () => {
    const artifacts = await tempDir();
    await mkdir(join(artifacts, "memory"), { recursive: true });
    await writeSummary(artifacts, "collision", { source: "web", model: "agent-model" });
    await writeSummary(join(artifacts, "memory"), "collision", {
      conversationId: "memory:capture",
      source: "memory",
      model: "memory-model",
    });
    await writeSummary(join(artifacts, "memory"), "memory-only", {
      conversationId: "memory:capture",
      source: "memory",
      model: "memory-model",
    });

    const collision = await captureCli(() => runCli([
      "runs", "show", "collision", "--artifacts", artifacts, "--include-memory", "--json",
    ]));
    const fallback = await captureCli(() => runCli([
      "runs", "show", "memory-only", "--artifacts", artifacts, "--include-memory", "--json",
    ]));
    const collisionBody = JSON.parse(collision.stdout) as { readonly run: { readonly summary: Record<string, unknown> } };
    const fallbackBody = JSON.parse(fallback.stdout) as { readonly run: { readonly summary: Record<string, unknown> } };

    expect(collision.code).toBe(0);
    expect(collisionBody.run.summary).toMatchObject({
      source: "web",
      model: "agent-model",
      summaryFileName: "collision.summary.json",
    });
    expect(fallback.code).toBe(0);
    expect(fallbackBody.run.summary).toMatchObject({
      source: "memory",
      model: "memory-model",
      summaryFileName: "memory/memory-only.summary.json",
    });
  });

  it("bounds warnings with an explicit omission marker without changing totalRuns", async () => {
    const artifacts = await tempDir();
    await writeSummary(artifacts, "valid", {});
    for (let index = 0; index < 60; index += 1) {
      await writeFile(join(artifacts, `bad-${String(index)}.summary.json`), "{bad", "utf8");
    }

    const result = await captureCli(() => runCli(["runs", "list", "--artifacts", artifacts, "--json"]));
    const body = JSON.parse(result.stdout) as {
      readonly totalRuns: number;
      readonly warnings: readonly string[];
    };

    expect(result.code).toBe(0);
    expect(body.totalRuns).toBe(1);
    expect(body.warnings).toHaveLength(50);
    expect(body.warnings.at(-1)).toBe("11 additional warnings omitted.");
  });

  it("redacts credentials and escapes controls carried by reader warnings", async () => {
    const artifacts = await tempDir();
    const unsafeName = `bad-${CREDENTIAL}\u001b\u202e.summary.json`;
    await writeFile(join(artifacts, unsafeName), "{bad", "utf8");

    const result = await captureCli(() => runCli(["runs", "list", "--artifacts", artifacts, "--json"]));
    const body = JSON.parse(result.stdout) as { readonly warnings: readonly string[] };

    expect(result.code).toBe(0);
    expect(body.warnings).toHaveLength(1);
    expect(result.stdout).not.toContain(CREDENTIAL);
    expect(result.stdout).not.toMatch(/[\u001b\u202a-\u202e\u2066-\u2069]/u);
    expect(body.warnings[0]).toContain("[redacted]");
    expect(body.warnings[0]).toContain("\\u001b");
    expect(body.warnings[0]).toContain("\\u202e");
  });

  it("returns stable not-found, traversal, usage, and read-failure envelopes without leaking input", async () => {
    const artifacts = await tempDir();
    const notFound = await captureCli(() => runCli([
      "runs", "show", "absent", "--artifacts", artifacts, "--json",
    ]));
    expect(notFound.code).toBe(1);
    expect(JSON.parse(notFound.stdout)).toEqual({
      ok: false,
      error: { code: "run_not_found", message: "Recorded run was not found." },
    });

    const humanNotFound = await captureCli(() => runCli([
      "runs", "show", "absent", "--artifacts", artifacts,
    ]));
    expect(humanNotFound).toMatchObject({ code: 1, stdout: "" });
    expect(humanNotFound.stderr).toContain("run_not_found: Recorded run was not found.");

    const traversal = await captureCli(() => runCli([
      "runs", "show", "../secret", "--artifacts", artifacts, "--json",
    ]));
    expect(traversal.code).toBe(2);
    expect(JSON.parse(traversal.stdout)).toMatchObject({ ok: false, error: { code: "runs_usage" } });
    expect(traversal.stdout).not.toContain("../secret");

    const secretArg = `unexpected-${CREDENTIAL}`;
    const parseFailure = await captureCli(() => runCli([
      "runs", "show", "safe", "--unknown", secretArg, "--json",
    ]));
    expect(parseFailure.code).toBe(2);
    expect(JSON.parse(parseFailure.stdout)).toMatchObject({ ok: false, error: { code: "runs_usage" } });
    expect(parseFailure.stderr).toBe("");
    expect(parseFailure.stdout).not.toContain(secretArg);
    expect(parseFailure.stdout.trim().split("\n")[0]).toBe("{");

    for (const argv of [
      ["runs", "show", "--json"],
      ["runs", "show", "one", "two", "--json"],
      ["runs", "list", "--stale-after-ms", "not-a-number", "--json"],
      ["runs", "list", "--since", "2026-01-01", "--json"],
      ["runs", "--json", "show", "safe", "--unknown"],
    ]) {
      const usage = await captureCli(() => runCli(argv));
      expect(usage.code).toBe(2);
      expect(usage.stderr).toBe("");
      expect(JSON.parse(usage.stdout)).toMatchObject({ ok: false, error: { code: "runs_usage" } });
    }

    const humanParseFailure = await captureCli(() => runCli([
      "runs", "list", "--unsafe\u001b\u202e",
    ]));
    expect(humanParseFailure.code).toBe(2);
    expect(humanParseFailure.stdout).toBe("");
    expect(humanParseFailure.stderr).toContain("runs_usage: Usage: mono-agent runs list");
    expect(humanParseFailure.stderr).not.toMatch(/[\u001b\u202a-\u202e\u2066-\u2069]/u);

    const readFailure = await captureCli(() => runInspection(
      { mode: "list", json: true },
      {
        resolveArtifactDir: async () => { throw new Error(`config ${CREDENTIAL}`); },
        listRuns: async () => { throw new Error("unused"); },
        readRun: async () => undefined,
      },
    ));
    expect(readFailure.code).toBe(1);
    expect(JSON.parse(readFailure.stdout)).toEqual({
      ok: false,
      error: { code: "runs_read_failed", message: "Unable to read recorded runs." },
    });
    expect(readFailure.stdout).not.toContain(CREDENTIAL);

    const readerFailure = await captureCli(() => runInspection(
      { mode: "show", runId: "safe", json: true },
      {
        resolveArtifactDir: async () => artifacts,
        listRuns: async () => ({ totalRuns: 0, runs: [], warnings: [] }),
        readRun: async () => { throw new Error(`read ${CREDENTIAL}`); },
      },
    ));
    expect(readerFailure.code).toBe(1);
    expect(JSON.parse(readerFailure.stdout)).toMatchObject({
      ok: false,
      error: { code: "runs_read_failed" },
    });
    expect(readerFailure.stdout).not.toContain(CREDENTIAL);
  });

  it("keeps report/audit parse failures on their existing human help path", async () => {
    const result = await captureCli(() => runCli(["runs", "report", "--unknown", "--json"]));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown flag");
    expect(result.stdout).toContain("mono-agent — config-first agent host");
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});

async function writeSummary(
  artifactDir: string,
  runId: string,
  overrides: Readonly<Record<string, unknown>>,
): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const summary = {
    runId,
    conversationId: "fixture",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    eventCount: 0,
    artifactPaths: [],
    ...overrides,
  };
  await writeFile(join(artifactDir, `${runId}.summary.json`), `${JSON.stringify(summary)}\n`, "utf8");
}

async function captureCli(run: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    return { code: await run(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}
