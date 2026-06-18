import { describe, expect, it } from "vitest";
import { extractEntities } from "../entities.js";
import { fakeLlm } from "./helpers.js";

const GOOD_RESPONSE = JSON.stringify({
  entities: [
    { id: "person:robert", name: "Robert", type: "person" },
    { id: "project:mono-agent", name: "mono-agent", type: "project" },
  ],
  relations: [{ src: "person:robert", dst: "project:mono-agent", relation: "maintains" }],
});

describe("extractEntities", () => {
  it("returns empty extraction for empty text", async () => {
    const result = await extractEntities("", fakeLlm([]));
    expect(result).toEqual({ entities: [], relations: [] });
  });

  it("returns empty extraction for whitespace-only text", async () => {
    const result = await extractEntities("   \n  ", fakeLlm([]));
    expect(result).toEqual({ entities: [], relations: [] });
  });

  it("parses well-formed entities and relations from canned LLM response", async () => {
    const llm = fakeLlm([["entities", GOOD_RESPONSE]]);
    const result = await extractEntities("Robert maintains mono-agent", llm);
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toMatchObject({ id: "person:robert", name: "Robert", type: "person" });
    expect(result.entities[1]).toMatchObject({ id: "project:mono-agent", name: "mono-agent" });
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({ src: "person:robert", dst: "project:mono-agent", relation: "maintains" });
  });

  it("drops entities missing id", async () => {
    const response = JSON.stringify({
      entities: [
        { name: "No ID entity", type: "person" },
        { id: "person:valid", name: "Valid", type: "person" },
      ],
      relations: [],
    });
    const llm = fakeLlm([["entities", response]]);
    const result = await extractEntities("some text", llm);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe("person:valid");
  });

  it("drops entities missing name", async () => {
    const response = JSON.stringify({
      entities: [
        { id: "person:nameless", type: "person" },
        { id: "project:ok", name: "OK Project", type: "project" },
      ],
      relations: [],
    });
    const llm = fakeLlm([["entities", response]]);
    const result = await extractEntities("some text", llm);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe("project:ok");
  });

  it("drops entities with empty id or name", async () => {
    const response = JSON.stringify({
      entities: [
        { id: "", name: "Empty ID", type: "person" },
        { id: "person:ok", name: "", type: "person" },
        { id: "person:real", name: "Real", type: "person" },
      ],
      relations: [],
    });
    const llm = fakeLlm([["entities", response]]);
    const result = await extractEntities("some text", llm);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe("person:real");
  });

  it("drops relations whose src is not among extracted entities", async () => {
    const response = JSON.stringify({
      entities: [{ id: "person:alice", name: "Alice", type: "person" }],
      relations: [
        { src: "person:unknown", dst: "person:alice", relation: "knows" },
        { src: "person:alice", dst: "person:unknown2", relation: "likes" },
      ],
    });
    const llm = fakeLlm([["entities", response]]);
    const result = await extractEntities("some text", llm);
    expect(result.relations).toHaveLength(0);
  });

  it("drops relations whose dst is not among extracted entities", async () => {
    const response = JSON.stringify({
      entities: [
        { id: "person:alice", name: "Alice", type: "person" },
        { id: "person:bob", name: "Bob", type: "person" },
      ],
      relations: [
        { src: "person:alice", dst: "person:bob", relation: "knows" },
        { src: "person:alice", dst: "person:nobody", relation: "hates" },
      ],
    });
    const llm = fakeLlm([["entities", response]]);
    const result = await extractEntities("some text", llm);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({ src: "person:alice", dst: "person:bob", relation: "knows" });
  });

  it("drops relations missing relation field", async () => {
    const response = JSON.stringify({
      entities: [
        { id: "person:alice", name: "Alice", type: "person" },
        { id: "person:bob", name: "Bob", type: "person" },
      ],
      relations: [{ src: "person:alice", dst: "person:bob" }],
    });
    const llm = fakeLlm([["entities", response]]);
    const result = await extractEntities("some text", llm);
    expect(result.relations).toHaveLength(0);
  });

  it("handles fenced JSON response from LLM", async () => {
    const fenced = `Sure, here are the entities:\n\`\`\`json\n${GOOD_RESPONSE}\n\`\`\``;
    const llm = fakeLlm([["entities", fenced]]);
    const result = await extractEntities("Robert maintains mono-agent", llm);
    expect(result.entities).toHaveLength(2);
    expect(result.relations).toHaveLength(1);
  });

  it("returns empty extraction when LLM returns non-JSON", async () => {
    const llm = fakeLlm([["entities", "I cannot extract entities from this text."]]);
    const result = await extractEntities("some text", llm);
    expect(result).toEqual({ entities: [], relations: [] });
  });

  it("never throws on malformed LLM response", async () => {
    const llm = fakeLlm([["entities", "{{{broken json"]]);
    await expect(extractEntities("some text", llm)).resolves.toEqual({ entities: [], relations: [] });
  });

  it("surfaces (rethrows) a model failure from the LLM instead of swallowing to EMPTY", async () => {
    // Malformed *content* (above) is tolerated as EMPTY, but a thrown model error (Ollama down,
    // timeout, 500) must surface so it can be logged — it is not "no entities found".
    const throwingLlm = { id: "throws", complete: async () => { throw new Error("ECONNREFUSED"); } };
    await expect(extractEntities("some text", throwingLlm)).rejects.toThrow(/entit/i);
    await expect(extractEntities("some text", throwingLlm)).rejects.toThrow(/ECONNREFUSED/);
  });
});
