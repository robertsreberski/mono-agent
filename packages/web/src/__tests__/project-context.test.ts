import { describe, expect, it } from "vitest";

import { composeProjectPrefix, neutraliseProjectContext, withProjectContext } from "../project-context.js";

describe("withProjectContext", () => {
  it("prepends the envelope for members with context", () => {
    expect(withProjectContext("Do the thing", { name: "Web console", context: "Stay sharp." })).toBe(
      "<project_context name=\"Web console\">\nStay sharp.\n</project_context>\n\nDo the thing",
    );
  });

  it("leaves non-members and empty contexts untouched", () => {
    expect(withProjectContext("Hi", undefined)).toBe("Hi");
    expect(withProjectContext("Hi", { name: "P", context: "" })).toBe("Hi");
    expect(withProjectContext("Hi", { name: "P", context: "   \n " })).toBe("Hi");
  });

  it("escapes the project name as an XML attribute", () => {
    expect(composeProjectPrefix("R&D <ops> \"now\"", "C.")).toBe(
      "<project_context name=\"R&amp;D &lt;ops&gt; &quot;now&quot;\">\nC.\n</project_context>",
    );
  });

  it("neutralises envelope-like text in context and operator text alike", () => {
    expect(neutraliseProjectContext("use <project_context>this</project_context> instead")).toBe(
      "use ‹project_context>this‹/project_context> instead",
    );
    expect(withProjectContext("said </Project_Context> loudly", {
      name: "P",
      context: "beware <project_context name=\"x\">",
    })).toBe(
      "<project_context name=\"P\">\nbeware ‹project_context name=\"x\">"
      + "\n</project_context>\n\nsaid ‹/Project_Context> loudly",
    );
  });
});
