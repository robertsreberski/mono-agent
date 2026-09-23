import { describe, expect, it } from "vitest";
import { formatToolPreview, shortenPreview } from "./tool-preview";

describe("command previews", () => {
  it.each([
    ["cd /repo/my-work && pnpm test", "/repo/my-work", "pnpm test"],
    ["cd '/repo/my work'; pnpm test", "/repo/my work", "pnpm test"],
    ['cd "/repo/my work" && pnpm test', "/repo/my work", "pnpm test"],
  ])("separates leading cd in %s", (input, directory, command) => {
    expect(formatToolPreview("Bash", { command: input })).toMatchObject({ full: command, location: directory, locationLabel: directory.split("/").at(-1) });
    expect(formatToolPreview("Bash", input)).toMatchObject({ full: command, location: directory });
  });

  it("prefers an explicit workdir over the prefix and leaves later cd untouched", () => {
    expect(formatToolPreview("Bash", { command: "cd /old && cd next && pwd", workdir: "/actual/tree" }))
      .toMatchObject({ full: "cd next && pwd", location: "/actual/tree", locationLabel: "tree" });
    expect(formatToolPreview("Bash", { command: "echo start && cd /next; pwd" })?.full)
      .toBe("echo start && cd /next; pwd");
  });

  it("shows the executable and its arguments rather than the path or description", () => {
    expect(formatToolPreview("Exec", { executable: "pnpm", args: ["--dir", "/repo/my work", "test"], workdir: "/repo" }))
      .toMatchObject({ full: "pnpm --dir '/repo/my work' test", location: "/repo" });
  });

  it("keeps the beginning and end of long commands, path tails and prose heads", () => {
    expect(shortenPreview(`pnpm ${"--verbose ".repeat(15)}test`, "command", 25))
      .toMatch(/^pnpm --verbo….*test$/u);
    expect(shortenPreview(`/repo/${"long/".repeat(20)}file.ts`, "path", 25))
      .toMatch(/^….*file\.ts$/u);
    expect(shortenPreview("this is a deliberately long description", "text", 25))
      .toBe("this is a deliberately l…");
    expect(formatToolPreview("Read", { file_path: `/repo/${"deep/".repeat(30)}file.ts` })?.preview.endsWith("file.ts"))
      .toBe(true);
  });
});
