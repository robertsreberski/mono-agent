import {
  MAX_AGENT_REPLY_PARTS,
  type AgentReplyAttachmentPart,
} from "@mono-agent/agent-contracts";
import { describe, expect, it } from "vitest";

import { createReplyPartBudget, mergeReplyParts } from "../reply-part-budget.js";

describe("shared reply-part budget", () => {
  it("enforces one exact boundary across independent producers without charging retries", () => {
    const budget = createReplyPartBudget();
    const artifactProducer = budget;
    const appProducer = budget;

    for (let index = 0; index < 12; index += 1) {
      expect(artifactProducer.claim("run", `attachment:${String(index)}`)).toBe("accepted");
    }
    expect(artifactProducer.claim("run", "attachment:0")).toBe("duplicate");
    for (let index = 0; index < 8; index += 1) {
      expect(appProducer.claim("run", `mcp_app:${String(index)}`)).toBe("accepted");
    }
    expect(appProducer.claim("run", "mcp_app:over-cap")).toBe("limit");

    artifactProducer.unclaim("run", "attachment:11");
    expect(appProducer.claim("run", "mcp_app:replacement")).toBe("accepted");
    budget.release("run");
    expect(appProducer.claim("run", "mcp_app:fresh")).toBe("accepted");
  });

  it("keeps first-seen retry parts and bounds finalization without replacing valid prior parts", () => {
    const attachment = (
      id: string,
      integrityId = `sha256:${id.padStart(64, "0")}`,
    ): AgentReplyAttachmentPart => ({
      type: "attachment",
      id,
      reference: { scheme: "mono-agent-artifact", id: `00000000-0000-4000-8000-${id.padStart(12, "0")}` },
      name: `${id}.txt`,
      mediaType: "text/plain",
      sizeBytes: 1,
      integrityId,
    });
    const existing = Array.from({ length: 15 }, (_, index) => attachment(String(index)));
    const retryDuplicate = attachment("retry-id", existing[0]!.integrityId);
    const produced = [
      retryDuplicate,
      ...Array.from({ length: 10 }, (_, index) => attachment(`new-${String(index)}`)),
    ];

    const merged = mergeReplyParts(existing, produced);

    expect(merged).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(merged.slice(0, existing.length)).toEqual(existing);
    expect(merged).not.toContain(retryDuplicate);
    expect(merged.filter((part) => part.type === "attachment" && part.integrityId === existing[0]!.integrityId))
      .toHaveLength(1);
  });
});
