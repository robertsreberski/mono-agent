import { describe, expect, it } from "vitest";

import { extractCapturePlan, extractCapturePlanStrict } from "../capture-batch.js";
import {
  MAX_KNOWN_ENTITY_HINTS,
  renderKnownEntityHints,
  selectKnownEntityHints,
} from "../entity-reuse.js";
import { fakeLlm } from "./helpers.js";

/**
 * The regression these hints exist for: one set of curtains became three
 * unrelated nodes across two days because extraction never saw the graph.
 */
const CURTAIN_GRAPH = [
  { id: "project:black-curtains", name: "black blackout curtains", type: "project", createdAt: "2026-07-28T13:07:27.215Z" },
  { id: "object:curtain", name: "400 x 200 cm curtain", type: "object", createdAt: "2026-07-28T13:10:08.950Z" },
  { id: "person:paola", name: "Paola", type: "person", createdAt: "2026-06-01T00:00:00.000Z" },
  { id: "org:automattic", name: "Automattic", type: "org", createdAt: "2026-06-01T00:00:00.000Z" },
];

describe("selectKnownEntityHints", () => {
  it("surfaces the entities a turn actually mentions and ignores the rest", () => {
    const hints = selectKnownEntityHints(
      "Amazon order 408-1107737-0672351 includes two magnetic blackout curtain panels.",
      CURTAIN_GRAPH,
    );

    expect(hints.map((hint) => hint.id)).toEqual(["project:black-curtains", "object:curtain"]);
    expect(hints.every((hint) => hint.name.length > 0)).toBe(true);
  });

  it("folds trivial plurals so a stored singular still matches", () => {
    const singular = selectKnownEntityHints("the curtain arrived", CURTAIN_GRAPH).map((hint) => hint.id);
    const plural = selectKnownEntityHints("the curtains arrived", CURTAIN_GRAPH).map((hint) => hint.id);

    expect(singular).toContain("object:curtain");
    expect(plural).toContain("object:curtain");
    expect(plural).toContain("project:black-curtains");
  });

  it("offers nothing when the turn shares no token, rather than guessing", () => {
    // Offering unrelated ids would invite the model to attach a fact to the
    // wrong node — strictly worse than the duplicate this feature prevents.
    expect(selectKnownEntityHints("The build pipeline is green again.", CURTAIN_GRAPH)).toEqual([]);
    expect(selectKnownEntityHints("", CURTAIN_GRAPH)).toEqual([]);
    expect(selectKnownEntityHints("curtain", [])).toEqual([]);
  });

  it("ranks stronger overlap first and breaks ties deterministically", () => {
    const graph = [
      { id: "topic:one", name: "shared", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic:two", name: "shared", createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "topic:strong", name: "shared blackout curtain", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const hints = selectKnownEntityHints("shared blackout curtain", graph).map((hint) => hint.id);

    // Best overlap wins; equal scores fall back to most recent, then id.
    expect(hints[0]).toBe("topic:strong");
    expect(hints.slice(1)).toEqual(["topic:two", "topic:one"]);
    expect(selectKnownEntityHints("shared blackout curtain", graph)).toEqual(
      selectKnownEntityHints("shared blackout curtain", graph),
    );
  });

  it("bounds how many hints reach the prompt", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      id: `topic:curtain-${index}`,
      name: `curtain variant ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    expect(selectKnownEntityHints("curtain", many)).toHaveLength(MAX_KNOWN_ENTITY_HINTS);
    expect(selectKnownEntityHints("curtain", many, 3)).toHaveLength(3);
    expect(selectKnownEntityHints("curtain", many, 0)).toEqual([]);
  });

  it("skips duplicate and malformed rows without throwing", () => {
    const hints = selectKnownEntityHints("curtain", [
      { id: "object:curtain", name: "curtain", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "object:curtain", name: "curtain duplicate", createdAt: "2026-02-01T00:00:00.000Z" },
      ...([{ id: 42, name: "curtain" }, { name: "curtain" }, null] as never[]),
    ]);

    expect(hints.map((hint) => hint.id)).toEqual(["object:curtain"]);
    expect(hints[0]?.name).toBe("curtain");
  });
});

describe("renderKnownEntityHints", () => {
  it("renders nothing for an empty set", () => {
    expect(renderKnownEntityHints([])).toBe("");
  });

  it("lists each id with its established name and type", () => {
    const block = renderKnownEntityHints([
      { id: "object:curtain", name: "400 x 200 cm curtain", type: "object" },
      { id: "topic:untyped", name: "untyped thing" },
    ]);

    expect(block).toContain("- object:curtain — 400 x 200 cm curtain (object)");
    expect(block).toContain("- topic:untyped — untyped thing");
  });

  it("clamps a long name so one entity cannot dominate the prompt", () => {
    const block = renderKnownEntityHints([{ id: "topic:long", name: "x".repeat(400) }]);
    expect(block).toContain("…");
    expect(block.length).toBeLessThan(200);
  });
});

describe("capture extraction with reuse hints", () => {
  const response = JSON.stringify({
    memories: [{
      type: "note",
      text: "The blackout curtains arrive today.",
      salience: 0.8,
      isInsight: false,
      entityIds: ["project:black-curtains"],
    }],
    entities: [{ id: "project:black-curtains", name: "black blackout curtains", type: "project" }],
    relations: [],
  });

  it("puts the known ids and the reuse rule in front of the model", async () => {
    const prompts: string[] = [];
    const llm = {
      id: "recording",
      complete: async (prompt: string) => {
        prompts.push(prompt);
        return response;
      },
    };

    await extractCapturePlan(
      "The blackout curtain parcel arrives today.",
      llm,
      undefined,
      selectKnownEntityHints("The blackout curtain parcel arrives today.", CURTAIN_GRAPH),
    );

    expect(prompts[0]).toContain("KNOWN ENTITIES");
    expect(prompts[0]).toContain("project:black-curtains");
    expect(prompts[0]).toContain("reuse that exact id");
    expect(prompts[0]).not.toContain("org:automattic");
  });

  it("omits the block entirely when there is nothing known to reuse", async () => {
    const prompts: string[] = [];
    const llm = {
      id: "recording",
      complete: async (prompt: string) => {
        prompts.push(prompt);
        return response;
      },
    };

    await extractCapturePlan("A brand new subject.", llm);

    expect(prompts[0]).not.toContain("KNOWN ENTITIES");
    expect(prompts[0]).toContain("TURN:");
  });

  it("keeps a reused id through both the lenient and strict paths", async () => {
    const hints = selectKnownEntityHints("curtains", CURTAIN_GRAPH);
    const lenient = await extractCapturePlan("curtains", fakeLlm([["Extract one bounded", response]]), undefined, hints);
    const strict = await extractCapturePlanStrict("curtains", fakeLlm([["Extract one bounded", response]]), undefined, hints);

    for (const plan of [lenient, strict]) {
      expect(plan.entities.map((entity) => entity.id)).toEqual(["project:black-curtains"]);
      expect(plan.candidates[0]?.entityIds).toEqual(["project:black-curtains"]);
    }
  });

  it("hints never relax validation of what the model returns", async () => {
    const bogus = JSON.stringify({
      memories: [],
      entities: [{ id: "Not A Valid Id", name: "bogus", type: "project" }],
      relations: [],
    });

    await expect(extractCapturePlanStrict(
      "curtains",
      fakeLlm([["Extract one bounded", bogus]]),
      undefined,
      selectKnownEntityHints("curtains", CURTAIN_GRAPH),
    )).rejects.toThrow();
  });
});
