import { describe, expect, it } from "vitest";

import { renderConfigView } from "../cli.js";
import type { ConfigViewSection } from "@mono-agent/config";

const sections: readonly ConfigViewSection[] = [
  {
    id: "runtime",
    label: "Runtime",
    status: "active",
    fields: [
      { id: "runtime.model", label: "Model", value: "pi:ollama:qwen3:8b", source: "json" },
      { id: "runtime.effort", label: "Effort", value: "—", source: "default" },
      { id: "runtime.workspace", label: "Workspace", value: "/work", source: "env" },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    status: "disabled",
    fields: [{ id: "memory.mode", label: "Status", value: "not configured", source: "default" }],
  },
];

describe("renderConfigView", () => {
  it("tags every field with its source layer", () => {
    const out = renderConfigView(sections);
    expect(out).toContain("Runtime");
    expect(out).toMatch(/Model.*pi:ollama:qwen3:8b.*\[json\]/u);
    expect(out).toMatch(/Effort.*\[default\]/u);
    expect(out).toMatch(/Workspace.*\[env\]/u);
  });

  it("renders an active section with the ok badge and a disabled one with the off badge", () => {
    const out = renderConfigView(sections);
    // Plain (NO_COLOR) badges are width-equal ASCII tags.
    expect(out).toContain("[ok]   ");
    expect(out).toContain("[off]  ");
    expect(out).toContain("not configured");
  });

  it("marks redacted fields with a secret note", () => {
    const out = renderConfigView([
      {
        id: "memory",
        label: "Memory",
        status: "active",
        fields: [
          { id: "memory.embeddings.apiKey", label: "Embeddings API key", value: "set", source: "env", redacted: true },
        ],
      },
    ]);
    expect(out).toContain("(secret)");
    expect(out).not.toContain("sk-");
  });
});
