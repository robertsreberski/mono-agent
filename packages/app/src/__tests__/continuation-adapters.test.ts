import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";

import { startContinuationService } from "../continuations/continuation-service.js";
import * as protocol from "../continuations/protocol-operations.js";
import type { ClaimBinding } from "../continuations/continuation-service-types.js";
import { continuationDigest, type ContinuationClaimCapability } from "../continuations/continuations.js";

it("authorizes every operator edge before dispatch or malformed body parsing", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "continuation-adapter-"));
  const service = await startContinuationService({ stateDir, autoProcess: false,
    synthesize: async () => { throw new Error("unexpected synthesis"); },
    deliver: async () => { throw new Error("unexpected delivery"); },
  });
  try {
    for (const [method, path] of [
      ["GET", "/v1/operator/continuations"],
      ["GET", "/v1/operator/health"],
      ["POST", "/v1/operator/continuations/missing/retry"],
      ["POST", "/v1/operator/continuations/missing/cancel"],
      ["POST", "/v1/operator/continuations/missing/resolve"],
    ] as const) {
      const response = await fetch(`${service.url}${path}`, { method,
        headers: { authorization: "Bearer forged" }, ...(method === "POST" ? { body: "invalid json" } : {}),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.json()).toEqual({ error: { code: "invalid_operator_capability", message: "Invalid operator capability." } });
    }
    const detached = await fetch(`${service.url}/v1/continuations/detached/claim`, { method: "POST",
      headers: { authorization: "Bearer forged", "x-mono-agent-service-name": "fictional-service" }, body: "invalid json" });
    expect(detached.status).toBe(401);
    expect(await detached.json()).toEqual({ error: { code: "invalid_service_capability", message: "Invalid detached-service capability." } });
  } finally {
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

it("writes the admitted claim response before capability release drains", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "continuation-claim-drain-"));
  const events: string[] = [];
  let capability!: ContinuationClaimCapability;
  let released: Promise<void> | undefined;
  let admittedBinding: ClaimBinding | undefined;
  let claimsAtResponse: number | undefined;
  const createProtocol = protocol.createContinuationProtocolOperations;
  const factory = vi.spyOn(protocol, "createContinuationProtocolOperations").mockImplementation((dependencies) => {
    const operations = createProtocol(dependencies);
    return {
      ...operations,
      claim: async (...args) => {
        admittedBinding = args[0];
        const result = await operations.claim(...args);
        released = capability.release().then(() => { events.push("released"); });
        return result;
      },
    };
  });
  const end = ServerResponse.prototype.end;
  const writer = vi.spyOn(ServerResponse.prototype, "end").mockImplementation(function (this: ServerResponse, ...args) {
    events.push("response");
    claimsAtResponse = admittedBinding?.inFlightOperations;
    return end.apply(this, args);
  });
  const service = await startContinuationService({ stateDir, autoProcess: false,
    synthesize: async () => { throw new Error("unexpected synthesis"); },
    deliver: async () => { throw new Error("unexpected delivery"); },
  });
  try {
    capability = service.issueContinuationClaimCapability({
      runId: "fictional-run", serverName: "fictional-service", conversationId: "fictional-conversation",
    });
    const response = await fetch(capability.url, {
      method: "POST",
      headers: { authorization: `Bearer ${capability.token}`, "content-type": "application/json" },
      body: JSON.stringify({ taskKey: "fictional-task", taskHash: continuationDigest("fictional-task"),
        deadline: new Date(Date.now() + 60_000).toISOString() }),
    });
    expect(response.status).toBe(200);
    await response.json();
    await released;
    expect(events).toEqual(["response", "released"]);
    expect(claimsAtResponse).toBe(1);
    expect(admittedBinding?.inFlightOperations).toBe(0);
  } finally {
    writer.mockRestore();
    factory.mockRestore();
    await service.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
