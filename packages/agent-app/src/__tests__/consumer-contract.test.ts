/**
 * Golden consumer fixtures are source-shaped, secret-free snapshots of the real
 * downstream mono-agent configs. To refresh one, start from the live
 * mono-agent.config.json source, remove credential fields before committing,
 * relativize host paths to fixture-local placeholders, ensure referenced
 * IDENTITY.md, skills/, mcp.json, and cron files exist, then run this test plus
 * the fixture secret scan.
 */
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readMonoAgentConfigJson } from "@mono-agent/config";
import type { MonoAgentConfigJson } from "@mono-agent/config";
import type { RunSummaryStatus } from "@mono-agent/observability";

import { loadAppCoreConfig } from "../app-config.js";
import { validateMonoAgentFolder } from "../doctor.js";

const here = dirname(fileURLToPath(import.meta.url));
const consumersRoot = join(here, "fixtures", "consumers");
const forbiddenFixtureSecretPattern = /(sk-|xoxb-|bot[0-9]+:|apiKey|token)/u;
const forbiddenMcpMemoryPattern = /@mono-agent\/memory-mcp|\bmemory-mcp\b|\bmemory_note\b|\bmemory_recall\b/u;
const runSummaryStatuses = {
  running: true,
  succeeded: true,
  failed: true,
  cancelled: true,
  interrupted: true,
} satisfies Record<RunSummaryStatus, true>;

type ValidationReport = Awaited<ReturnType<typeof validateMonoAgentFolder>>;
type ChannelStatus = ValidationReport["sections"][number]["status"];
type ConsumerName = "personal-agent" | "a8c-agent";
type ConsumerSourceJson = MonoAgentConfigJson & {
  readonly telegram?: { readonly enabled?: boolean };
  readonly slack?: { readonly enabled?: boolean };
  readonly a2a?: { readonly provider?: { readonly enabled?: boolean } };
  readonly webhook?: { readonly enabled?: boolean };
  readonly openaiApi?: { readonly enabled?: boolean };
};

interface ConsumerFixture {
  readonly name: ConsumerName;
  readonly dir: string;
  readonly sourceJson: ConsumerSourceJson;
  readonly config: Awaited<ReturnType<typeof loadAppCoreConfig>>;
  readonly report: ValidationReport;
}

const expectedContracts = {
  "personal-agent": {
    memoryMode: "bujo",
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "telegram_send_message",
    ],
    channels: {
      telegram: "active",
      slack: "disabled",
      a2a: "disabled",
      webhook: "active",
      "openai-api": "active",
      cron: "active",
      whatsapp: "disabled",
    },
    enabledFlags: {
      telegram: true,
      slack: false,
      a2a: false,
      webhook: true,
      "openai-api": true,
    },
  },
  "a8c-agent": {
    memoryMode: "journal",
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "slack_send_message",
      "memory_recall",
    ],
    channels: {
      telegram: "disabled",
      slack: "active",
      a2a: "disabled",
      webhook: "disabled",
      "openai-api": "active",
      cron: "active",
      whatsapp: "disabled",
    },
    enabledFlags: {
      telegram: false,
      slack: true,
      a2a: false,
      webhook: false,
      "openai-api": true,
    },
  },
} as const;

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("golden consumer config contracts", () => {
  it("validates the personal-agent fixture without network access", async () => {
    const fetchSpy = disableNetwork();
    const fixture = await loadConsumerFixture("personal-agent");

    assertConsumerContract(fixture);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sectionStatuses(fixture.report)).toMatchInlineSnapshot(`
      [
        {
          "id": "core",
          "status": "ok",
        },
        {
          "id": "runtime",
          "status": "ok",
        },
        {
          "id": "credentials",
          "status": "waiting",
        },
        {
          "id": "context",
          "status": "ok",
        },
        {
          "id": "memory",
          "status": "ok",
        },
        {
          "id": "tools",
          "status": "ok",
        },
        {
          "id": "sandbox",
          "status": "ok",
        },
        {
          "id": "observability",
          "status": "ok",
        },
        {
          "id": "channel:telegram",
          "status": "waiting",
        },
        {
          "id": "channel:slack",
          "status": "disabled",
        },
        {
          "id": "channel:a2a",
          "status": "disabled",
        },
        {
          "id": "channel:webhook",
          "status": "ok",
        },
        {
          "id": "channel:openai-api",
          "status": "ok",
        },
        {
          "id": "channel:cron",
          "status": "ok",
        },
        {
          "id": "channel:whatsapp",
          "status": "disabled",
        },
      ]
    `);
  });

  it("validates the a8c-agent fixture without network access", async () => {
    const fetchSpy = disableNetwork();
    const fixture = await loadConsumerFixture("a8c-agent");

    assertConsumerContract(fixture);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sectionStatuses(fixture.report)).toMatchInlineSnapshot(`
      [
        {
          "id": "core",
          "status": "ok",
        },
        {
          "id": "runtime",
          "status": "ok",
        },
        {
          "id": "credentials",
          "status": "waiting",
        },
        {
          "id": "context",
          "status": "ok",
        },
        {
          "id": "memory",
          "status": "ok",
        },
        {
          "id": "tools",
          "status": "ok",
        },
        {
          "id": "sandbox",
          "status": "ok",
        },
        {
          "id": "observability",
          "status": "ok",
        },
        {
          "id": "channel:telegram",
          "status": "disabled",
        },
        {
          "id": "channel:slack",
          "status": "waiting",
        },
        {
          "id": "channel:a2a",
          "status": "disabled",
        },
        {
          "id": "channel:webhook",
          "status": "disabled",
        },
        {
          "id": "channel:openai-api",
          "status": "ok",
        },
        {
          "id": "channel:cron",
          "status": "ok",
        },
        {
          "id": "channel:whatsapp",
          "status": "disabled",
        },
      ]
    `);
  });

  it("keeps committed consumer fixtures free of obvious secret markers", async () => {
    const files = await readFixtureFiles(consumersRoot);
    const hits = files.flatMap(({ path, content }) =>
      forbiddenFixtureSecretPattern.test(content) ? [relative(consumersRoot, path)] : [],
    );

    expect(hits).toEqual([]);
  });

  it("keeps artifact run statuses aligned with the observability status union", () => {
    expect(Object.keys(runSummaryStatuses).sort()).toEqual([
      "cancelled",
      "failed",
      "interrupted",
      "running",
      "succeeded",
    ]);
  });
});

function disableNetwork() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("consumer contract fixtures must validate without network access");
  });
}

async function loadConsumerFixture(name: ConsumerName): Promise<ConsumerFixture> {
  const dir = await mkdtemp(join(tmpdir(), `agent-app-consumer-${name}-`));
  tmpDirs.push(dir);
  await cp(join(consumersRoot, name), dir, { recursive: true });
  const configPath = join(dir, "mono-agent.config.json");
  const sourceJson = (await readMonoAgentConfigJson(configPath)).json as ConsumerSourceJson;
  const config = await loadAppCoreConfig({ env: {}, cwd: dir, configPath });
  const report = await validateMonoAgentFolder({
    env: {},
    cwd: dir,
    configPath,
    liveness: false,
  });

  return { name, dir, sourceJson, config, report };
}

function assertConsumerContract(fixture: ConsumerFixture): void {
  const expected = expectedContracts[fixture.name];
  expect(fixture.report.ok).toBe(true);
  assertChannelContract(fixture.report, expected.channels);
  assertSourceEnabledFlags(fixture.sourceJson, expected.enabledFlags);

  expect(fixture.config.tools.allowedTools.length).toBeGreaterThan(0);
  expect(fixture.config.tools.allowedTools).toEqual(expected.allowedTools);
  expect(fixture.config.tools.disallowedTools).toEqual([]);

  expect(fixture.config.memory?.mode).toBe(expected.memoryMode);
  expect(fixture.config.memory?.recallTool?.enabled).toBe(true);
  expect(["ok", "waiting"]).toContain(sectionStatus(fixture.report, "memory"));

  expect(fixture.sourceJson.artifacts?.dir?.trim()).toBeTruthy();
  expect(fixture.config.observability?.exporters[0]?.type).toBe("phoenix");

  assertNoRetiredMcpMemorySurface(fixture);
}

function assertChannelContract(
  report: ValidationReport,
  expected: typeof expectedContracts[ConsumerName]["channels"],
): void {
  const statuses = channelStatuses(report);
  expect([...statuses.keys()].sort()).toEqual(Object.keys(expected).sort());

  for (const [id, expectedState] of Object.entries(expected)) {
    const status = statuses.get(id);
    expect(status).not.toBe("error");
    if (expectedState === "active") {
      expect(status === "ok" || status === "waiting").toBe(true);
    } else {
      expect(status).toBe("disabled");
    }
  }
}

function assertSourceEnabledFlags(
  sourceJson: ConsumerSourceJson,
  expected: typeof expectedContracts[ConsumerName]["enabledFlags"],
): void {
  for (const [id, enabled] of Object.entries(expected)) {
    expect(sourceEnabledFlag(sourceJson, id)).toBe(enabled);
  }
}

function sourceEnabledFlag(sourceJson: ConsumerSourceJson, id: string): boolean {
  switch (id) {
    case "telegram":
      return sourceJson.telegram?.enabled === true;
    case "slack":
      return sourceJson.slack?.enabled === true;
    case "a2a":
      return sourceJson.a2a?.provider?.enabled === true;
    case "webhook":
      return sourceJson.webhook?.enabled === true;
    case "openai-api":
      return sourceJson.openaiApi?.enabled === true;
    default:
      throw new Error(`unknown channel enabled flag: ${id}`);
  }
}

function assertNoRetiredMcpMemorySurface(fixture: ConsumerFixture): void {
  expect(fixture.config.tools.allowedTools).not.toContain("memory_note");
  expect(fixture.config.tools.mcpConfigPath).toBeDefined();

  const mcpPath = fixture.config.tools.mcpConfigPath;
  if (mcpPath === undefined) {
    return;
  }
  const mcpText = readFileSync(mcpPath, "utf8");
  expect(mcpText).not.toMatch(forbiddenMcpMemoryPattern);
}

function channelStatuses(report: ValidationReport): Map<string, ChannelStatus> {
  const result = new Map<string, ChannelStatus>();
  for (const section of report.sections) {
    if (section.id.startsWith("channel:")) {
      result.set(section.id.slice("channel:".length), section.status);
    }
  }
  return result;
}

function sectionStatus(report: ValidationReport, id: string): ChannelStatus | undefined {
  return report.sections.find((section) => section.id === id)?.status;
}

function sectionStatuses(report: ValidationReport) {
  return report.sections.map(({ id, status }) => ({ id, status }));
}

async function readFixtureFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return await readFixtureFiles(path);
      }
      if (!entry.isFile()) {
        return [];
      }
      return [{ path, content: await readFile(path, "utf8") }];
    }),
  );
  return files.flat();
}
