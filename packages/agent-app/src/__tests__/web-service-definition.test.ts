import { describe, expect, it } from "vitest";

import { decodeManagedWebDefinition } from "../web-service-definition.js";

/** The macOS LaunchAgent prefix: env -i … <node> <cli> */
const launchdPrefix = ["/usr/bin/env", "-i", "PATH=/usr/bin", "/managed/node", "/managed/dist/cli.js"];
/** The Linux systemd unit prefix: env -i … <node> -- <cli> */
const systemdPrefix = ["/usr/bin/env", "-i", "PATH=/usr/bin", "/managed/node", "--", "/managed/dist/cli.js"];

describe("managed web definition decoding", () => {
  it("decodes the generated macOS and Linux invocations", () => {
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5050", "--theme", "plum"]))
      .toEqual({ host: "0.0.0.0", port: 5050, theme: "plum" });
    expect(decodeManagedWebDefinition([...systemdPrefix, "web", "run", "--host", "127.0.0.1", "--port", "6060", "--theme", "ocean", "--name", "Flockbox"]))
      .toEqual({ host: "127.0.0.1", port: 6060, theme: "ocean", name: "Flockbox" });
  });

  it("preserves the deliberate legacy omissions", () => {
    // A pre-theme macOS definition: evergreen, no name.
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5050"]))
      .toEqual({ host: "0.0.0.0", port: 5050, theme: "evergreen" });
    // A definition written while the worker's own default was the wide bind.
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--port", "5050", "--theme", "plum"]))
      .toEqual({ host: "0.0.0.0", port: 5050, theme: "plum" });
  });

  it("rejects argv that is not the recognized managed web invocation", () => {
    expect(decodeManagedWebDefinition([])).toBeUndefined();
    expect(decodeManagedWebDefinition(["/bin/echo", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "start", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--theme", "ocean"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--unknown", "1"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition(["web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
  });

  it("rejects missing, duplicated, or invalid option values", () => {
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "not-a-number", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "0", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "65536", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "magenta"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--name", ""]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--name"]))
      .toBeUndefined();
  });

  it("does not treat an option value as the managed invocation", () => {
    // `--name web` followed by `run …` must not be decoded as the worker.
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--name", "web", "run"]))
      .toBeUndefined();
  });
});
