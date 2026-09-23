import { cleanup, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundSubagentJob } from "../test/background-subagent-fixtures";
import "../styles.css";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  api: { threadJob: vi.fn() },
}));
import { api } from "../api";
import { ProcessJobPart } from "./ProcessJob";

const shotDirectory = import.meta.env.VITE_JOB_COMMAND_SHOTS as string | undefined;
type Props = Parameters<typeof ProcessJobPart>[0];
const job = backgroundSubagentJob();
const progress = job.subagentProgress!;
const fixture = { ...job, subagentProgress: { ...progress, revision: 91, toolCalls: 3, failedCalls: 0, recent: [
  { id: "cmd-1", toolName: "Bash", argsSummary: "cd '/synthetic/work tree' && pnpm --filter @mono-agent/web test && pnpm --dir packages/web/webapp run typecheck && node scripts/check-package-architecture.mjs", status: "complete" as const },
  { id: "cmd-2", toolName: "Bash", argsSummary: "pnpm --dir packages/web/webapp run typecheck", workdir: "/synthetic/work tree", status: "running" as const },
  { id: "cmd-3", toolName: "Bash", argsSummary: "echo synthetic fixture result", workdir: "/synthetic/work tree", status: "complete" as const },
] } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("synthetic background agent job commands", () => {
  it.each([{ width: 390, height: 844 }, { width: 1280, height: 900 }])
    ("shows collapsed and expanded commands at $width px", async ({ width, height }) => {
      vi.mocked(api.threadJob).mockImplementation(() => new Promise(() => undefined));
      await page.viewport(width, height);
      const view = render(<section className="process-job-stack" style={{ width: "100%", maxWidth: 720 }}>
        <div className="process-job-stack-body"><div className="process-job-stack-list"><div className="process-job-stack-item">
          <ProcessJobPart {...({ data: { job: fixture } } as unknown as Props)} />
        </div></div></div>
      </section>);
      const card = screen.getByRole("group", { name: "Agent background job running" });
      card.setAttribute("open", "");
      const cluster = view.container.querySelector(".process-job-subagent-progress .activity-step")!;
      expect(cluster.querySelector(".activity-step-summary")?.textContent).toContain("pnpm");
      expect(cluster.querySelector(".process-job-command-location")?.getAttribute("title")).toBe("/synthetic/work tree");
      const displayedPreview = cluster.querySelector(width === 390 ? ".process-job-command-preview-mobile" : ".process-job-command-preview")!;
      expect(displayedPreview.scrollWidth).toBeLessThanOrEqual(displayedPreview.clientWidth + 1);
      if (shotDirectory) await page.elementLocator(view.container.querySelector(".process-job-stack")!).screenshot({ path: `${shotDirectory}/synthetic-job-command-collapsed-${width}.png` });
      cluster.setAttribute("open", "");
      const rows = [...cluster.querySelectorAll(".process-job-subagent-calls li")];
      expect(rows).toHaveLength(3);
      expect(rows[0]!.querySelector(".process-job-subagent-call")?.textContent).toContain("pnpm --filter @mono-agent/web test && pnpm --dir packages/web/webapp run typecheck && node scripts/check-package-architecture.mjs");
      expect(rows[0]!.querySelector(".process-job-subagent-call")?.textContent).not.toContain("cd '/synthetic/work tree'");
      expect(rows[1]!.querySelector(".process-job-subagent-call")?.textContent).toContain("pnpm --dir packages/web/webapp run typecheck");
      expect(rows[1]!.querySelector(".process-job-subagent-status")?.textContent).toBe("running");
      const call = rows[0]!.querySelector(".process-job-subagent-call")!;
      expect(getComputedStyle(call).whiteSpace).toBe("normal");
      expect(rows[0]!.querySelector(".process-job-subagent-status")!.getBoundingClientRect().right)
        .toBeCloseTo(rows[1]!.querySelector(".process-job-subagent-status")!.getBoundingClientRect().right, 0);
      if (shotDirectory) await page.elementLocator(view.container.querySelector(".process-job-stack")!).screenshot({ path: `${shotDirectory}/synthetic-job-command-expanded-${width}.png` });
    });
});
