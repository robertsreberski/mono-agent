import { describe, expect, test } from "vitest";

import { timelineEmptyMessage } from "./DetailView";

describe("timelineEmptyMessage", () => {
  test("shows a live waiting state for running runs with no timeline items", () => {
    expect(timelineEmptyMessage("running", 0)).toBe("Waiting for live events...");
  });

  test("shows a captured-empty state for terminal runs with no timeline items", () => {
    expect(timelineEmptyMessage("succeeded", 0)).toBe("No timeline events captured.");
  });

  test("does not show an empty state once timeline items are present", () => {
    expect(timelineEmptyMessage("running", 1)).toBeUndefined();
  });
});
