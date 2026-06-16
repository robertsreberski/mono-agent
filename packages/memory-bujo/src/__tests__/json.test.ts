import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "../json.js";
describe("parseJsonLoose", () => {
  it("parses a bare array", () => expect(parseJsonLoose('[{"a":1}]')).toEqual([{ a: 1 }]));
  it("parses fenced json with prose", () => expect(parseJsonLoose('Sure!\n```json\n{"x":[1,2]}\n```\nDone')).toEqual({ x: [1, 2] }));
  it("parses an object embedded in prose with braces inside strings", () => expect(parseJsonLoose('result: {"t":"a } b"} ok')).toEqual({ t: "a } b" }));
  it("returns undefined for non-json", () => expect(parseJsonLoose("no json here")).toBeUndefined());
  it("skips prose/pseudocode brackets before the real JSON", () => {
    expect(parseJsonLoose('According to [research] the data is: {"result": true}')).toEqual({ result: true });
    expect(parseJsonLoose("Example: {x: 1} is pseudocode. Real: {\"x\": 1}")).toEqual({ x: 1 });
    expect(parseJsonLoose('See [link](url) and {fake} before {"data": [1,2]}')).toEqual({ data: [1, 2] });
  });
  it("prefers the largest parseable value over a trivial leading citation", () => {
    expect(parseJsonLoose('Rated [5] stars: [{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
