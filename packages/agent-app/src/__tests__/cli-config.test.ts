import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { renderConfigView, runCli } from "../cli.js";
import type { ConfigViewSection } from "@mono-agent/config";

const sections: readonly ConfigViewSection[] = [
  {
    id: "runtime",
    label: "Runtime",
    status: "active",
    fields: [
      { id: "runtime.model", label: "Model", value: "pi:ollama:qwen3:8b", source: "json" },
      { id: "runtime.effort", label: "Effort", value: "—", source: "default" },
      { id: "runtime.workspace", label: "Workspace", value: "/work", source: "env" },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    status: "disabled",
    fields: [{ id: "memory.mode", label: "Status", value: "not configured", source: "default" }],
  },
];

describe("renderConfigView", () => {
  it("tags every field with its source layer", () => {
    const out = renderConfigView(sections);
    expect(out).toContain("Runtime");
    expect(out).toMatch(/Model.*pi:ollama:qwen3:8b.*\[json\]/u);
    expect(out).toMatch(/Effort.*\[default\]/u);
    expect(out).toMatch(/Workspace.*\[env\]/u);
  });

  it("renders an active section with the ok badge and a disabled one with the off badge", () => {
    const out = renderConfigView(sections);
    // Plain (NO_COLOR) badges are width-equal ASCII tags.
    expect(out).toContain("[ok]   ");
    expect(out).toContain("[off]  ");
    expect(out).toContain("not configured");
  });

  it("marks redacted fields with a secret note", () => {
    const out = renderConfigView([
      {
        id: "memory",
        label: "Memory",
        status: "active",
        fields: [
          { id: "memory.embeddings.apiKey", label: "Embeddings API key", value: "set", source: "env", redacted: true },
        ],
      },
    ]);
    expect(out).toContain("(secret)");
    expect(out).not.toContain("sk-");
  });
});

describe("runCli config", () => {
  it("prints JSON-sourced secret warnings without leaking the value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-config-"));
    const previousCwd = process.cwd();
    const previousMonoAgentEnv = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        previousMonoAgentEnv.set(key, process.env[key] ?? "");
        delete process.env[key];
      }
    }

    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);

    try {
      process.chdir(dir);
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: { model: "pi:openai-codex:gpt-5.5" },
          context: { identityPath: "./IDENTITY.md" },
          memory: {
            mode: "journal",
            path: "./memory",
            embeddings: {
              provider: "openai",
              model: "text-embedding-3-small",
              apiKey: "sk-json-secret",
            },
          },
        }, null, 2),
      );

      await expect(runCli(["config", "--config", configPath])).resolves.toBe(0);

      const out = chunks.join("");
      expect(out).toContain("[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json");
      expect(out).toContain("MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY");
      expect(out).not.toContain("sk-json-secret");
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MONO_AGENT_")) {
          delete process.env[key];
        }
      }
      for (const [key, value] of previousMonoAgentEnv) {
        process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints removed memory key warnings without leaking ignored values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-config-"));
    const previousCwd = process.cwd();
    const previousMonoAgentEnv = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        previousMonoAgentEnv.set(key, process.env[key] ?? "");
        delete process.env[key];
      }
    }

    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);

    try {
      process.chdir(dir);
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: { model: "pi:openai-codex:gpt-5.5" },
          context: { identityPath: "./IDENTITY.md" },
          memory: {
            mode: "bujo",
            path: "./memory",
            reflection: { cron: "ignored-secret-cron" },
            migration: { enabled: false },
          },
        }, null, 2),
      );

      await expect(runCli(["config", "--config", configPath])).resolves.toBe(0);

      const out = chunks.join("");
      expect(out).toContain("[WARN] memory.reflection is removed and ignored");
      expect(out).toContain("[WARN] memory.migration is removed and ignored");
      expect(out).not.toContain("ignored-secret-cron");
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MONO_AGENT_")) {
          delete process.env[key];
        }
      }
      for (const [key, value] of previousMonoAgentEnv) {
        process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
