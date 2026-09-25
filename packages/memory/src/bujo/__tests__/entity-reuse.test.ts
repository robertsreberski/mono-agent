import { describe, expect, it } from "vitest";

import { extractCapturePlanStrict } from "../capture-batch.js";
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
  { id: "person:robin", name: "Robin", type: "person", createdAt: "2026-06-01T00:00:00.000Z" },
  { id: "org:example", name: "Example Corp", type: "org", createdAt: "2026-06-01T00:00:00.000Z" },
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

  it("offers same-name entities as separate ids instead of inventing an alias merge", () => {
    const graph = [
      { id: "person:alex-design", name: "Alex", type: "person", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "person:alex-operations", name: "Alex", type: "person", createdAt: "2026-02-01T00:00:00.000Z" },
    ];

    expect(selectKnownEntityHints("Alex changed the rollout notes", graph).map((hint) => hint.id))
      .toEqual(["person:alex-operations", "person:alex-design"]);
  });

  it("names the most-associated id as preferred when several ids share one folded name", () => {
    // Fictional: one person captured three times under different ids and types.
    const graph = [
      { id: "concept:morgan", name: "Morgan", type: "concept", createdAt: "2026-03-01T00:00:00.000Z", associations: 2 },
      { id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-01-01T00:00:00.000Z", associations: 9 },
      { id: "person:morgan-2", name: "morgan ", type: "person", createdAt: "2026-04-01T00:00:00.000Z", associations: 1 },
      { id: "place:maple-street", name: "Maple Street", type: "place", createdAt: "2026-04-01T00:00:00.000Z", associations: 5 },
    ];
    const hints = selectKnownEntityHints("Morgan walked down Maple Street", graph);

    expect(hints.map((hint) => hint.id)).toEqual(["place:maple-street", "person:morgan", "concept:morgan", "person:morgan-2"]);
    expect(hints.map((hint) => hint.preferredId)).toEqual([undefined, undefined, "person:morgan", "person:morgan"]);
    const block = renderKnownEntityHints(hints);
    expect(block).toContain("- person:morgan — Morgan (person) — preferred id for this name");
    expect(block).toContain("- concept:morgan — Morgan (concept) — duplicate name; reuse person:morgan unless this is a different thing");
    expect(block).toContain("- place:maple-street — Maple Street (place)\n");
    expect(selectKnownEntityHints("Morgan walked down Maple Street", [...graph].reverse())).toEqual(hints);
  });

  it("keeps an established entity ahead of many newer one-off ids that share a word", () => {
    const tasks = Array.from({ length: 40 }, (_, index) => ({ id: `task:morgan-errand-${index}`, name: `Morgan errand ${index}`,
      type: "task", createdAt: `2026-09-${String(10 + (index % 20)).padStart(2, "0")}T00:00:00.000Z`, associations: index % 2 }));
    const graph = [{ id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-01-01T00:00:00.000Z", associations: 50 }, ...tasks];
    expect(selectKnownEntityHints("Morgan has a cold", graph)[0]?.id).toBe("person:morgan");
  });

  it("breaks an association tie with the ordinary deterministic order", () => {
    const graph = [
      { id: "person:morgan-a", name: "Morgan", type: "person", createdAt: "2026-01-01T00:00:00.000Z", associations: 3 },
      { id: "person:morgan-b", name: "Morgan", type: "person", createdAt: "2026-02-01T00:00:00.000Z", associations: 3 },
    ];
    const hints = selectKnownEntityHints("Morgan called", graph);
    expect(hints.map((hint) => [hint.id, hint.preferredId])).toEqual([["person:morgan-b", undefined], ["person:morgan-a", "person:morgan-b"]]);
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

    await extractCapturePlanStrict(
      "The blackout curtain parcel arrives today.",
      llm,
      undefined,
      selectKnownEntityHints("The blackout curtain parcel arrives today.", CURTAIN_GRAPH),
    );

    expect(prompts[0]).toContain("KNOWN ENTITIES");
    expect(prompts[0]).toContain("project:black-curtains");
    expect(prompts[0]).toContain("reuse that exact id");
    expect(prompts[0]).not.toContain("org:example");
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

    await extractCapturePlanStrict("A brand new subject.", llm);

    expect(prompts[0]).not.toContain("KNOWN ENTITIES");
    expect(prompts[0]).toContain("TURN:");
  });

  it("keeps a reused id through strict completed-turn extraction", async () => {
    const hints = selectKnownEntityHints("curtains", CURTAIN_GRAPH);
    const strict = await extractCapturePlanStrict("curtains", fakeLlm([["Extract one bounded", response]]), undefined, hints);

    for (const plan of [strict]) {
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
