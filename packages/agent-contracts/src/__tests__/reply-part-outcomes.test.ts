import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_REPLY_PARTS,
  unsupportedReplyPartDeliveryOutcomes,
  type AgentReplyPart,
} from "../index.js";

describe("rich reply part delivery outcomes", () => {
  it("emits one sanitized terminal failure for every supported rich-part kind", () => {
    const sensitive = "/Users/private/report.csv?token=secret#sha256:deadbeef";
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
