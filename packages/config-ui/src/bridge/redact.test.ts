import { describe, expect, it } from "vitest";

import { CORE_FIELD_GROUPS } from "../schema/field-group.js";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("replaces secret fields with a {__secret,set} marker when set", () => {
    const redacted = redactSecrets(
      { telegram: { botToken: "super-secret", allowedChatIds: ["111"] } },
      CORE_FIELD_GROUPS,
    );
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(redacted.telegram?.botToken as unknown).toEqual({ __secret: true, set: true });
    expect(redacted.telegram?.allowedChatIds).toEqual(["111"]);
  });

  it("marks unset secrets as set: false", () => {
    const redacted = redactSecrets({ telegram: { allowedChatIds: [] } }, CORE_FIELD_GROUPS);
    expect(redacted.telegram?.botToken as unknown).toEqual({ __secret: true, set: false });
  });

  it("leaves non-secret fields untouched", () => {
    const redacted = redactSecrets(
      { runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 } },
      CORE_FIELD_GROUPS,
    );
    expect(redacted.runtime?.model).toBe("pi:openai-codex:gpt-5.5");
    expect(redacted.runtime?.maxTurns).toBe(12);
  });
});
