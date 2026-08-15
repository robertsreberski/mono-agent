import { describe, expect, it } from "vitest";

import {
  isAgentReplyPartDeliveryOutcomes,
  MAX_AGENT_REPLY_PARTS,
  sanitizeReplyPartDeliveryOutcomes,
  unsupportedReplyPartDeliveryOutcomes,
  type AgentReplyPart,
} from "../index.js";

describe("rich reply part delivery outcomes", () => {
  it("emits one sanitized terminal failure for every supported rich-part kind", () => {
    const sensitive = "/synthetic-private/report.csv?token=secret#sha256:deadbeef";
    const outcomes = unsupportedReplyPartDeliveryOutcomes([
      {
        type: "attachment",
        id: sensitive,
        reference: { scheme: "mono-agent-artifact", id: sensitive },
        name: sensitive,
        mediaType: "text/csv",
        sizeBytes: 10,
        integrityId: "sha256:deadbeef",
      },
      {
        type: "mcp_app",
        id: sensitive,
        invocationId: sensitive,
        connectionId: sensitive,
        serverName: sensitive,
        toolName: sensitive,
        resourceUri: `http://127.0.0.1:4319/${sensitive}`,
        mediaType: "text/html;profile=mcp-app",
        protocolVersion: "2026-01-26",
        title: sensitive,
      },
      {
        type: "failure",
        id: sensitive,
        code: "artifact_missing",
        message: sensitive,
        relatedPartId: sensitive,
      },
    ]);

    expect(outcomes).toEqual([
      {
        partIndex: 0,
        partType: "attachment",
        status: "failed",
        code: "unsupported_destination",
        message: "Attachment reply parts are unsupported on this destination.",
      },
      {
        partIndex: 1,
        partType: "mcp_app",
        status: "failed",
        code: "unsupported_destination",
        message: "MCP App reply parts are unsupported on this destination.",
      },
      {
        partIndex: 2,
        partType: "failure",
        status: "failed",
        code: "artifact_missing",
        message: "Reply part failed before destination delivery.",
      },
    ]);
    expect(JSON.stringify(outcomes)).not.toContain(sensitive);
    expect(JSON.stringify(outcomes)).not.toContain("deadbeef");
  });

  it("bounds off-contract part counts without silently losing the overflow", () => {
    const oversized = "/private/" + "x".repeat(1_000_000);
    const parts = Array.from({ length: MAX_AGENT_REPLY_PARTS + 7 }, (_, index) => ({
      type: "failure" as const,
      id: `failure-${String(index)}`,
      code: "artifact_publish_failed" as const,
      message: oversized,
    }));

    const outcomes = unsupportedReplyPartDeliveryOutcomes(parts);

    expect(outcomes).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(outcomes?.at(-1)).toEqual({
      partIndex: MAX_AGENT_REPLY_PARTS - 1,
      partType: "unknown",
      status: "failed",
      code: "reply_part_too_large",
      message: "Additional reply parts exceeded the bounded delivery outcome limit.",
      affectedPartCount: 8,
    });
    expect(Buffer.byteLength(JSON.stringify(outcomes), "utf8")).toBeLessThan(5_000);
    expect(JSON.stringify(outcomes)).not.toContain(oversized.slice(0, 100));
  });

  it("densifies sparse source arrays below and above the cap with exact source accounting", () => {
    const below = new Array<AgentReplyPart>(4);
    below[1] = {
      type: "failure",
      id: "known-below",
      code: "artifact_missing",
      message: "not copied",
    };
    below[3] = {
      type: "failure",
      id: "known-below-three",
      code: "artifact_expired",
      message: "not copied",
    };
    const above = new Array<AgentReplyPart>(MAX_AGENT_REPLY_PARTS + 3);
    above[1] = below[1];
    above[MAX_AGENT_REPLY_PARTS] = below[3];

    const belowOutcomes = unsupportedReplyPartDeliveryOutcomes(below);
    const aboveOutcomes = unsupportedReplyPartDeliveryOutcomes(above);

    expect(belowOutcomes).toHaveLength(4);
    expect(belowOutcomes?.map((outcome) => outcome.partIndex)).toEqual([0, 1, 2, 3]);
    expect(belowOutcomes?.[0]).toMatchObject({ partIndex: 0, partType: "unknown" });
    expect(belowOutcomes?.[1]).toMatchObject({ partIndex: 1, partType: "failure", code: "artifact_missing" });
    expect(aboveOutcomes).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(aboveOutcomes?.slice(0, -1).map((outcome) => outcome.partIndex))
      .toEqual(Array.from({ length: MAX_AGENT_REPLY_PARTS - 1 }, (_, index) => index));
    expect(aboveOutcomes?.at(-1)).toMatchObject({
      partIndex: MAX_AGENT_REPLY_PARTS - 1,
      affectedPartCount: 4,
    });
    for (const outcomes of [belowOutcomes, aboveOutcomes]) {
      const serialized = JSON.stringify(outcomes);
      expect(serialized).not.toContain("null");
      expect(JSON.parse(serialized)).toEqual(outcomes);
      expect(outcomes?.length).toBeLessThanOrEqual(MAX_AGENT_REPLY_PARTS);
      expect(isAgentReplyPartDeliveryOutcomes(outcomes)).toBe(true);
    }
  });

  it("independently sanitizes hostile outcome records into the fixed bounded machine shape", () => {
    const sensitive = "/private/report.csv?token=secret";
    const hostile = new Array<unknown>(MAX_AGENT_REPLY_PARTS + 2);
    hostile[0] = {
      partIndex: 999,
      partType: "attachment",
      status: "failed",
      code: "artifact_missing",
      message: sensitive,
      localPath: sensitive,
    };
    hostile[1] = {
      partIndex: 1,
      partType: "failure",
      status: "failed",
      code: "future_code",
      message: sensitive,
    };

    const sanitized = sanitizeReplyPartDeliveryOutcomes(hostile);

    expect(sanitized).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(sanitized?.[0]).toEqual({
      partIndex: 0,
      partType: "attachment",
      status: "failed",
      code: "unsupported_destination",
      message: "Attachment reply parts are unsupported on this destination.",
    });
    expect(sanitized?.[1]).toMatchObject({ partIndex: 1, partType: "unknown", code: "unsupported_destination" });
    expect(sanitized?.at(-1)).toMatchObject({ affectedPartCount: 3 });
    expect(JSON.stringify(sanitized)).not.toContain(sensitive);
    expect(JSON.stringify(sanitized)).not.toContain("future_code");
    expect(isAgentReplyPartDeliveryOutcomes(sanitized)).toBe(true);
    expect(isAgentReplyPartDeliveryOutcomes([{ ...sanitized?.[0], message: sensitive }])).toBe(false);
    expect(isAgentReplyPartDeliveryOutcomes([{ ...sanitized?.[0], future: true }])).toBe(false);
  });

  it("validates JSON-parsed outcome arrays without invoking array property getters", () => {
    const parsed = JSON.parse(JSON.stringify([{
      partIndex: 0,
      partType: "attachment",
      status: "failed",
      code: "unsupported_destination",
      message: "Attachment reply parts are unsupported on this destination.",
    }])) as unknown[];
    let propertyReads = 0;
    const descriptorBacked = new Proxy(parsed, {
      get() {
        propertyReads += 1;
        throw new Error("array properties must be read through data descriptors");
      },
    });

    expect(isAgentReplyPartDeliveryOutcomes(descriptorBacked)).toBe(true);
    expect(propertyReads).toBe(0);
  });

  it("isolates holes, accessors, proxies, and non-array values without disturbing safe siblings", () => {
    let accessorReads = 0;
    const accessorBacked = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorBacked, "status", {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error("must not run");
      },
    });
    const proxyBacked = new Proxy({
      status: "failed",
      partType: "attachment",
    }, {
      getOwnPropertyDescriptor(_target, property) {
        if (property === "status") throw new Error("isolated descriptor failure");
        return undefined;
      },
    });
    const values = new Array<unknown>(6);
    values[1] = null;
    values[2] = accessorBacked;
    values[3] = proxyBacked;
    values[4] = {
      partIndex: 4,
      partType: "failure",
      status: "failed",
      code: "artifact_expired",
      message: "/private/not-copied",
    };
    Object.defineProperty(values, "5", {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error("array accessor must not run");
      },
    });

    const sanitized = sanitizeReplyPartDeliveryOutcomes(values);
    const fromParts = unsupportedReplyPartDeliveryOutcomes(values as readonly AgentReplyPart[]);

    expect(accessorReads).toBe(0);
    expect(sanitized).toHaveLength(6);
    expect(sanitized?.map((outcome) => outcome.partIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sanitized?.slice(0, 4)).toEqual(expect.arrayContaining([
      expect.objectContaining({ partType: "unknown", code: "unsupported_destination" }),
    ]));
    expect(sanitized?.[4]).toMatchObject({ partType: "failure", code: "artifact_expired" });
    expect(fromParts?.[4]).toMatchObject({ partType: "unknown", code: "unsupported_destination" });
    for (const outcomes of [sanitized, fromParts]) {
      const serialized = JSON.stringify(outcomes);
      expect(serialized).not.toContain("null");
      expect(serialized).not.toContain("not-copied");
      expect(JSON.parse(serialized)).toEqual(outcomes);
      expect(isAgentReplyPartDeliveryOutcomes(outcomes)).toBe(true);
    }

    for (const invalid of [undefined, null, {}, { length: 2 }, "outcomes", 42]) {
      expect(sanitizeReplyPartDeliveryOutcomes(invalid)).toBeUndefined();
      expect(isAgentReplyPartDeliveryOutcomes(invalid)).toBe(false);
    }
    expect(isAgentReplyPartDeliveryOutcomes(new Array(1))).toBe(false);
    expect(isAgentReplyPartDeliveryOutcomes(new Array(MAX_AGENT_REPLY_PARTS + 1).fill(sanitized?.[0])))
      .toBe(false);
  });

  it("fails malformed runtime records closed without reading sensitive fields", () => {
    const malformed = {
      type: "future_part",
      localPath: "/private/report.txt",
      capabilityToken: "secret",
    } as unknown as AgentReplyPart;

    expect(unsupportedReplyPartDeliveryOutcomes([malformed])).toEqual([{
      partIndex: 0,
      partType: "unknown",
      status: "failed",
      code: "unsupported_destination",
      message: "Unknown reply parts are unsupported on this destination.",
    }]);
    expect(unsupportedReplyPartDeliveryOutcomes(undefined)).toBeUndefined();
    expect(unsupportedReplyPartDeliveryOutcomes([])).toBeUndefined();
  });
});
