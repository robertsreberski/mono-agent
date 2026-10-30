import { fixtureSpec } from "./fixtures/holdout-synthetic.mjs";
import { generateHoldoutTrace, validateHoldoutSpec } from "../lib/continuity-holdout-generator.mjs";
import { describe, expect, it } from "vitest";
import { scoreAnswer, validateProbeScore } from "../lib/continuity-score.mjs";
import { lexicalView } from "../lib/continuity-score-v2.mjs";
import { digest, loadTraces } from "../lib/continuity-dataset.mjs";

const score = (contract, answer) => scoreAnswer({ score: { version: "v2", ...contract } }, answer);
const action = {
  kind: "next_action", proxyAll: [["send"], ["parcel"]], rubric: "Send the sealed parcel to the mill by Friday.",
  roles: [
    { role: "action", patterns: ["\\bsend\\b"] },
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
    const collection = structuredClone(action); collection.roles[0].patterns = ["collect"];
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
