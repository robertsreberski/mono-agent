import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "../json.js";
describe("parseJsonLoose", () => {
  it("parses a bare array", () => expect(parseJsonLoose('[{"a":1}]')).toEqual([{ a: 1 }]));
  it("parses fenced json with prose", () => expect(parseJsonLoose('Sure!\n```json\n{"x":[1,2]}\n```\nDone')).toEqual({ x: [1, 2] }));
  it("parses an object embedded in prose with braces inside strings", () => expect(parseJsonLoose('result: {"t":"a } b"} ok')).toEqual({ t: "a } b" }));
  it("returns undefined for non-json", () => expect(parseJsonLoose("no json here")).toBeUndefined());
});
