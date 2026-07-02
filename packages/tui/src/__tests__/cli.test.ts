import { describe, expect, it } from "vitest";

import { parseArgs } from "../bin/cli.js";

describe("parseArgs", () => {
  it("parses in-process mode flags (legacy surface preserved)", () => {
    expect(
      parseArgs(["--responder", "./responder.js", "--config", "./mono-agent.config.json", "--title", "T", "--conversation", "c1"]),
    ).toEqual({
      help: false,
      responder: "./responder.js",
      config: "./mono-agent.config.json",
      title: "T",
      conversationId: "c1",
    });
  });

  it("parses remote mode flags", () => {
    expect(parseArgs(["--url", "http://127.0.0.1:5000/tui", "--api-key", "k"])).toEqual({
      help: false,
      url: "http://127.0.0.1:5000/tui",
      apiKey: "k",
    });
  });

  it("parses discovery flags and bare invocation", () => {
    expect(parseArgs([])).toEqual({ help: false });
    expect(parseArgs(["--registry-dir", "/tmp/registry"])).toEqual({
      help: false,
      registryDir: "/tmp/registry",
    });
  });

  it("rejects mixing --responder with --url", () => {
    expect(parseArgs(["--responder", "a.js", "--url", "http://x"])).toEqual({
      error: "--responder and --url are mutually exclusive",
    });
  });

  it("rejects flags missing their value and unknown flags", () => {
    expect(parseArgs(["--url"])).toEqual({ error: "--url requires a value" });
    expect(parseArgs(["--nope"])).toEqual({ error: "unknown argument: --nope" });
  });

  it("parses help", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });
});
