import { describe, expect, it, vi } from "vitest";
import {
  AGENT_RAIL_DEFAULT_WIDTH,
  AGENT_RAIL_MAX_WIDTH,
  AGENT_RAIL_MIN_WIDTH,
  AGENT_RAIL_STORAGE_KEY,
  clampAgentRailWidth,
  readAgentRailWidth,
  writeAgentRailWidth,
} from "./agent-rail-layout";

describe("agent rail layout preferences", () => {
  it("clamps and rounds widths to the supported desktop range", () => {
    expect(clampAgentRailWidth(40)).toBe(AGENT_RAIL_MIN_WIDTH);
    expect(clampAgentRailWidth(180.6)).toBe(181);
    expect(clampAgentRailWidth(900)).toBe(AGENT_RAIL_MAX_WIDTH);
    expect(clampAgentRailWidth(Number.NaN)).toBe(AGENT_RAIL_DEFAULT_WIDTH);
  });

  it("loads a persisted width and rejects malformed storage", () => {
    expect(readAgentRailWidth({ getItem: () => "204" })).toBe(204);
    expect(readAgentRailWidth({ getItem: () => "999" })).toBe(AGENT_RAIL_MAX_WIDTH);
    expect(readAgentRailWidth({ getItem: () => "not-a-width" })).toBe(
      AGENT_RAIL_DEFAULT_WIDTH,
    );
    expect(readAgentRailWidth({ getItem: () => "204.5" })).toBe(
      AGENT_RAIL_DEFAULT_WIDTH,
    );
    expect(readAgentRailWidth({ getItem: () => { throw new Error("denied"); } })).toBe(
      AGENT_RAIL_DEFAULT_WIDTH,
    );
  });

  it("persists the normalized width without failing when storage is denied", () => {
    const setItem = vi.fn();
    writeAgentRailWidth(200.4, { setItem });
    expect(setItem).toHaveBeenCalledWith(AGENT_RAIL_STORAGE_KEY, "200");

    expect(() =>
      writeAgentRailWidth(200, { setItem: () => { throw new Error("denied"); } }),
    ).not.toThrow();
  });
});
