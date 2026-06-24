/**
 * Golden consumer fixtures are source-shaped, secret-free snapshots of the real
 * downstream mono-agent configs. To refresh one, start from the live
 * mono-agent.config.json source, remove credential fields before committing,
 * relativize host paths to fixture-local placeholders, ensure referenced
 * IDENTITY.md, skills/, mcp.json, and cron files exist, then run this test plus
 * the fixture secret scan.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
  return await validateConsumerContractFixture({
    name,
    fixtureDir: join(consumersRoot, name),
  });
}
