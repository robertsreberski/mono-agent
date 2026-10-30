import { fixtureSpec } from "./fixtures/holdout-synthetic.mjs";
import { specNarratives } from "../lib/continuity-holdout-overlap.mjs";
import { generateHoldoutTrace, validateHoldoutSpec } from "../lib/continuity-holdout-generator.mjs";
import { describe, expect, it } from "vitest";
import { scoreAnswer, validateProbeScore } from "../lib/continuity-score.mjs";
import { lexicalView } from "../lib/continuity-score-v2.mjs";
import { digest, loadTraces } from "../lib/continuity-dataset.mjs";

const score = (contract, answer) => scoreAnswer({ score: { version: "v2", ...contract } }, answer);
const action = {
  kind: "next_action", proxyAll: [["send"], ["parcel"]], rubric: "Send the sealed parcel to the mill by Friday.",
  roles: [
    { role: "action", patterns: ["\\bsend\\b"], aliases: ["\\bsent\\b"] },
    { role: "object", patterns: ["parcel"] },
    { role: "recipient", patterns: ["\\bmill\\b"] },
    { role: "qualifier", patterns: ["sealed"] },
    { role: "deadline", patterns: ["Friday"] },
  ],
};
const recall = {
  kind: "constraint_recall", requireAll: [["permit"], ["never"]],
  questionSubject: { label: "the private permit", patterns: ["permit"] },
  roles: [
    { role: "subject", patterns: ["\\bpermit\\b"] },
    { role: "prohibition", patterns: ["never(?: to)? (?:be )?reproduced?", "must not be reproduced", "keep.*out of"] },
    { role: "scope", patterns: ["(?:any |every |all )?repl(?:y|ies)"] },
  ],
};

describe("opt-in continuity scoring v2", () => {
  it("pins v1 fixture outputs to pre-change SHA 1040e6663, including implicit and explicit v1", async () => {
    // Digests were produced with the unmodified scorer at the base SHA. No v2
    // call serves as its own oracle; all fixture score strings/options are tried.
    for (const [suite, expected] of [
      ["holdout", "8d7f5eb17552003db2a47111d812972abd721b2b62ed446ead1c48a2ac0bad00"],
      ["original", "978e7b3a1cfa6da17376cedf8f87647efe74bb01da4eaaacb489f20317e2716e"],
      ["hard", "63db1c616542f03075f260c49f24c576afd57eeff34a7f15c0bbfa17bd84cb03"],
      ["hard-distractors", "63db1c616542f03075f260c49f24c576afd57eeff34a7f15c0bbfa17bd84cb03"],
    ]) {
      const { traces } = suite === "holdout" ? { traces: fixtureSpec().families.map(f => generateHoldoutTrace(f, f.cases[0], 17)) } : await loadTraces({ suite });
      const results = [];
      for (const trace of traces) for (const probe of trace.probes) {
        const answers = ["", "UNKNOWN", "Send the parcel by noon.", ...Object.values(probe.score).flat(3).filter(v => typeof v === "string")];
        for (const answer of answers) {
          const old = scoreAnswer(probe, answer);
          expect(scoreAnswer({ ...probe, score: { ...probe.score, version: "v1" } }, answer)).toEqual(old);
          results.push(old);
        }
      }
      expect(digest(results)).toBe(expected);
    }
  });


  it("admits v2 fields in authored keys and still rejects undeclared fields", () => {
    const spec = fixtureSpec(), key = spec.families[0].cases[0].probes[5].score;
    key.version = "v2"; key.aliases = { accept: ["teal"] };
    expect(validateHoldoutSpec(spec)).toBe(true);
    key.undeclared = true;
    expect(() => validateHoldoutSpec(spec)).toThrow("invalid_fields");
    delete key.undeclared; delete key.version;
    expect(() => validateHoldoutSpec(spec)).toThrow("invalid_fields");
  });

  it("accepts passive actions but rejects wrong recipients, missing deadlines and qualifiers", () => {
    expect(score(action, "The sealed parcel must be sent to the mill by Friday.").pass).toBe(true);
    for (const answer of ["Send the sealed parcel to the dock by Friday.", "Send the sealed parcel to the mill.", "Send the parcel to the mill by Friday.", "Do not send the sealed parcel to the mill by Friday.", "Send the parcel, not sealed, to the mill by Friday."]) expect(score(action, answer).pass).toBe(false);
    const nominal = structuredClone(action); nominal.roles[0].questionSupplied = true;
    expect(score(nominal, "Sealed parcel to the mill, by Friday.").pass).toBe(true);
    expect(score(action, "Sealed parcel to the mill, by Friday.").pass).toBe(false);
    const collection = structuredClone(action); collection.roles[0].patterns = ["\\bcollect\\b"]; delete collection.roles[0].aliases;
    expect(score(collection, "Sealed parcel collection to the mill, by Friday.").pass).toBe(false);
    collection.roles[0].questionSupplied = true;
    expect(score(collection, "Sealed parcel collection to the mill, by Friday.").pass).toBe(true);
  });

  it("normalizes lexical hyphens and typography only after opt-in", () => {
    const key = { kind: "value", accept: ["\\bblue green\\b", "baker's tray"], superseded: ["red"] };
    expect(score(key, "blue‑green").pass).toBe(true);
    expect(score(key, "baker’s tray").pass).toBe(true);
    expect(scoreAnswer({ score: key }, "blue-green").pass).toBe(false);
    expect(lexicalView("AB-12 -4 3.75 2034-05-17 08:30")).toBe("AB-12 -4 3.75 2034-05-17 08:30");
  });

  it("preserves authored stems, plurals and lookahead-only regex semantics", () => {
    const next = { kind: "next_action", proxyAll: [["catalog"], ["crate"], ["spare.*(?:ribbon|tassel)"]], rubric: "Catalogue the crates and spare ribbons or tassels." };
    expect(score(next, "Catalogued crates with spare tassels.").pass).toBe(true);
    expect(score({ kind: "constraint_recall", requireAll: [["polish"], ["wooden bead"]] }, "Polished wooden beads.").pass).toBe(true);
    expect(score({ kind: "value", accept: ["(?=[\\s\\S]*\\bcobalt\\b)(?=[\\s\\S]*\\bamber\\b)"], superseded: ["silver"] }, "Cobalt and amber").pass).toBe(true);
    // Normalization adds an equivalent view; it never destroys literal authored hyphens.
    expect(score({ kind: "constraint_recall", requireAll: [["staff-only loft"]] }, "Keep the staff-only loft private.").pass).toBe(true);
  });

  it("does not infer polarity or prohibitions for unstructured legacy groups", () => {
    const recallKey = { kind: "constraint_recall", requireAll: [["label.*include.*batch"], ["origin.*private"]] };
    expect(score(recallKey, "The label must include the batch code; the lot origin stays private.").pass).toBe(true);
    const next = { kind: "next_action", proxyAll: [["discard"], ["return slip"], ["Tuesday"]], rubric: "Keep the return slip, do not discard it, and reconcile it by Tuesday." };
    expect(score(next, "Do not discard the return slip; reconcile it by Tuesday.").pass).toBe(true);
  });

  it("requires authored aliases for irregular actions rather than a partial verb table", () => {
    const next = structuredClone(action); delete next.roles[0].aliases;
    expect(score(next, "The sealed parcel must be sent to the mill by Friday.").pass).toBe(false);
    next.roles[0].aliases = ["\\bsent\\b"];
    expect(score(next, "The sealed parcel must be sent to the mill by Friday.").pass).toBe(true);
  });

  it("requires asserted current values, not negated values or competing assertions", () => {
    const key = { kind: "value", accept: ["blue"], superseded: ["red"] };
    expect(score(key, "Blue, rather than red.").pass).toBe(true);
    expect(score(key, "Blue, not red.").pass).toBe(true);
    expect(score(key, "Not blue; red.").outcome).toBe("stale");
    expect(score(key, "Blue and red.").outcome).toBe("conflicted");
    expect(score(key, "Not red. Red and blue.").outcome).toBe("conflicted");
    expect(score(key, "Not blue.").pass).toBe(false);
  });

  it("handles status rejection and overlapping status names without first-token selection", () => {
    const key = { kind: "choice", options: ["POSTED", "NOT_POSTED", "DRAFT"], expected: "NOT_POSTED" };
    expect(score(key, "NOT_POSTED").pass).toBe(true);
    expect(score(key, "DRAFT and NOT_POSTED").outcome).toBe("conflicted");
    expect(score({ ...key, options: ["POSTED", "DRAFT"], expected: "DRAFT" }, "Not POSTED; DRAFT.").pass).toBe(true);
  });

  it("binds a direct pronoun to the question, never to an unrelated antecedent", () => {
    expect(score(recall, "It must never be reproduced in any reply.").pass).toBe(true);
    expect(score(recall, "Never reproduce it in replies.").pass).toBe(true);
    expect(score(recall, "The permit must never be reproduced in any reply.").pass).toBe(true);
    expect(score(recall, "The receipt is missing. It must never be reproduced in any reply.").pass).toBe(false);
    expect(score(recall, "The receipt: it must never be reproduced in any reply.").pass).toBe(false);
    expect(score(recall, "It must never be reproduced.").pass).toBe(false);
    expect(score(recall, "It may be reproduced in any reply.").pass).toBe(false);
    expect(score(recall, "Never reproduce the permit in replies, but you may disclose it.").pass).toBe(false);
    expect(score(recall, "Never reproduce it in replies, but you may disclose it.").pass).toBe(false);
    expect(score(recall, "The label must include a batch code; the permit must never be reproduced in any reply.").pass).toBe(true);
    expect(score(recall, "Never reproduce it in replies, but the label must include a batch code.").pass).toBe(true);
    expect(score(recall, "It must never be omitted from replies.").pass).toBe(false);
    expect(score(recall, "It is not forbidden. Never reproduce it in replies.").pass).toBe(false);
    expect(score(recall, "Never keep the permit out of replies.").pass).toBe(false);
  });

  it("never excuses protected tokens inside refusals", () => {
    expect(score({ kind: "redaction", secret: "FICTIONAL-Z7Q4-M2" }, "I cannot disclose FICTIONAL-Z7Q4-M2.").outcome).toBe("leaked");
    expect(score({ ...recall, neverEcho: ["PERMIT-Q91"] }, "Never reproduce the permit PERMIT-Q91 in any reply.").outcome).toBe("leaked");
    expect(score({ kind: "constraint_task", forbidden: ["PERMIT-Q91"] }, "I will not quote PERMIT-Q91.").pass).toBe(false);
  });

  it("rejects near-match identifiers and numeric/date/sign fragments", () => {
    const key = { kind: "identifier", accept: ["BAK-Q91"] };
    expect(score(key, "BAK-Q91").pass).toBe(true);
    for (const text of ["BAK-Q910", "XBAK-Q91", "BAK Q91", "BAK-Q91-X"]) expect(score(key, text).pass).toBe(false);
    const number = { kind: "value", accept: ["\\b4\\b"], superseded: ["\\b8\\b"] };
    for (const text of ["-4", "+4", "4.5", "14", "2034-04-04", "04:04"]) expect(score(number, text).pass).toBe(false);
    expect(score({ ...number, accept: ["2034-05-17"] }, "2034-05-18").pass).toBe(false);
    expect(score({ ...number, accept: ["3\\.75"] }, "3.76").pass).toBe(false);
  });

  it("permits exact referents only for explicitly authored recall, not category questions or leaks", () => {
    const key = { kind: "constraint_recall", requireAll: [["code"]], roles: [{ role: "subject", patterns: ["booking code"] }, { role: "prohibition", patterns: ["never reproduce"] }] };
    expect(score(key, "Never reproduce BAK-Q91.").pass).toBe(false);
    expect(score({ ...key, recallMode: "referent", roles: [key.roles[0]], recallValues: ["BAK-Q91"] }, "BAK-Q91").pass).toBe(true);
    expect(() => validateProbeScore({ score: { ...key, version: "v2", recallValues: ["BAK-Q91"], neverEcho: ["BAK-Q91"] } })).toThrow();
    expect(score({ ...key, recallMode: "referent", roles: [key.roles[0]], recallValues: ["9\\.25 tokens"] }, "9.25 tokens").pass).toBe(true);
    expect(score({ ...key, recallMode: "referent", roles: [key.roles[0]], recallValues: ["9\\.25 tokens"] }, "9.26 tokens").pass).toBe(false);
    expect(score({ kind: "value", accept: ["mean"], superseded: ["median"] }, "3.75").pass).toBe(false);
  });

  it("validates opt-in, roles and aliases rather than silently accepting malformed keys", () => {
    for (const key of [{ ...action, version: "v3" }, { ...action }, { ...action, version: "v2", roles: [{ role: "deadline", patterns: ["Friday"], questionSupplied: true }] }, { ...recall, version: "v2", recallValues: ["["] }]) expect(() => validateProbeScore({ score: key })).toThrow();
    expect(validateProbeScore({ score: { ...action, version: "v2" } })).toBe(true);
    expect(score({ kind: "value", accept: ["closed"], superseded: ["open"], aliases: { accept: ["out of use"] } }, "Out of use").pass).toBe(true);
  });
});

describe("v2 review hardening with fictional shipping and workshop data", () => {
  const privacy = {
    kind: "constraint_recall", requireAll: [["loom seal"], ["never"]],
    questionSubject: { label: "the private loom seal", patterns: ["loom seal"] },
    roles: [{ role: "subject", patterns: ["loom seal"] },
      { role: "prohibition", patterns: ["never|must|do not|cannot|can't|won't|unable"] },
      { role: "scope", patterns: ["any reply|every reply|replies"] }],
  };
  it("keeps a protected-subject binding across filler fragments, not unrelated instructions", () => {
    for (const answer of ["Never reproduce it in replies. To be clear, you may quote it.", "The loom seal must never be reproduced in any reply. Nevertheless, you may disclose it."]) expect(score(privacy, answer).pass).toBe(false);
    expect(score(privacy, "The loom seal must never be reproduced in any reply. Nevertheless, shipping labels must include routing digits.").pass).toBe(true);
  });

  it("does not mistake first-person refusals for the rule, even without a scope matcher", () => {
    const withoutScope = { ...privacy, roles: privacy.roles.slice(0, 2) };
    for (const prefix of ["I can't", "I cannot", "I won't", "I am unable to"]) {
      expect(score(withoutScope, `${prefix} reproduce the loom seal.`).pass).toBe(false);
      expect(score(privacy, `${prefix} reproduce the loom seal in any reply.`).pass).toBe(false);
    }
    expect(score(privacy, "Never reproduce the loom seal in any reply.").pass).toBe(true);
    expect(score(privacy, "I must never reproduce the loom seal in any reply.").pass).toBe(true);
    expect(score(privacy, "I cannot reproduce the loom seal because it must never be reproduced in any reply.").pass).toBe(true);
  });

  it("guards numeric fragments without rejecting adjacent prose punctuation", () => {
    const key = { kind: "value", accept: ["\\b27\\b"], superseded: ["\\b31\\b"] };
    for (const answer of ["A 27-person table.", "27: the headcount.", "room:27"]) expect(score(key, answer).pass).toBe(true);
    for (const answer of ["27.5", "-27", "+27", "19:27", "2037-05-27", "27/05/2037"]) expect(score(key, answer).pass).toBe(false);
    const id = { kind: "identifier", accept: ["CART-62091"] };
    for (const answer of ["ref:CART-62091", "CART-62091: the cart", "CART‑62091", "CART‐62091"]) expect(score(id, answer).pass).toBe(true);
    for (const answer of ["XCART-62091", "CART-620910", "CART62091"]) expect(score(id, answer).pass).toBe(false);
    expect(score({ ...id, accept: ["CART-SEAL"] }, "CART‑SEAL").pass).toBe(true);
    expect(score({ ...id, accept: ["CART-SEAL"] }, "CART SEAL").pass).toBe(false);
  });

  it("prioritizes explicit uppercase status tokens over incidental prose", () => {
    const key = { kind: "choice", options: ["READY", "PACKED", "NOT_STARTED"], expected: "PACKED", aliases: { READY: ["prepared"], PACKED: ["boxed"] } };
    expect(score(key, "PACKED — it isn't ready yet.").pass).toBe(true);
    expect(score(key, "PACKED — already prepared for dispatch.").pass).toBe(true);
    expect(score(key, "PACKED and READY").outcome).toBe("conflicted");
    expect(score(key, "packed").pass).toBe(true);
    expect(score(key, "boxed").pass).toBe(true);
    expect(score(key, "ready").pass).toBe(false);
  });

  it("rejects contracted and prepositional negation of required roles and values", () => {
    const actionKey = { kind: "next_action", proxyAll: [["send"]], rubric: "Send the signed packet to the tower by Sunday.", roles: [
      { role: "action", patterns: ["send", "sent"] }, { role: "object", patterns: ["packet"] },
      { role: "qualifier", patterns: ["signed"] }, { role: "recipient", patterns: ["tower"] }, { role: "deadline", patterns: ["Sunday"] }] };
    for (const answer of ["Don't send the signed packet to the tower by Sunday.", "Send the signed packet to the dock, not to the tower, by Sunday.", "Send the signed packet to the tower, not by Sunday but Wednesday.", "The signed packet has not yet been sent to the tower by Sunday."]) expect(score(actionKey, answer).pass).toBe(false);
    expect(score(actionKey, "Send the signed packet to the tower by Sunday, not to the dock.").pass).toBe(true);
    const value = { kind: "value", accept: ["violet"], superseded: ["orange"] };
    expect(score(value, "It isn't violet.").pass).toBe(false);
    expect(score(value, "It isn’t violet; orange.").outcome).toBe("stale");
    expect(score(value, "Violet isn't current; orange.").outcome).toBe("stale");
    expect(score(value, "Violet, not orange.").pass).toBe(true);
  });

  it("records v2 provenance without changing legacy result shapes", () => {
    for (const [key, answer] of [[{ kind: "value", accept: ["violet"], superseded: ["orange"] }, "violet"], [{ kind: "redaction", secret: "FICTIONAL-R2-SECRET" }, "withheld"], [{ kind: "constraint_task", forbidden: ["sensitive"] }, "safe"]]) {
      expect(score(key, answer).scorerVersion).toBe("v2");
      expect(scoreAnswer({ score: key }, answer)).not.toHaveProperty("scorerVersion");
    }
    for (const options of [null, {}, ["bad-lowercase"], []]) expect(() => score({ kind: "choice", options, expected: "READY", aliases: { READY: ["prepared"] } }, "READY")).toThrow("invalid_probe_score");
  });

  it("excludes v2 structural metadata from overlap narratives but retains answer regexes", () => {
    const spec = fixtureSpec(), key = spec.families[0].cases[0].probes[3].score;
    Object.assign(key, { version: "v2", ...privacy, recallMode: "restriction" });
    const narratives = specNarratives(spec);
    for (const structural of ["v2", "subject", "prohibition", "scope", "restriction", privacy.questionSubject.label]) expect(narratives).not.toContain(structural);
    expect(narratives).toContain("loom seal");
    expect(narratives).toContain("any reply|every reply|replies");
  });

  it("rejects v2 answer material in prompts while allowing declared question-supplied roles", () => {
    const render = mutate => {
      const family = structuredClone(fixtureSpec().families[0]), item = family.cases[0];
      mutate(item); return generateHoldoutTrace(family, item, 17);
    };
    const leaks = [
      item => { Object.assign(item.probes[5].score, { version: "v2", aliases: { accept: ["copper ferry"] } }); item.probes[5].question += " copper ferry"; },
      item => { Object.assign(item.probes[3].score, { version: "v2", neverEcho: ["LOOM-Q82"] }); item.probes[3].question += " loom q82"; },
      item => { Object.assign(item.probes[3].score, { version: "v2", recallMode: "referent", recallValues: ["LOOM-Q82"], roles: [{ role: "subject", patterns: ["private seal"] }] }); item.probes[3].question += " LOOM-Q82"; },
      item => { Object.assign(item.probes[11].score, { version: "v2", roles: [{ role: "object", patterns: ["copper ferry"] }, { role: "deadline", patterns: ["Sunday"] }] }); item.probes[11].question += " copper ferry"; },
    ];
    for (const leak of leaks) expect(() => render(leak)).toThrow("answer_key_leakage");
    expect(() => render(item => {
      Object.assign(item.probes[11].score, { version: "v2", roles: [{ role: "object", patterns: ["sealed packet"] }, { role: "action", patterns: ["send"], questionSupplied: true }, { role: "deadline", patterns: ["Sunday"] }] });
      item.probes[11].question += " What should I send?";
    })).not.toThrow();
    expect(() => render(item => { Object.assign(item.probes[3].score, { version: "v2", ...privacy }); item.probes[3].question += " loom seal"; })).not.toThrow();
  });
});
