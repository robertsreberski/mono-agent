import { describe, expect, it } from "vitest";
import { thread } from "./test/fixtures";
import { threadPresentation, threadRowExcerpt } from "./thread-presentation";
import type { JobActivity, ThreadSummary } from "./types";

const present = (overrides: Partial<ThreadSummary> = {}) =>
  threadPresentation(thread("test", "agent", overrides));
const ended = "2026-09-07T10:00:00.000Z";
const later = "2026-09-07T10:01:00.000Z";
const jobs = (overrides: Partial<JobActivity> = {}): JobActivity =>
  ({ queued: 0, starting: 0, running: 0, ...overrides });

describe("conversation status presentation", () => {
  it("distinguishes no meaningful outcome from missing historical metadata", () => {
    const base = { runState: { status: "complete" as const, finishedAt: later },
      jobActivity: jobs({ latestTerminal: { state: "failed" as const, completedAt: ended } }) };
    expect(present(base)).toEqual({ text: "", active: false });
    expect(present({ ...base, runState: { ...base.runState, lastOutcome: null } }))
      .toEqual({ text: "Background job failed", active: false });
    expect(present({ runState: { status: "complete", finishedAt: later,
      lastOutcome: { status: "failed", finishedAt: ended } } }))
      .toEqual({ text: "Failed", active: false });
    expect(present({ runState: { status: "complete", finishedAt: later,
      lastOutcome: { status: "failed", finishedAt: ended } }, jobActivity: jobs({ running: 1 }) }))
      .toEqual({ text: "Failed · 1 background job running", active: true });
  });
  it.each(["failed", "cancelled", "interrupted"] as const)(
    "shows %s instead of an older reply or a message count", (status) => {
      for (const lastMessagePreview of [undefined, "An older answer"]) {
        const result = present({ runState: { status }, messageCount: 8, lastMessagePreview });
        expect(result).toEqual({ text: status[0]!.toUpperCase() + status.slice(1), active: false });
      }
    },
  );

  it.each(["queued", "starting", "running"] as const)(
    "keeps a %s background job active after the foreground completes", (state) => {
      expect(present({
        runState: { status: "complete" },
        lastMessagePreview: "I started the worker.",
        jobActivity: jobs({ [state]: 1 }),
      })).toEqual({ text: "1 background job " + state, active: true });
    },
  );

  it("shows foreground and mixed background work together", () => {
    expect(present({
      runState: { status: "running" },
      lastMessagePreview: "Older answer",
      jobActivity: jobs({ running: 2, starting: 1, queued: 3 }),
    })).toEqual({
      text: "Working… · 2 background jobs running · 1 background job starting · 3 background jobs queued",
      active: true,
    });
  });

  it("keeps a failed foreground prompt visible while background work remains", () => {
    expect(present({
      runState: { status: "failed", finishedAt: later },
      jobActivity: jobs({ running: 1 }),
    })).toEqual({ text: "Failed · 1 background job running", active: true });
  });

  it.each([
    ["failed", "Background job failed"],
    ["timed_out", "Background job timed out"],
    ["cancelled", "Background job cancelled"],
    ["spawn_failed", "Background job failed to start"],
    ["queue_expired", "Background job expired in queue"],
    ["interrupted", "Background job interrupted"],
  ] as const)("shows the latest background outcome %s", (state, text) => {
    expect(present({
      runState: { status: "complete", finishedAt: ended },
      lastMessagePreview: "Older answer",
      jobActivity: jobs({ latestTerminal: { state, completedAt: later } }),
    })).toEqual({ text, active: false });
  });

  it("omits idle status when a newer successful follow-up supersedes an older job failure", () => {
    expect(present({
      runState: { status: "complete", finishedAt: later },
      lastMessagePreview: "Recovered successfully",
      jobActivity: jobs({ latestTerminal: { state: "failed", completedAt: ended } }),
    })).toEqual({ text: "", active: false });
  });

  it("omits idle status rather than a completed job reply", () => {
    expect(present({
      runState: { status: "failed", finishedAt: ended },
      lastMessagePreview: "Older message",
      jobActivity: jobs({ latestTerminal: {
        state: "succeeded", completedAt: later, replyPreview: "Worker results",
      } }),
    })).toEqual({ text: "", active: false });
  });

  it("omits idle status for a textless job instead of reusing an older reply", () => {
    expect(present({
      lastMessagePreview: "An earlier prompt",
      jobActivity: jobs({ latestTerminal: { state: "succeeded", completedAt: later } }),
    })).toEqual({ text: "", active: false });
  });

  it("compares completion instants and gives the foreground reply a timestamp tie", () => {
    expect(present({
      runState: { status: "complete", finishedAt: "2026-09-07T12:00:00.000+02:00" },
      lastMessagePreview: "Final answer",
      jobActivity: jobs({ latestTerminal: { state: "failed", completedAt: ended } }),
    })).toEqual({ text: "", active: false });
  });

  it("uses meaningful fallbacks without job metadata, including older cached summaries", () => {
    expect(present()).toEqual({ text: "New conversation", active: false });
    expect(present({ messageCount: 2, lastMessagePreview: "Private prompt excerpt" })).toEqual({ text: "No reply yet", active: false });
    expect(present({ runState: { status: "running" } })).toEqual({ text: "Working…", active: true });
    expect(present({ runState: { status: "complete" }, messageCount: 2 }))
      .toEqual({ text: "", active: false });
    expect(present({ runState: { status: "complete" }, lastMessagePreview: "Answer" }))
      .toEqual({ text: "", active: false });
  });
});

describe("conversation row excerpts", () => {
  const excerpt = (overrides: Partial<ThreadSummary> = {}) =>
    threadRowExcerpt(thread("test", "agent", overrides));

  it("shows the newest reply exactly where the status line stays empty", () => {
    expect(excerpt({ runState: { status: "complete" }, lastMessagePreview: "Done and dusted." }))
      .toBe("Done and dusted.");
    // A settled background success speaks through the same slot, and through
    // the foreground preview rather than the job card's own words.
    expect(excerpt({
      runState: { status: "complete", finishedAt: ended },
      lastMessagePreview: "Older answer",
      jobActivity: jobs({ latestTerminal: { state: "succeeded", completedAt: later,
        replyPreview: "Worker results" } }),
    })).toBe("Older answer");
  });

  it("collapses the preview to one line and treats blank as absent", () => {
    expect(excerpt({ runState: { status: "complete" },
      lastMessagePreview: "  First line\n\tsecond   line  " }))
      .toBe("First line second line");
    expect(excerpt({ runState: { status: "complete" } })).toBeUndefined();
    expect(excerpt({ runState: { status: "complete" }, lastMessagePreview: "   \n  " }))
      .toBeUndefined();
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "keeps the %s word instead of an excerpt", (status) => {
      expect(excerpt({ runState: { status }, messageCount: 8,
        lastMessagePreview: "An older answer" })).toBeUndefined();
    },
  );

  it("never talks over work the status line still describes", () => {
    expect(excerpt({ runState: { status: "running" }, lastMessagePreview: "Older answer" }))
      .toBeUndefined();
    for (const state of ["queued", "starting", "running"] as const) {
      expect(excerpt({ runState: { status: "complete" }, lastMessagePreview: "Older answer",
        jobActivity: jobs({ [state]: 1 }) })).toBeUndefined();
    }
    expect(excerpt({
      runState: { status: "complete", finishedAt: ended },
      lastMessagePreview: "Older answer",
      jobActivity: jobs({ latestTerminal: { state: "failed", completedAt: later } }),
    })).toBeUndefined();
  });

  it("stays out of the rows that never settled on a success", () => {
    expect(excerpt()).toBeUndefined();
    expect(excerpt({ messageCount: 2, lastMessagePreview: "Private prompt excerpt" }))
      .toBeUndefined();
  });
});
