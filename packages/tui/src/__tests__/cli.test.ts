import { describe, expect, it } from "vitest";

import { parseArgs } from "../bin/cli.js";

describe("parseArgs", () => {
  it("defaults help to false with no arguments", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ help: false });
  });

  it("sets help for -h and --help", () => {
    expect(parseArgs(["-h"])).toEqual({ help: true });
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  it("parses every value flag", () => {
    const result = parseArgs([
      "--responder",
      "./responder.js",
      "--config",
      "./mono-agent.config.json",
      "--title",
      "Demo",
      "--conversation",
      "conv-1",
    ]);
    expect(result).toEqual({
      help: false,
      responder: "./responder.js",
      config: "./mono-agent.config.json",
      title: "Demo",
      conversationId: "conv-1",
    });
  });

  it("returns an error when a value flag is missing its argument", () => {
    expect(parseArgs(["--responder"])).toEqual({
      error: "--responder requires a path",
    });
    expect(parseArgs(["--config"])).toEqual({
      error: "--config requires a path",
    });
    expect(parseArgs(["--title"])).toEqual({
      error: "--title requires a value",
    });
    expect(parseArgs(["--conversation"])).toEqual({
      error: "--conversation requires a value",
    });
  });

  it("rejects unknown arguments", () => {
    expect(parseArgs(["--nope"])).toEqual({
      error: "unknown argument: --nope",
    });
  });

  it("omits unset optional flags rather than emitting undefined values", () => {
    const result = parseArgs(["--responder", "./responder.js"]);
    expect(result).toEqual({ help: false, responder: "./responder.js" });
    expect(Object.keys(result)).not.toContain("config");
    expect(Object.keys(result)).not.toContain("title");
  });
});
