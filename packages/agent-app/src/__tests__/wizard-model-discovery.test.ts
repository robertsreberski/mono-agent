import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  discoverWizardModelCandidates,
  guidedPiProviderProblem,
} from "../wizard/model-discovery.js";

async function missingAuthStore() {
  return { status: "missing" as const };
}

function unavailableFetch(): Promise<Response> {
  return Promise.reject(new Error("unavailable"));
}

describe("supported wizard model catalog", () => {
  it("rejects unsupported remote and undeclared custom providers in manual guided entry", () => {
    expect(guidedPiProviderProblem("cloudflare-workers-ai")).toMatch(/Configure other Pi providers manually/u);
    expect(guidedPiProviderProblem("amazon-bedrock")).toMatch(/Configure other Pi providers manually/u);
    expect(guidedPiProviderProblem("openai-codex")).toBeUndefined();
    expect(guidedPiProviderProblem("ollama")).toBeUndefined();
    expect(guidedPiProviderProblem("lmstudio")).toBeUndefined();
    expect(guidedPiProviderProblem("llamacpp")).toMatch(/providers\.local/u);
    expect(guidedPiProviderProblem("my-local-server")).toMatch(/providers\.local/u);
  });

  it.skipIf(process.platform === "win32")("rejects a group-readable default Pi auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-wizard-auth-mode-"));
    const authPath = join(dir, "auth.json");
    try {
      await writeFile(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: "secret" } }), { mode: 0o644 });
      await chmod(authPath, 0o644);

      const result = await discoverWizardModelCandidates({
        piAuthPath: authPath,
        execFile: async () => { throw new Error("provider CLI unavailable"); },
        fetch: unavailableFetch as never,
      });

      expect(result.statuses.find((status) => status.provider === "Pi"))
        .toMatchObject({ status: "unavailable" });
      expect(result.statuses.find((status) => status.provider === "Pi")?.detail).toContain("not-owner-only");
      expect(result.candidates.find((candidate) => candidate.value === "opencode-go:kimi-k2.6"))
        .toMatchObject({ authState: "auth_required", setupRequired: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link default Pi auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-wizard-auth-link-"));
    const target = join(dir, "target.json");
    const authPath = join(dir, "auth.json");
    try {
      await writeFile(target, JSON.stringify({ "opencode-go": { type: "api_key", key: "secret" } }), { mode: 0o600 });
      await chmod(target, 0o600);
      await symlink(target, authPath);

      const result = await discoverWizardModelCandidates({
        piAuthPath: authPath,
        execFile: async () => { throw new Error("provider CLI unavailable"); },
        fetch: unavailableFetch as never,
      });

      expect(result.statuses.find((status) => status.provider === "Pi"))
        .toMatchObject({ status: "unavailable" });
      expect(result.statuses.find((status) => status.provider === "Pi")?.detail).toContain("symbolic-link");
      expect(result.candidates.find((candidate) => candidate.value === "opencode-go:kimi-k2.6"))
        .toMatchObject({ authState: "auth_required", setupRequired: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("detects credentials in an owner-only regular Pi auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-wizard-auth-valid-"));
    const authPath = join(dir, "auth.json");
    try {
      await writeFile(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: "secret" } }), { mode: 0o600 });
      await chmod(authPath, 0o600);

      const result = await discoverWizardModelCandidates({
        piAuthPath: authPath,
        execFile: async () => { throw new Error("provider CLI unavailable"); },
        fetch: unavailableFetch as never,
      });

      expect(result.statuses.find((status) => status.provider === "Pi"))
        .toMatchObject({ status: "detected" });
      expect(result.candidates.find((candidate) => candidate.value === "opencode-go:kimi-k2.6"))
        .toMatchObject({ authState: "credential_detected" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes every model for the guided Pi providers without advertising unsupported cloud providers", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: vi.fn(async () => { throw new Error("provider CLI unavailable"); }),
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
    });

    const pi = result.candidates.filter((candidate) => candidate.source === "pi");
    expect(pi.length).toBeGreaterThan(20);
    expect(pi.some((candidate) => candidate.value.startsWith("anthropic:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("github-copilot:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("openai-codex:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("opencode-go:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("amazon-bedrock:"))).toBe(false);
    expect(pi.some((candidate) => candidate.value.startsWith("cloudflare-"))).toBe(false);
    expect(pi.some((candidate) => candidate.value.startsWith("openai:"))).toBe(false);
    expect(pi.every((candidate) => candidate.availability === "catalog_available")).toBe(true);
    expect(pi.some((candidate) => candidate.supportedEfforts?.includes("minimal"))).toBe(true);
    expect(pi.find((candidate) => candidate.value === "github-copilot:gemini-3.7-flash")).toMatchObject({
      authState: "auth_required",
      setupRequired: true,
    });
    expect(pi.find((candidate) => candidate.value === "github-copilot:grok-4.6")).toMatchObject({
      authState: "auth_required",
      setupRequired: true,
    });
    expect(pi.find((candidate) => candidate.value === "openai-codex:gpt-6-astra")).toMatchObject({
      authState: "auth_required",
      setupRequired: true,
      supportedEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(pi.find((candidate) => candidate.value === "openai-codex:gpt-6-astra")?.defaultEffort).toBeUndefined();
  });


});
