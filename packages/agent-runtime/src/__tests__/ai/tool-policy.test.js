import { describe, expect, it } from "vitest";
import {
  TOOL_POLICY_PROJECTED,
} from "../../ai/runtime/tool-policy.js";

describe("tool policy capabilities", () => {
  it("uses stable, discoverable capability values", () => {
    expect(TOOL_POLICY_PROJECTED).toBe("projected");
  });
});
