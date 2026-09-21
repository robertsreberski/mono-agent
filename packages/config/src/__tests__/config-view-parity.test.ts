import { describe, expect, it } from "vitest";

import { redactMonoAgentConfig, resolveProjectedMonoAgentConfig } from "../config.js";
import { buildMonoAgentConfigView, CORE_CONFIG_FIELD_IDS } from "../config-view.js";

describe("config view field parity", () => {
  it("only emits registered core field ids", () => {
    const config = resolveProjectedMonoAgentConfig({
      cwd: "/repo",
      env: {
        MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
        MONO_AGENT_IDENTITY_PATH: "/repo/IDENTITY.md",
      },
    });
    const view = buildMonoAgentConfigView({ redacted: redactMonoAgentConfig(config), json: {} });
    const known = new Set<string>(Object.keys(CORE_CONFIG_FIELD_IDS));
    expect(view.flatMap((section) => section.fields).map((field) => field.id)
      .filter((id) => !known.has(id))).toEqual([]);
  });
});
