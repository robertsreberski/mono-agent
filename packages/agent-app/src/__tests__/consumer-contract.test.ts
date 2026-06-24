/**
 * Golden consumer fixtures are source-shaped, secret-free snapshots of the real
 * downstream mono-agent configs. To refresh one, start from the live
 * mono-agent.config.json source, remove credential fields before committing,
 * relativize host paths to fixture-local placeholders, ensure referenced
 * IDENTITY.md, skills/, mcp.json, and cron files exist, then run this test plus
 * the fixture secret scan.
 */
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateMonoAgentFolder } from "../doctor.js";

const here = dirname(fileURLToPath(import.meta.url));
const consumersRoot = join(here, "fixtures", "consumers");
const forbiddenFixtureSecretPattern = /(sk-|xoxb-|bot[0-9]+:|apiKey|token)/u;

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("golden consumer config contracts", () => {
  it("validates the personal-agent fixture without network access", async () => {
    const fetchSpy = disableNetwork();
    const report = await validateConsumerFixture("personal-agent");

    expect(report.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sectionStatuses(report)).toMatchInlineSnapshot(`
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
    const report = await validateConsumerFixture("a8c-agent");

    expect(report.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sectionStatuses(report)).toMatchInlineSnapshot(`
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
});

function disableNetwork() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("consumer contract fixtures must validate without network access");
  });
}

async function validateConsumerFixture(name: string): Promise<Awaited<ReturnType<typeof validateMonoAgentFolder>>> {
  const dir = await mkdtemp(join(tmpdir(), `agent-app-consumer-${name}-`));
  tmpDirs.push(dir);
  await cp(join(consumersRoot, name), dir, { recursive: true });

  return await validateMonoAgentFolder({
    env: {},
    cwd: dir,
    configPath: join(dir, "mono-agent.config.json"),
    liveness: false,
  });
}

function sectionStatuses(report: Awaited<ReturnType<typeof validateMonoAgentFolder>>) {
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
