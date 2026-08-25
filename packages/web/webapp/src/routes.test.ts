import { describe, expect, it } from "vitest";
import { parseRoute, routePath, type ConsoleRoute } from "./routes";

describe("console routes", () => {
  it.each<ConsoleRoute>([
    { view: "chats" },
    { view: "chats", threadId: "thread / one" },
    { view: "chats", cron: { sourceId: "agent / one", jobId: "daily/report" } },
    { view: "board" },
  ])("round-trips $view", (route) => {
    expect(parseRoute(routePath(route))).toEqual(route);
  });

  it("routes unknown, malformed, and excluded memory paths to Chats", () => {
    expect(parseRoute("/memory")).toEqual({ view: "chats" });
    expect(parseRoute("/threads/%E0%A4%A")).toEqual({ view: "chats" });
    expect(parseRoute("/something-else")).toEqual({ view: "chats" });
  });
});
