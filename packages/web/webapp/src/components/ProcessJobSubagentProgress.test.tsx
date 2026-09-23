import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProcessJobSubagentProgress as Progress } from "../types";
import { ProcessJobMetaLine, ProcessJobSubagentProgress } from "./ProcessJobSubagentProgress";

const directory = "/synthetic/worktrees/mono-agent/job-card-command-display";
const progress: Progress = {
  revision: 2, profile: "implementer", toolCalls: 3, failedCalls: 0,
  recent: [
    { id: "one", toolName: "Bash", argsSummary: `cd '${directory}' && pnpm test`, status: "running" },
    { id: "two", toolName: "Exec", argsSummary: "pnpm --dir packages/web test", workdir: "/synthetic/worktrees/other", status: "complete" },
    { id: "three", toolName: "Read", argsSummary: "/synthetic/src/file.ts", status: "running" },
  ],
};

describe("background agent job directory", () => {
  it("puts only the running command's directory in metadata and per-call tooltips", () => {
    const view = render(<><ProcessJobMetaLine progress={progress} status="running" />
      <ProcessJobSubagentProgress progress={progress} open /></>);
    const meta = view.container.querySelector(".process-job-live-meta")!;
    expect(meta.querySelector(".process-job-child-directory")?.textContent).toBe("job-card-command-display");
    expect(meta.querySelector(".process-job-child-directory")?.getAttribute("title")).toBe(directory);
    expect(meta.querySelector(".process-job-child-directory")?.getAttribute("aria-label")).toBe(`Directory: ${directory}`);
    const bash = view.container.querySelector(".process-job-subagent-calls li")!;
    expect(bash.textContent).toBe("pnpm testrunning");
    expect(bash.getAttribute("title")).toBe(directory);
    expect(view.container.querySelector(".process-job-command-location")).toBeNull();
    expect(view.container.querySelector(".activity-step-summary")?.textContent).not.toContain("job-card-command-display");
  });

  it("uses the latest command with a directory after the running call settles and omits absent directories", () => {
    const settled: Progress = { ...progress, revision: 3,
      recent: progress.recent.map((call) => ({ ...call, status: "complete" as const })) };
    const view = render(<ProcessJobMetaLine progress={settled} status="complete" />);
    expect(view.container.querySelector(".process-job-child-directory")?.textContent).toBe("other");
    expect(view.container.querySelector(".process-job-child-directory")?.getAttribute("title"))
      .toBe("/synthetic/worktrees/other");
    view.rerender(<ProcessJobMetaLine progress={{ ...settled, recent: [settled.recent[2]!] }} status="complete" />);
    expect(view.container.querySelector(".process-job-child-directory")).toBeNull();
  });
});
