import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetSubmissionRecoveryReference,
  readSubmissionRecoveryReferences,
  rememberSubmissionRecoveryReference,
} from "./submission-recovery";

const first = {
  threadId: "thread-one",
  submissionId: "11111111-1111-4111-8111-111111111111",
};
const second = {
  threadId: "thread-two",
  submissionId: "22222222-2222-4222-8222-222222222222",
};

describe("submission recovery references", () => {
  beforeEach(() => sessionStorage.clear());

  it("retains independent in-flight submissions without storing authored content", () => {
    rememberSubmissionRecoveryReference(sessionStorage, first);
    rememberSubmissionRecoveryReference(sessionStorage, second);
    rememberSubmissionRecoveryReference(sessionStorage, first);

    expect(readSubmissionRecoveryReferences(sessionStorage)).toEqual([second, first]);
    expect(JSON.stringify(sessionStorage)).not.toContain("authored draft");

    forgetSubmissionRecoveryReference(sessionStorage, second);
    expect(readSubmissionRecoveryReferences(sessionStorage)).toEqual([first]);
  });

  it("fails closed and clears malformed persisted state", () => {
    sessionStorage.setItem("mono-agent.web.pending-submissions", JSON.stringify([
      first,
      { threadId: "thread-two", submissionId: "not-a-uuid", text: "authored draft" },
    ]));

    expect(readSubmissionRecoveryReferences(sessionStorage)).toEqual([]);
    expect(sessionStorage.length).toBe(0);
  });
});
