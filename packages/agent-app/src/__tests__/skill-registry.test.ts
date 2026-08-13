import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import type { SkillIndexEntry } from "@mono-agent/agent-harness";

import {
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_REGISTRY_BYTES,
  MAX_SKILL_REGISTRY_ITEMS,
  buildSkillRegistry,
  createSkillRegistryMonitor,
  isReadSkillDenied,
} from "../skill-registry.js";

function skill(name: string, description = `${name} description`): SkillIndexEntry {
  return { name, description, mainFile: `/private/skills/${name}/SKILL.md` };
}

describe("buildSkillRegistry", () => {
  it("classifies canonical skills from disclosure and tool policy without leaking paths", () => {
    const registry = buildSkillRegistry([
      skill("unused"),
      skill("Selected"),
      skill("plugin:legacy"),
    ], {
      selectedSkills: ["selected"],
      skillDisclosure: "index",
      readSkillDenied: false,
    });

    expect(registry).toEqual({
      status: "ready",
      items: [
        {
          name: "Selected",
          description: "Selected description",
          availability: "inlined",
          reference: "$Selected",
        },
        {
          name: "unused",
          description: "unused description",
          availability: "on-demand",
          reference: "$unused",
        },
        {
          name: "plugin:legacy",
          description: "plugin:legacy description",
          availability: "unavailable",
          unavailableReason: "unsupported-name",
        },
      ],
      total: 3,
    });
    expect(JSON.stringify(registry)).not.toContain("/private/skills");
  });

  it("marks unselected skills unavailable in full disclosure or when ReadSkill is denied", () => {
    expect(buildSkillRegistry([skill("research")], {
      selectedSkills: [],
      skillDisclosure: "full",
      readSkillDenied: false,
    }).items[0]).toMatchObject({
      availability: "unavailable",
      unavailableReason: "not-selected",
    });
    expect(buildSkillRegistry([skill("research")], {
      selectedSkills: [],
      skillDisclosure: "index",
      readSkillDenied: true,
    }).items[0]).toMatchObject({
      availability: "unavailable",
      unavailableReason: "read-skill-disabled",
    });
  });

  it("bounds item count, UTF-8 descriptions, and the serialized registry", () => {
    const entries = Array.from({ length: MAX_SKILL_REGISTRY_ITEMS + 20 }, (_, index) =>
      skill(`skill-${String(index).padStart(3, "0")}`, "🧭".repeat(200)));
    const registry = buildSkillRegistry(entries, {
      selectedSkills: [],
      skillDisclosure: "index",
      readSkillDenied: false,
    });

    expect(registry.status).toBe("ready");
    expect(registry.items).toHaveLength(MAX_SKILL_REGISTRY_ITEMS);
    expect(registry).toMatchObject({ total: entries.length, truncated: true });
    expect(registry.items.every((item) =>
      Buffer.byteLength(item.description, "utf8") <= MAX_SKILL_DESCRIPTION_BYTES)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(registry), "utf8")).toBeLessThanOrEqual(
      MAX_SKILL_REGISTRY_BYTES,
    );
  });
});

describe("createSkillRegistryMonitor", () => {
  it("publishes an empty ready snapshot when no skills root is configured", async () => {
    const monitor = createSkillRegistryMonitor({
      selectedSkills: [],
      disallowedTools: [],
    });

    await monitor.prime();
    expect(monitor.snapshot()).toEqual({ status: "ready", items: [], total: 0 });
  });

  it("reloads only when the signature changes and retries after loader errors", async () => {
    const readSignature = vi.fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two")
      .mockResolvedValueOnce("two");
    const loadIndex = vi.fn()
      .mockResolvedValueOnce([skill("first")])
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([skill("second")]);
    const warn = vi.fn();
    const monitor = createSkillRegistryMonitor({
      skillsRoot: "/skills",
      selectedSkills: [],
      skillDisclosure: "index",
      disallowedTools: [],
      readSignature,
      loadIndex,
      logger: { warn },
    });

    await monitor.prime();
    await monitor.refresh();
    expect(loadIndex).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().items[0]?.name).toBe("first");

    await monitor.refresh();
    expect(monitor.snapshot()).toEqual({ status: "error", items: [] });
    expect(warn).toHaveBeenCalledWith("Skill registry refresh failed.", { error: "transient" });

    await monitor.refresh();
    expect(loadIndex).toHaveBeenCalledTimes(3);
    expect(monitor.snapshot().items[0]?.name).toBe("second");
  });

  it("polls for changed skill files until stopped", async () => {
    vi.useFakeTimers();
    const readSignature = vi.fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two");
    const loadIndex = vi.fn()
      .mockResolvedValueOnce([skill("first")])
      .mockResolvedValueOnce([skill("second")]);
    const monitor = createSkillRegistryMonitor({
      skillsRoot: "/skills",
      selectedSkills: [],
      skillDisclosure: "index",
      disallowedTools: [],
      readSignature,
      loadIndex,
      refreshMs: 50,
    });

    try {
      await monitor.prime();
      monitor.start();
      await vi.advanceTimersByTimeAsync(50);
      expect(monitor.snapshot().items[0]?.name).toBe("second");

      monitor.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(readSignature).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
      vi.useRealTimers();
    }
  });
});

describe("isReadSkillDenied", () => {
  it("recognizes canonical and legacy deny spellings without matching unrelated tools", () => {
    expect(isReadSkillDenied(["ReadSkill"])).toBe(true);
    expect(isReadSkillDenied(["read_skill"])).toBe(true);
    expect(isReadSkillDenied(["Read"])).toBe(false);
  });
});
