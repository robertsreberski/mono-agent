/**
 * Golden consumer fixtures are source-shaped, secret-free snapshots of the real
 * downstream mono-agent configs. To refresh one, start from the live
 * mono-agent.config.json source, remove credential fields before committing,
 * relativize host paths to fixture-local placeholders, ensure referenced
 * IDENTITY.md, skills/, mcp.json, and cron files exist, then run this test plus
 * the fixture secret scan.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import {
  consumerContractNames,
  consumerContractRunSummaryStatuses,
  validateConsumerContractFixture,
} from "../consumer-contract.js";
import type { ConsumerContractName } from "../consumer-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const consumersRoot = join(here, "fixtures", "consumers");

describe("golden consumer config contracts", () => {
  it("validates the local-agent-alpha fixture without network access", async () => {
    const result = await validateFixture("local-agent-alpha");

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.networkCallCount).toBe(0);
    expect(result.sections).toMatchInlineSnapshot(`
      [
        {
          "id": "core",
          "status": "ok",
        },
        {
          "id": "secret-placement",
          "status": "waiting",
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
          "status": "waiting",
        },
        {
          "id": "observability",
          "status": "ok",
        },
        {
          "id": "runs",
          "status": "disabled",
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
          "id": "channel:tui",
          "status": "ok",
        },
        {
          "id": "channel:live",
          "status": "ok",
        },
      ]
    `);
  });

  it("validates the local-agent-beta fixture without network access", async () => {
    const result = await validateFixture("local-agent-beta");

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.networkCallCount).toBe(0);
    expect(result.sections).toMatchInlineSnapshot(`
      [
        {
          "id": "core",
          "status": "ok",
        },
        {
          "id": "secret-placement",
          "status": "waiting",
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
          "status": "waiting",
        },
        {
          "id": "observability",
          "status": "ok",
        },
        {
          "id": "runs",
          "status": "disabled",
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
          "id": "channel:tui",
          "status": "ok",
        },
        {
          "id": "channel:live",
          "status": "ok",
        },
      ]
    `);
  });

  it("keeps committed consumer fixtures free of obvious secret markers", async () => {
    const results = await Promise.all(consumerContractNames.map((name) => validateFixture(name)));

    expect(results.flatMap((result) => result.issues.filter((issue) => issue.check === "fixture-secrets"))).toEqual([]);
  });

  it("keeps artifact run statuses aligned with the observability status union", () => {
    expect(Object.keys(consumerContractRunSummaryStatuses).sort()).toEqual([
      "cancelled",
      "failed",
      "interrupted",
      "running",
      "succeeded",
    ]);
  });
});

async function validateFixture(name: ConsumerContractName) {
  const sandboxEngine: SandboxEngine = {
    id: "synthetic-unavailable-srt",
    isAvailable: vi.fn(async () => false),
    prepareCommand: vi.fn(async () => {
      throw new Error("not used in consumer contract validation");
    }),
  };
  const fixtureDir = await mkdtemp(join(tmpdir(), `agent-app-consumer-source-${name}-`));
  try {
    await cp(join(consumersRoot, name), fixtureDir, { recursive: true });
    if (name === "local-agent-alpha") {
      await seedManagedMemory(
        join(fixtureDir, ".mono-agent", "memory"),
        "bujo",
        "ollama:nomic-embed-text:v1.5",
      );
    } else {
      await seedManagedMemory(
        join(fixtureDir, ".local-agent-beta", "memory"),
        "journal",
        "ollama:nomic-embed-text:v1.5",
      );
    }
    const result = await validateConsumerContractFixture({ name, fixtureDir, sandboxEngine });
    expect(sandboxEngine.isAvailable).toHaveBeenCalledTimes(1);
    expect(sandboxEngine.prepareCommand).not.toHaveBeenCalled();
    return result;
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function seedManagedMemory(root: string, tier: "journal" | "bujo", embeddingModel: string): Promise<void> {
  const generation = "g-20260712T000000000Z-00000000-0000-4000-8000-000000000000";
  const generationDir = join(root, ".index", "generations", generation);
  await mkdir(generationDir, { recursive: true });
  await writeFile(join(generationDir, "memory.db"), "");
  await writeFile(join(root, ".index", "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    active: {
      name: generation,
      tier,
      sourceFingerprint: "0".repeat(64),
      policyVersion: "mono-agent-memory-rebuild-v1",
      createdAt: "2026-07-12T00:00:00.000Z",
      embeddingModel,
      dimension: 768,
      origin: "rebuild",
    },
  }));
}
