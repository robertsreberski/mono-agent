import { describe, expect, it } from "vitest";

import { findDuplicateJsonKeyPaths } from "../json-source.js";

describe("findDuplicateJsonKeyPaths", () => {
  it("detects duplicates at root, in nested objects and in arrays of objects", () => {
    expect(findDuplicateJsonKeyPaths(`{
      "root": 1, "root": 2,
      "nested": {"flag": true, "flag": false},
      "items": [{"id": 1, "id": 2}, {"id": 3, "id": 4}]
    }`)).toEqual(["root", "nested.flag", "items[0].id", "items[1].id"]);
  });

  it("compares decoded keys, including escaped quotes and unicode-equivalent spellings", () => {
    expect(findDuplicateJsonKeyPaths(String.raw`{"name": 1, "\u006eame": 2, "obj": {"a\"b": 1, "a\u0022b": 2}}`))
      .toEqual(["name", 'obj["a\\"b"]']);
  });

  it("does not confuse values with keys or keys in sibling objects", () => {
    expect(findDuplicateJsonKeyPaths(`{"left":{"id":"id"},"right":{"id":"left"},"items":[{"id":1},{"id":2}]}`))
      .toEqual([]);
  });
});
