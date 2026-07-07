import { describe, expect, it } from "vitest";

import {
  buildFleetReport,
  deriveRepoFromCliPath,
  evaluateRuns,
  instanceName,
  parseArgs,
  parseLaunchctlList,
  reduceMetrics,
  runFleetGreenCheck,
  shortSha,
} from "../fleet-green-check.mjs";

const DATE = "2026-07-07";
const SHA = "0e35c86d1122334455667788990011223344abcd";

function service({ found = true, pid = 4242, lastExitStatus = 0 } = {}) {
  return { found, pid, lastExitStatus };
}

function metrics({ totalRuns = 40, failedRuns = 0, failureKinds = [] } = {}) {
  return { ran: true, totalRuns, failedRuns, failureKinds };
}

function greenInstance(label = "com.mono-agent.orchestrator-2146e3d3") {
  return {
    label,
    dir: "/Users/example/agents/orchestrator",
    service: service(),
    validate: { ran: true, exitCode: 0, tail: "" },
    metrics: metrics({ totalRuns: 110, failedRuns: 1, failureKinds: [{ kind: "provider_unavailable", count: 1 }] }),
  };
}

describe("parseArgs", () => {
  it("parses flags and value options", () => {
    expect(parseArgs(["--dry-run", "--strict-runs", "--labels", "a, b ,c", "--expect-sha", "abc123", "--min-runs", "5", "--repo", "/r"]))
      .toEqual({ dryRun: true, strictRuns: true, help: false, labels: ["a", "b", "c"], expectSha: "abc123", minRuns: 5, repo: "/r" });
  });

  it("defaults to a posting, lenient run", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, strictRuns: false, help: false });
  });

  it("rejects unknown args and missing/invalid values", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/u);
    expect(() => parseArgs(["--labels"])).toThrow(/--labels requires a value/u);
    expect(() => parseArgs(["--min-runs", "-1"])).toThrow(/--min-runs requires a non-negative integer/u);
    expect(() => parseArgs(["--min-runs", "abc"])).toThrow(/--min-runs requires a non-negative integer/u);
  });
});

describe("parseLaunchctlList", () => {
  it("reads pid + last exit from a loaded service", () => {
    const text = '{\n\t"PID" = 34604;\n\t"LastExitStatus" = 0;\n};';
    expect(parseLaunchctlList(text, 0)).toEqual({ found: true, pid: 34604, lastExitStatus: 0 });
  });

  it("marks a stopped-clean service (no pid, exit 0) as found", () => {
    expect(parseLaunchctlList('{\n\t"LastExitStatus" = 0;\n};', 0)).toEqual({ found: true, pid: null, lastExitStatus: 0 });
  });

  it("treats a non-zero launchctl exit as not found (bogus label)", () => {
    expect(parseLaunchctlList("Could not find service.\n", 113)).toEqual({ found: false, pid: null, lastExitStatus: null });
  });
});

describe("deriveRepoFromCliPath", () => {
  it("strips the packages/agent-app suffix", () => {
    expect(deriveRepoFromCliPath("/Users/example/mono-agent/packages/agent-app/dist/cli.js")).toBe("/Users/example/mono-agent");
  });

  it("returns null for non-matching paths", () => {
    expect(deriveRepoFromCliPath(null)).toBeNull();
    expect(deriveRepoFromCliPath("/usr/local/bin/node")).toBeNull();
  });
});

describe("reduceMetrics", () => {
  it("extracts the overall bucket fields", () => {
    const report = {
      overall: {
        totalRuns: 110,
        statusCounts: { succeeded: 109, failed: 1 },
        failureKindRates: [{ failureKind: "provider_unavailable", count: 1, rate: 0.009 }],
      },
    };
    expect(reduceMetrics(report)).toEqual({
      ran: true,
      totalRuns: 110,
      failedRuns: 1,
      failureKinds: [{ kind: "provider_unavailable", count: 1 }],
    });
  });
});

describe("evaluateRuns", () => {
  it("passes a lone transient failover (1-of-110 provider_unavailable)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 110, failedRuns: 1, failureKinds: [{ kind: "provider_unavailable", count: 1 }] }));
    expect(result.status).toBe("pass");
    expect(result.note).toBe("110 runs, 1 failed (provider_unavailable×1)");
  });

  it("passes provider_unavailable below the volume guard (3-of-10 = 30%)", () => {
    expect(evaluateRuns(metrics({ totalRuns: 10, failedRuns: 3, failureKinds: [{ kind: "provider_unavailable", count: 3 }] })).status).toBe("pass");
  });

  it("flips usage_limit to RED — only provider_unavailable is tolerated now", () => {
    const result = evaluateRuns(metrics({ totalRuns: 40, failedRuns: 1, failureKinds: [{ kind: "usage_limit", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["usage_limit"]);
  });

  it("48-of-48 provider_auth is RED (untolerated kind, and it dominates)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 48, failedRuns: 48, failureKinds: [{ kind: "provider_auth", count: 48 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["provider_auth"]);
  });

  it("volume guard: even a tolerated kind is RED when every run fails", () => {
    const result = evaluateRuns(metrics({ totalRuns: 5, failedRuns: 5, failureKinds: [{ kind: "provider_unavailable", count: 5 }] }));
    expect(result.status).toBe("fail");
    expect(result.note).toContain("all runs failed");
  });

  it("volume guard: >50% failure over >=5 runs is RED even if tolerated", () => {
    const result = evaluateRuns(metrics({ totalRuns: 6, failedRuns: 4, failureKinds: [{ kind: "provider_unavailable", count: 4 }] }));
    expect(result.status).toBe("fail");
    expect(result.note).toContain("failure rate 67% over 6 runs");
  });

  it("treats a lifecycle cancellation as GREEN, surfacing the count (not a failure)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 25, failedRuns: 0, failureKinds: [{ kind: "cancelled_stale", count: 1 }] }));
    expect(result.status).toBe("pass");
    expect(result.note).toBe("25 runs, 0 failed, 1 cancelled");
    expect(result.untoleratedKinds).toEqual([]);
  });

  it("stays RED when a real untolerated kind coexists with a cancellation (names only the real one)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 25, failedRuns: 1, failureKinds: [{ kind: "runtime_error", count: 1 }, { kind: "cancelled_user", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["runtime_error"]);
    expect(result.note).toContain("1 cancelled");
    expect(result.note).toContain("untolerated failure kind(s): runtime_error");
  });

  it("fails on a new (unknown) failure kind", () => {
    const result = evaluateRuns(metrics({ totalRuns: 10, failedRuns: 1, failureKinds: [{ kind: "totally_new_kind", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["totally_new_kind"]);
  });

  it("fails on an unclassified failure (failed runs without a kind)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 10, failedRuns: 2, failureKinds: [{ kind: "provider_unavailable", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["(unclassified)"]);
  });

  it("under --strict-runs fails on any failed run, even a tolerated one", () => {
    const clean = metrics({ totalRuns: 10, failedRuns: 1, failureKinds: [{ kind: "provider_unavailable", count: 1 }] });
    expect(evaluateRuns(clean).status).toBe("pass");
    expect(evaluateRuns(clean, { strictRuns: true }).status).toBe("fail");
  });

  it("zero runs is a non-RED idle warning", () => {
    const result = evaluateRuns(metrics({ totalRuns: 0, failedRuns: 0 }));
    expect(result.status).toBe("warn");
    expect(result.note).toBe("0 runs (idle?)");
  });

  it("--min-runs fails a too-quiet instance", () => {
    expect(evaluateRuns(metrics({ totalRuns: 2, failedRuns: 0 }), { minRuns: 5 }).status).toBe("fail");
    expect(evaluateRuns(metrics({ totalRuns: 0, failedRuns: 0 }), { minRuns: 5 }).status).toBe("fail");
    expect(evaluateRuns(metrics({ totalRuns: 6, failedRuns: 0 }), { minRuns: 5 }).status).toBe("pass");
  });

  it("fails when metrics could not be read", () => {
    expect(evaluateRuns({ ran: false, error: "boom" }).status).toBe("fail");
  });

  it("skips when there is no runs data", () => {
    expect(evaluateRuns({ ran: false }).status).toBe("skip");
  });
});

describe("buildFleetReport", () => {
  it("GREEN: every instance passes, no expected sha", () => {
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance()] });
    expect(report.verdict).toBe("GREEN");
    expect(report.reason).toBeNull();
    expect(report.exitCode).toBe(0);
    expect(report.verdictLine).toBe(`VERDICT: GREEN ${DATE} sha 0e35c86`);
    expect(report.table).toContain("| orchestrator-2146e3d3 | ok | ok | ok |");
    expect(report.body).toContain(`### Fleet green-check ${DATE}`);
  });

  it("RED-service-down: a stopped instance drives RED with the service reason", () => {
    const down = greenInstance("com.mono-agent.personal-agent-059657c8");
    down.service = service({ pid: null, lastExitStatus: 1 });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance(), down] });
    expect(report.verdict).toBe("RED");
    expect(report.exitCode).toBe(1);
    expect(report.reason).toBe("personal-agent-059657c8: not running (last exit 1)");
    expect(report.verdictLine).toBe(`VERDICT: RED ${DATE} — personal-agent-059657c8: not running (last exit 1)`);
  });

  it("RED-validate-fail: surfaces the validate tail line", () => {
    const broken = greenInstance();
    broken.validate = { ran: true, exitCode: 1, tail: "ERROR channel telegram missing bot token" };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [broken] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("validate failed — ERROR channel telegram missing bot token");
  });

  it("RED-runs-new-kind: an untolerated failure kind drives RED", () => {
    const bad = greenInstance();
    bad.metrics = metrics({ totalRuns: 5, failedRuns: 1, failureKinds: [{ kind: "segfault_novel", count: 1 }] });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [bad] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("untolerated failure kind(s): segfault_novel");
  });

  it("RED-runs-volume: a tolerated kind that floods the window drives RED", () => {
    const bad = greenInstance();
    bad.metrics = metrics({ totalRuns: 48, failedRuns: 48, failureKinds: [{ kind: "provider_unavailable", count: 48 }] });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [bad] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("all runs failed");
  });

  it("RED-unreadable-plist: a plist that failed conversion is a RED row, not dropped", () => {
    const broken = { label: "com.mono-agent.corrupt-plist", discoveryError: "unparseable plist json (Unexpected token)" };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance(), broken] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("corrupt-plist: plist unreadable — unparseable plist json (Unexpected token)");
    expect(report.table).toContain("| corrupt-plist | FAIL | — | — |");
  });

  it("idle instance: zero runs shows a non-RED warn cell", () => {
    const idle = greenInstance("com.mono-agent.deep-research-cd0b9a0d");
    idle.metrics = metrics({ totalRuns: 0, failedRuns: 0 });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [idle] });
    expect(report.verdict).toBe("GREEN");
    expect(report.table).toContain("| deep-research-cd0b9a0d | ok | ok | warn | 0 runs (idle?) |");
  });

  it("a lifecycle cancellation keeps the fleet GREEN with a visible cancelled note", () => {
    const cancelled = greenInstance("com.mono-agent.personal-agent-059657c8");
    cancelled.metrics = metrics({ totalRuns: 25, failedRuns: 0, failureKinds: [{ kind: "cancelled_stale", count: 1 }] });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance(), cancelled] });
    expect(report.verdict).toBe("GREEN");
    expect(report.table).toContain("| personal-agent-059657c8 | ok | ok | ok | 25 runs, 0 failed, 1 cancelled |");
  });

  it("--min-runs escalates a too-quiet instance to RED", () => {
    const idle = greenInstance();
    idle.metrics = metrics({ totalRuns: 0, failedRuns: 0 });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, minRuns: 1, instances: [idle] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("below --min-runs 1");
  });

  it("RED-sha-mismatch: all green but deployed sha != expected", () => {
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, expectSha: "deadbeef", instances: [greenInstance()] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("deployed sha 0e35c86 != expected deadbee");
    expect(report.body).toContain("Deployed sha: 0e35c86 (expected deadbee)");
  });

  it("GREEN when the expected sha is a matching prefix of the deployed sha", () => {
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, expectSha: "0e35c86d", instances: [greenInstance()] });
    expect(report.verdict).toBe("GREEN");
  });

  it("bogus-label: a label with no plist/dir yields a RED row, not a crash", () => {
    const bogus = { label: "com.mono-agent.bogus-does-not-exist", dir: null, service: { found: false, pid: null, lastExitStatus: null }, validate: { ran: false }, metrics: { ran: false } };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [bogus] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("bogus-does-not-exist: service not found");
    expect(report.table).toContain("| bogus-does-not-exist | FAIL | — | — |");
  });

  it("RED when no instances were discovered", () => {
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("no fleet instances discovered");
  });
});

describe("helpers", () => {
  it("instanceName strips the com.mono-agent. prefix", () => {
    expect(instanceName("com.mono-agent.orchestrator-2146e3d3")).toBe("orchestrator-2146e3d3");
    expect(instanceName("custom-label")).toBe("custom-label");
  });

  it("shortSha truncates or reports unknown", () => {
    expect(shortSha(SHA)).toBe("0e35c86");
    expect(shortSha(null)).toBe("unknown");
  });
});

describe("runFleetGreenCheck (orchestration)", () => {
  const plistJson = JSON.stringify({
    Label: "com.mono-agent.orchestrator-2146e3d3",
    WorkingDirectory: "/Users/example/agents/orchestrator",
    ProgramArguments: ["/bin/node", "/Users/example/mono-agent/packages/agent-app/dist/cli.js", "start"],
  });
  const metricsJson = JSON.stringify({ overall: { totalRuns: 10, statusCounts: { succeeded: 10, failed: 0 }, failureKindRates: [] } });

  function fakeRunner(overrides = {}) {
    const calls = [];
    const runCommand = (command, args) => {
      calls.push({ command, args });
      if (command === "plutil") return { status: 0, stdout: plistJson, stderr: "" };
      if (command === "launchctl") return { status: 0, stdout: '{\n\t"PID" = 100;\n\t"LastExitStatus" = 0;\n};', stderr: "" };
      if (command === "git") return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      if (command === "node" && args.includes("validate")) return { status: 0, stdout: "ok\n", stderr: "" };
      if (command === "node" && args.includes("metrics")) return { status: 0, stdout: metricsJson, stderr: "" };
      if (command === "gh") return overrides.gh ?? { status: 0, stdout: "https://github.com/comment/1\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    };
    return { calls, runCommand };
  }

  it("--dry-run prints the verdict and never invokes gh (read-only)", async () => {
    const { calls, runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      launchAgentsDir: "/fake/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-2146e3d3.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(0);
    expect(out.text).toContain("VERDICT: GREEN 2026-07-07 sha 0e35c86");
    expect(calls.some((c) => c.command === "gh")).toBe(false);
    // Strictly read-only against the fleet: the ONLY cli.js subcommands ever
    // issued are the two read-only reporters, validate and metrics (allowlist —
    // never restart/stop/start or any mutating verb).
    const cliSubcommands = calls
      .filter((c) => c.command === "node" && typeof c.args[0] === "string" && c.args[0].endsWith("cli.js"))
      .map((c) => c.args[1]);
    expect(cliSubcommands.length).toBeGreaterThan(0);
    expect(new Set(cliSubcommands)).toEqual(new Set(["validate", "metrics"]));
  });

  it("default run posts the comment to #119 and exits on the verdict", async () => {
    const { calls, runCommand } = fakeRunner();
    const result = await runFleetGreenCheck({
      argv: [],
      stdout: sink(),
      stderr: sink(),
      runCommand,
      launchAgentsDir: "/fake/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-2146e3d3.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(0);
    const gh = calls.find((c) => c.command === "gh");
    expect(gh.args.slice(0, 4)).toEqual(["issue", "comment", "119", "--repo"]);
    expect(gh.args[gh.args.length - 1]).toContain("VERDICT: GREEN");
  });

  it("a bogus --labels override yields RED and still queries the sha, without crashing", async () => {
    const { runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--labels", "com.mono-agent.bogus"],
      stdout: out,
      stderr: sink(),
      runCommand: (command, args) => {
        if (command === "launchctl") return { status: 113, stdout: "Could not find service.\n", stderr: "" };
        return runCommand(command, args);
      },
      launchAgentsDir: "/fake/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-2146e3d3.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("VERDICT: RED 2026-07-07 — bogus: service not found");
  });

  it("a prefix-matching plist that fails conversion becomes a RED row (not dropped)", async () => {
    const { runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand: (command, args) => {
        if (command === "plutil") return { status: 1, stdout: "", stderr: "corrupt.plist: JSON error\n" };
        return runCommand(command, args);
      },
      launchAgentsDir: "/fake/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-2146e3d3.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("VERDICT: RED");
    expect(out.text).toContain("plist unreadable");
  });

  it("surfaces a failed gh comment post as a non-zero exit", async () => {
    const { runCommand } = fakeRunner({ gh: { status: 1, stdout: "", stderr: "gh: not authenticated" } });
    const err = sink();
    const result = await runFleetGreenCheck({
      argv: [],
      stdout: sink(),
      stderr: err,
      runCommand,
      launchAgentsDir: "/fake/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-2146e3d3.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(err.text).toContain("Failed to post comment to #119");
  });
});

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
