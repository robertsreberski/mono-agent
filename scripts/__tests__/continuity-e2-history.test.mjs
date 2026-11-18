import { expect, it } from "vitest";
import { e2HistorySurface, historySurfaceBinding, historyArguments, historyConfig, historyToolName, historyServerName, historyCallScope, assertHistorySurfaceBinding, e2AbArm, e2SlotHistorySurface, E2_AB_ARMS, lookupToolAllowlist } from "../lib/continuity-e2-history.mjs";
import { shippingSoul } from "../lib/continuity-e2-models.mjs";
import { assertE2BaselineContext } from "../lib/continuity-e2-protocol.mjs";
import { parseE2Args } from "../continuity-e2.mjs";
import { e2CodeDigest } from "../lib/continuity-e2-registration.mjs";
it("uses only the shipping History contract, with no config flag", async () => {
  expect(e2HistorySurface()).toBe("unified"); expect(() => e2HistorySurface("split")).toThrow();
  expect(historySurfaceBinding()).toEqual({historySurface:"unified"});
  expect(historyConfig()).toEqual({}); expect(historyToolName()).toBe("History"); expect(historyServerName()).toBe("mono-agent-history");
  expect(historyArguments(undefined,{action:"search"})).toEqual({scope:"said",action:"search"});
  expect((await shippingSoul()).text).toContain('History (when available)');
  expect(await e2CodeDigest()).toMatch(/^[a-f0-9]{64}$/u);
});
it("refuses omitted/split non-AB execution bindings, and arm A", () => {
  for (const value of [{},{historySurface:"split"}]) expect(() => assertHistorySurfaceBinding(value,{historySurface:"unified"})).toThrow();
  expect(() => assertHistorySurfaceBinding({historySurface:"unified"},{historySurface:"unified"})).not.toThrow();
  expect(E2_AB_ARMS).toEqual(["B","C"]); expect(() => e2AbArm("A")).toThrow();
  expect(() => e2SlotHistorySurface({},{})).toThrow();
  expect(e2SlotHistorySurface({historySurface:"unified"},{})).toBe("unified");
  expect(() => e2SlotHistorySurface({replayArm:"history-ab",historySurface:"unified"},{kind:"replay",arm:"history-ab-B"})).toThrow();
  expect(lookupToolAllowlist()).toEqual({version:"v3",tools:["History"]});
});
it.each(["ConversationHistory","SessionHistory","RunHistory","conversation_history","session_history","run_history","History","mcp__mono-agent-history__History"])("baseline refuses current and historical %s", name => {
  expect(() => assertE2BaselineContext({tools:[{name}]},{kind:"source"})).toThrow("E2_PROBE_TOOLS_REFUSED");
});
it("retains historical scope attribution only for observation readers", () => {
  expect(historyCallScope("ConversationHistory",{})).toBe("said");
  expect(historyCallScope("SessionHistory",{})).toBe("tools");
  expect(historyCallScope("RunHistory",{})).toBe("runs");
  expect(historyCallScope("History",{scope:"said"})).toBe("said");
  expect(historyCallScope("mcp__other__History",{scope:"said"})).toBeUndefined();
});
it("removes the CLI surface selector", () => {
  expect(() => parseE2Args(["size","--source","fiction","--protocol","fiction","--output","fiction","--history-surface","unified"])).toThrow("E2_ARGUMENTS_INVALID");
});
