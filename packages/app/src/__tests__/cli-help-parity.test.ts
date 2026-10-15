import { describe, expect, it } from "vitest";

import { JSON_CAPABLE_COMMANDS, PUBLIC_COMMANDS } from "../cli-args.js";
import { HELP_ALIASES, HELP_COMMANDS } from "../cli-help.js";

describe("PUBLIC_COMMANDS / HELP_COMMANDS parity", () => {
  it("every public command has a help entry, except the two normalized aliases", () => {
    const helpCommands = new Set(HELP_COMMANDS.map((entry) => entry.command));
    const aliases = new Set(HELP_ALIASES.keys());
    for (const command of PUBLIC_COMMANDS) {
      expect(
        helpCommands.has(command) || aliases.has(command),
        `public command \`${command}\` is missing a help entry or alias`,
      ).toBe(true);
    }
  });

  it("the two normalized aliases live in HELP_ALIASES, not HELP_COMMANDS", () => {
    expect(HELP_ALIASES.get("doctor")).toBe("validate");
    expect(HELP_ALIASES.get("setup")).toBe("init");
    const helpCommands = new Set(HELP_COMMANDS.map((entry) => entry.command));
    expect(helpCommands.has("doctor")).toBe(false);
    expect(helpCommands.has("setup")).toBe(false);
  });

  it("every help entry names a real public command", () => {
    const publicCommands = new Set<string>(PUBLIC_COMMANDS);
    for (const entry of HELP_COMMANDS) {
      expect(publicCommands.has(entry.command), `help entry \`${entry.command}\` is not a real command`).toBe(true);
    }
  });

  it("JSON_CAPABLE_COMMANDS and the help json flag agree both ways", () => {
    const jsonCapable = new Set<string>(JSON_CAPABLE_COMMANDS);
    const helpJson = new Set(
      HELP_COMMANDS.filter((entry) => entry.json === true).map((entry) => entry.command),
    );
    for (const command of jsonCapable) {
      expect(helpJson.has(command), `\`${command}\` is JSON-capable but its help entry lacks json: true`).toBe(true);
    }
    for (const command of helpJson) {
      expect(jsonCapable.has(command), `\`${command}\` has json: true but is not in JSON_CAPABLE_COMMANDS`).toBe(true);
    }
  });

  it("describes the platform-specific status scope consistently", () => {
    const status = HELP_COMMANDS.find((entry) => entry.command === "status");
    expect(status?.summary).toContain("macOS also lists other running instances");
    expect(status?.lines.join("\n")).toContain("macOS also lists other running instances");
  });
});
