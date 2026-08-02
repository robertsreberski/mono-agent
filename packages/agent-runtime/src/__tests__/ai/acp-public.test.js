import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicApi from "../../index.js";

const packageJson = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../package.json", import.meta.url)),
  "utf8",
));

describe("public ACP boundary", () => {
  it("exports only opaque high-level session controls from the package root", () => {
    expect(publicApi.validateAcpProviderSessionId).toBeTypeOf("function");
    expect(publicApi.listAcpSessions).toBeTypeOf("function");
    expect(publicApi.deleteAcpSession).toBeTypeOf("function");
    expect(publicApi).not.toHaveProperty("connectAcpProfile");
    expect(publicApi).not.toHaveProperty("decodeAcpProviderSessionId");
    expect(publicApi).not.toHaveProperty("encodeAcpProviderSessionId");
  });

  it("does not publish the raw ACP client module as a deep import", () => {
    expect(packageJson.exports).not.toHaveProperty("./ai/providers/acp-client.js");
  });
});
