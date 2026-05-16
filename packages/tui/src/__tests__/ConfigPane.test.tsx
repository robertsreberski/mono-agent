import React from "react";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";

import { ConfigPane } from "../components/ConfigPane.js";
import { buildTuiConfigSummary } from "../config/pane.js";

const SECRET_TOKEN = "1234567890:THIS_IS_THE_RAW_SECRET_TOKEN_NEVER_LEAK";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "tui-config-"));
});

afterEach(async () => {
  cleanup();
  await rm(tmpRoot, { recursive: true, force: true });
});

const sleep = (ms = 30) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function writeJson(path: string, body: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(body), { encoding: "utf8" });
}

describe("ConfigPane", () => {
  it("renders core config and never leaks adapter-owned raw secrets", async () => {
    const configPath = join(tmpRoot, "mono-agent.config.json");
    await writeJson(configPath, {
      telegram: {
        botToken: SECRET_TOKEN,
        allowedChatIds: ["111", "222"],
      },
      runtime: {
        model: "codex:gpt-5.5",
        executionMode: "cli",
        effort: "high",
        maxTurns: 8,
        workspace: tmpRoot,
      },
      context: {
        identityPath: join(tmpRoot, "IDENTITY.md"),
        selectedSkills: ["alpha", "beta"],
      },
      tools: { allowedTools: ["read"], disallowedTools: [] },
      artifacts: { dir: join(tmpRoot, "artifacts") },
    });

    const { lastFrame } = render(
      <ConfigPane
        configPath={configPath}
        cwd={tmpRoot}
        env={{}}
        active={false}
      />,
    );

    await sleep(80);

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/codex:gpt-5\.5/);
    expect(frame).toMatch(/cli/);
    expect(frame).not.toMatch(/allowedChatIds/);
    expect(frame).not.toMatch(/botToken/);
    expect(frame).not.toContain(SECRET_TOKEN);
    expect(frame).not.toContain("THIS_IS_THE_RAW_SECRET_TOKEN_NEVER_LEAK");
  });

  it("shows an error message and a retry hint when the file cannot be read", async () => {
    const configPath = join(tmpRoot, "nope.json");
    await writeFile(configPath, "{ not json", "utf8");

    const { lastFrame } = render(
      <ConfigPane
        configPath={configPath}
        cwd={tmpRoot}
        env={{}}
        active={false}
      />,
    );

    await sleep(80);

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/failed to load/);
    expect(frame).toMatch(/press r to retry/);
  });
});

describe("buildTuiConfigSummary", () => {
  it("tags fields with the layer that supplied them (env > json > default)", () => {
    const sections = buildTuiConfigSummary({
      redacted: {
        runtime: {
          model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
          executionMode: "cli",
          effort: "high",
          maxTurns: 4,
          workspace: "/tmp/work",
        },
        context: {
          identityPath: "/tmp/IDENTITY.md",
          selectedSkills: [],
        },
        tools: { allowedTools: [], disallowedTools: [] },
        artifacts: { dir: "/tmp/artifacts" },
        traceability: { registryDir: "/tmp/trace-sources" },
      },
      json: {
        runtime: { model: "codex:gpt-5.5" },
        context: { identityPath: "/tmp/IDENTITY.md" },
      },
      env: {
        MONO_AGENT_EXECUTION_MODE: "cli",
      },
    });

    const runtime = sections.find((section) => section.heading === "runtime");
    expect(runtime).toBeDefined();
    const fieldByLabel = (label: string) =>
      runtime?.fields.find((field) => field.label === label);
    expect(fieldByLabel("model")?.source).toBe("json");
    expect(fieldByLabel("executionMode")?.source).toBe("env");
    expect(fieldByLabel("workspace")?.source).toBe("default");
  });
});
