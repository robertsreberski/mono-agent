// Current execution requires freshly bound sizing, not historical split-checkout measurements.
import { expect, it } from "vitest";
import { LOOKUP_BUDGET, LOOKUP_ROLES, lookupSlotDisposition } from "../lib/continuity-lookup.mjs";
it("blocks every role without fresh sizing and admits only an explicit bounded current path", () => {
  const key = {traceId:"fictional",probeId:"fictional-probe",arm:"continuity-pack-cold"};
  for (const role of LOOKUP_ROLES) {
    expect(lookupSlotDisposition({lookup:{budget:LOOKUP_BUDGET,role}},key)).toMatchObject({status:"blocked",code:"lookup_unknown_feasibility"});
  }
  // Fictional geometry tests admission mechanics, not measured product response sizes.
  const path = {...key,calls:1,bytes:100,cumulativeBytes:100,initialTokens:1000,admissionCap:100000,discovered:true};
  expect(lookupSlotDisposition({lookup:{budget:{...LOOKUP_BUDGET,paths:[path]}}},key)).toMatchObject({status:"eligible"});
  expect(lookupSlotDisposition({lookup:{budget:{...LOOKUP_BUDGET,paths:[{...path,calls:1000}]}}},key)).toMatchObject({status:"infeasible"});
});
