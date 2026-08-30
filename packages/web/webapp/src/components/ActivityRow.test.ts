import { describe, expect, it } from "vitest";
import { clusterSummary, failedLabel, toolVerb } from "./ActivityRow";

describe("toolVerb", () => {
  it("names known tools from the table rather than guessing at them", () => {
    // Substring-matching once turned this into "Search", which is another tool.
    expect(toolVerb("memory_search")).toBe("Memory search");
    expect(toolVerb("read_file")).toBe("Read");
  });

  it("de-underscores an unlisted tool instead of renaming it", () => {
    expect(toolVerb("inspect_workspace")).toBe("Inspect workspace");
    expect(toolVerb("Bash")).toBe("Bash");
    expect(toolVerb("SessionHistory")).toBe("SessionHistory");
  });
});

describe("clusterSummary", () => {
  it("shortens paths to their leaf and counts the overflow", () => {
    expect(clusterSummary(["blog/outline.md", "blog/voice.md", "a/x.md", "b/y.md"]))
      .toBe("outline.md, voice.md +2");
  });

  it("dedupes on the leaf, so the same file from two directories counts once", () => {
    expect(clusterSummary(["blog/outline.md", "docs/outline.md"])).toBe("outline.md");
  });

  it("leaves anything that is not a path alone", () => {
    // A preview is whatever argument the tool got. Chopping these to their last
    // slash-segment would render "repo", ".*" and "users" instead.
    expect(clusterSummary(["git clone https://host/org/repo"]))
      .toBe("git clone https://host/org/repo");
    expect(clusterSummary([".*/src/.*"])).toBe(".*/src/.*");
    expect(clusterSummary(["https://api.example.com/v1/users"]))
      .toBe("https://api.example.com/v1/users");
  });

  it("keeps a summary containing a middle dot whole", () => {
    expect(clusterSummary(['echo "a · b"'])).toBe('echo "a · b"');
  });

  it("shortens a path whose segments are not ASCII", () => {
    expect(clusterSummary(["café/menu.txt"])).toBe("menu.txt");
    expect(clusterSummary(["\u8def\u5f84/\u6587\u4ef6.txt"])).toBe("\u6587\u4ef6.txt");
  });

  it("leaves a date or a fraction alone, which have slashes but no leaf", () => {
    expect(clusterSummary(["2026/08/30"])).toBe("2026/08/30");
    expect(clusterSummary(["1/2"])).toBe("1/2");
    // A numeric directory inside a real path is still a path.
    expect(clusterSummary(["src/2026/report.md"])).toBe("report.md");
  });

  it("still shortens absolute and relative paths", () => {
    expect(clusterSummary(["/repo/src/store.ts"])).toBe("store.ts");
    expect(clusterSummary(["./docs/index.md"])).toBe("index.md");
    expect(clusterSummary(["~/notes/today.md"])).toBe("today.md");
  });

  it("says nothing when no member had a previewable argument", () => {
    expect(clusterSummary([])).toBeUndefined();
    expect(clusterSummary(["", ""])).toBeUndefined();
  });
});

describe("failedLabel", () => {
  it("counts failures in a cluster and names a lone one", () => {
    expect(failedLabel(0, true)).toBeUndefined();
    expect(failedLabel(0, false)).toBeUndefined();
    expect(failedLabel(3, true)).toBe("3 failed");
    expect(failedLabel(1, false)).toBe("failed");
  });
});
