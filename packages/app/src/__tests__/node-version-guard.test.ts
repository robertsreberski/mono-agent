import { describe, expect, it } from "vitest";
import { minimumNode, nodeVersionFailure, requiredNode, supportedNode } from "../node-version-guard.js";

describe("lightweight Node guard", () => {
  it.each(["18.20.8", "20.20.0", "22.22.0", "24.14.9", "invalid"])("rejects %s", (value) => expect(supportedNode(value)).toBe(false));
  it.each([minimumNode, "24.99.0", "25.0.0"])("accepts %s", (value) => expect(supportedNode(value)).toBe(true));
  it("prints found/required and independent concrete fix alternatives", () => {
    const text = nodeVersionFailure("20.20.0");
    for (const value of ["20.20.0", requiredNode, `nvm install ${minimumNode}`, `fnm install ${minimumNode}`, `volta install node@${minimumNode}`, "https://nodejs.org/en/download"]) expect(text).toContain(value);
  });
});
