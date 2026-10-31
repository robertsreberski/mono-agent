// Development-only, source-only availability cases. No probe answers or holdout
// data enter these fixtures, and no fixture labels are consumed by selection.
import { generateTrace } from "./continuity-generator.mjs";
import { fictionalTransitionRecords, selectionReplayRecords } from "./continuity-selection-replay.mjs";

const letters = n => String.fromCharCode(65 + Math.floor(n / 26), 65 + n % 26);
export function selectionReplayCases() {
  const generated = [1, 2].map(seed => {
    const trace = generateTrace(seed), steers = trace.turns.flatMap(turn => turn.steps.flatMap(step => step.steer ? [step.steer] : []));
    return { name: `development-${seed}`, records: selectionReplayRecords(trace),
      transitions: [...steers, ...trace.turns.filter(turn => turn.steps.some(step => step.call?.tool === "doc_write" && (step.call.args.status === "final" || step.call.args.share))).map(turn => turn.user)],
      protectedOwners: [...steers, trace.turns[0].user, ...trace.turns.filter(turn => turn.user.startsWith("Plan for my side:")).map(turn => turn.user)] };
  });
  const transitions = fictionalTransitionRecords();
  const ownerFlood = Array.from({ length: 96 }, (_, i) => ({ kind: "owner", text: `Keep the ${letters(i)} exhibit on the review list.` }));
  const importantTools = ["LANTERN", "WILLOW", "CEDAR"].map(value => ({ kind: "tool", toolName: "read_register", text: `Filing reference: ${value}. Filing receipt verified.` }));
  ownerFlood.splice(32, 0, importantTools[0]); ownerFlood.splice(65, 0, importantTools[1]); ownerFlood.push(importantTools[2]);
  const cancellation = "Cancel my commitment to prepare the LANTERN exhibit.";
  const toolFlood = Array.from({ length: 240 }, (_, i) => ({ kind: "tool", toolName: ["read_notes", "read_inventory", "read_archive", "read_status", "read_catalog", "read_report"][i % 6],
    text: `Register ${letters(i)}: reference WILLOW, revision v2, quantity 42 -> 73.\n\n${"Unchanged inventory detail. ".repeat(180)}` }));
  toolFlood.splice(180, 0, { kind: "owner", text: cancellation });
  return [...generated,
    { name: "transitions", records: transitions, transitions: transitions.filter(record => record.kind === "owner").slice(1, -1).map(record => record.text),
      protectedOwners: [transitions[0].text, transitions.find(record => record.text.startsWith("Next action:")).text],
      requiredTransitions: ["The CEDAR review is complete, according to the coordinator.", "We could prepare a BIRCH exhibit; this is only a suggestion."] },
    { name: "owner-flood", records: ownerFlood, transitions: [], protectedOwners: [], requiredTools: importantTools.map(record => record.text) },
    { name: "tool-flood", records: toolFlood, transitions: [cancellation], protectedOwners: [], requiredTransitions: [cancellation] },
  ];
}

/** Exact record-level coverage labels live only in the test, never the prompt. */
export function replayCoverage(passes, scenario) {
  return passes.map(pass => ({
    tool: pass.records.filter(record => record.kind === "tool").length,
    owner: pass.records.filter(record => record.kind === "owner").length,
    transitions: pass.records.filter(record => scenario.transitions.includes(record.text)).length,
    transitionIds: pass.records.filter(record => scenario.transitions.includes(record.text)).map(record => record.inputId).sort(),
    cap: pass.deltaCap, fitted: pass.offered.length,
    protectedOwners: pass.records.filter(record => scenario.protectedOwners.includes(record.text)).map(record => record.inputId).sort(),
  }));
}
