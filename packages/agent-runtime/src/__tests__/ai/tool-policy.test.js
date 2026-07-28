import { describe, expect, it } from "vitest";
import {
  isAllowAllToolPolicy,
  TOOL_POLICY_ALLOW_ALL_ONLY,
  TOOL_POLICY_PROJECTED,
} from "../../ai/runtime/tool-policy.js";

describe("tool policy capabilities", () => {
  it("uses stable, discoverable capability values", () => {
    expect(TOOL_POLICY_PROJECTED).toBe("projected");
    expect(TOOL_POLICY_ALLOW_ALL_ONLY).toBe("allow_all_only");
  });
});

describe("isAllowAllToolPolicy", () => {
  it.each([
    ["an omitted allowlist", undefined, undefined],
    ["the bare wildcard", ["*"], []],
    ["a wildcard mixed with named tools", ["*", "Read"], []],
  ])("accepts %s with no denylist", (_label, allowedTools, disallowedTools) => {
    expect(isAllowAllToolPolicy(allowedTools, disallowedTools)).toBe(true);
  });

  it.each([
    ["an empty allowlist", [], []],
    ["a named-only allowlist", ["Read", "Bash"], []],
    ["a wildcard with a denylist", ["*", "Read"], ["Bash"]],
  ])("rejects %s", (_label, allowedTools, disallowedTools) => {
    expect(isAllowAllToolPolicy(allowedTools, disallowedTools)).toBe(false);
  });
});
