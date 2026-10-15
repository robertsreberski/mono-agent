import { describe, expect, it } from "vitest";

import { packageRenameError } from "../package-renames.js";

describe("plugin package rename diagnostics", () => {
  it.each([
    "@mono-agent/agent-app",
    "@mono-agent/agent-app@0.22.0",
    "@mono-agent/agent-app/subpath",
  ])("names the replacement for %s", (specifier) => {
    expect(packageRenameError(specifier, "channels.plugins[].package")).toBe(
      "@mono-agent/agent-app was renamed to @mono-agent/app; update channels.plugins[].package",
    );
  });

  it.each([
    "@mono-agent/app",
    "@third-party/agent-app",
    "@mono-agent/agent-app-extension",
    "--package=@mono-agent/agent-app@0.22.0",
    "-p=@mono-agent/agent-app@0.22.0",
  ])("does not interpret unrelated names or launcher flags: %s", (specifier) => {
    expect(packageRenameError(specifier, "channels.plugins[].package")).toBeUndefined();
  });
});
