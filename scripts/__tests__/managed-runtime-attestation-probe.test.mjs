import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagedRuntimeAttestation } from "../fleet-green-check/probes.mjs";
import { describe, expect, it } from "vitest";

import {
  parseManagedRuntimeAttestationProbeArgs,
  runManagedRuntimeAttestationProbe,
} from "../managed-runtime-attestation-probe.mjs";

function sink() {
  let text = "";
  return {
    write(chunk) { text += String(chunk); },
    get text() { return text; },
  };
}

describe("managed runtime attestation probe", () => {
  it("fails closed before imports for malformed or relative private inputs", async () => {
    const out = sink();
    const result = await runManagedRuntimeAttestationProbe([
      "/repo",
      "/runtime/cli.js",
      "/agent",
      "relative-config.json",
      "",
      "private_snapshot",
      "137",
      "runtime-proof",
    ], out, { HOME: "/home/u" });
    expect(result).toBe(1);
    expect(out.text).toBe('{"schemaVersion":1,"status":"unsafe"}\n');
    expect(out.text).not.toContain("relative-config");
    expect(out.text).not.toContain("private_snapshot");
  });

  it("does not trust or require ambient HOME when validating arguments", () => {
    expect(parseManagedRuntimeAttestationProbeArgs([
      "/missing/deploy",
      "/missing/runtime/cli.js",
      "/missing/agent",
      "/missing/agent/mono-agent.config.json",
      "",
      "approved_snapshot",
      "137",
      "runtime-proof",
    ])).toEqual({
      repo: "/missing/deploy",
      runtimeCliPath: "/missing/runtime/cli.js",
      cwd: "/missing/agent",
      configPath: "/missing/agent/mono-agent.config.json",
      envFile: "",
      expectedSnapshot: "approved_snapshot",
      nodeAbi: "137",
      launchProof: "runtime-proof",
    });
  });
});

it("compares current inputs with effective console approval instead of the raw argv anchor", async () => {
  const repo = await mkdtemp(join(tmpdir(), "attestation-approval-"));
  const dist = join(repo, "packages", "agent-app", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({ type: "module" }));
  const files = {
    "background-runtime.js": `export async function attestManagedBackgroundRuntime() { return { schema: "mono-agent.managed-runtime-attestation.v1", fingerprint: "${"a".repeat(64)}", installedAt: "2026-01-01T00:00:00.000Z" }; }`,
    "background-snapshot.js": `export async function captureDurableBackgroundInputs() { return { snapshot: { configPath: "/agent/config.json", revision: "approved" }, environment: {} }; } export function decodeBackgroundSnapshot() { throw new Error("Raw argv comparison is wrong"); }`,
    "background-snapshot-key.js": `export async function loadBackgroundSnapshotKey() { return new Uint8Array(32); }`,
    "managed-runtime-packages.js": `export async function resolveConfiguredManagedRuntimePackages() { return []; }`,
    "launchd.js": `export function deriveLaunchdLabel() { return "com.mono-agent.example-12345678"; } export function launchdPathsFor() { return { logDir: "${repo}/managed/logs" }; }`,
    "approved-background-snapshot.js": `export function resolveApprovedBackgroundSnapshot(binding) { if (binding.encodedSnapshot !== "original_snapshot" || binding.launchProof !== "runtime_proof" || binding.configPath !== "/agent/config.json" || binding.label !== "com.mono-agent.example-12345678") throw new Error("Wrong approval binding"); return { configPath: "/agent/config.json", revision: "approved" }; }`,
  };
  try {
    await Promise.all(Object.entries(files).map(([name, source]) => writeFile(join(dist, name), source)));
    const out = sink();
    expect(await runManagedRuntimeAttestationProbe([repo, "/runtime/cli.js", "/agent", "/agent/config.json", "", "original_snapshot", "137", "runtime_proof"], out, {})).toBe(0);
    expect(JSON.parse(out.text).status).toBe("ok");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

it("passes the ORIGINAL runtime proof and snapshot from fleet to the approval resolver", () => {
  let observed;
  const entry = { managed: true, cliPath: "/runtime/cli.js", dir: "/agent", configPath: "/agent/config.json", expectedBackgroundSnapshot: "original_snapshot", expectedManagedRuntimeLaunch: "runtime_proof" };
  const result = runManagedRuntimeAttestation(entry, "/repo", { ran: true, abi: "137" }, {}, "/trusted/node", (_node, args) => {
    observed = args;
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, status: "ok", fingerprint: "a".repeat(64), installedAt: "2026-01-01T00:00:00.000Z" }) };
  });
  expect(observed.slice(-3)).toEqual(["original_snapshot", "137", "runtime_proof"]);
  expect(result.status).toBe("ok");
});
