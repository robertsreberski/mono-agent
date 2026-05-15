import { defineFieldGroup } from "../field-group.js";

export const runtimeGroup = defineFieldGroup({
  id: "runtime",
  label: "Runtime",
  description: "Which model to talk to and how aggressively to run it.",
  fields: [
    {
      id: "runtime.model",
      label: "Model",
      description:
        "Runtime model reference, e.g. codex:gpt-5.5, pi:openai-codex:gpt-5.5, claude:claude-sonnet-4-6.",
      kind: "string",
      required: true,
      placeholder: "pi:openai-codex:gpt-5.5",
      path: ["runtime", "model"],
    },
    {
      id: "runtime.executionMode",
      label: "Execution mode",
      description: "sdk talks to the provider over its SDK; cli shells out to a packaged binary.",
      kind: "select",
      options: [
        { value: "sdk", label: "SDK" },
        { value: "cli", label: "CLI" },
      ],
      path: ["runtime", "executionMode"],
    },
    {
      id: "runtime.effort",
      label: "Effort",
      description: "Reasoning effort hint (none, low, medium, high, xhigh, max).",
      kind: "select",
      options: [
        { value: "none", label: "none" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
        { value: "xhigh", label: "xhigh" },
        { value: "max", label: "max" },
      ],
      path: ["runtime", "effort"],
    },
    {
      id: "runtime.maxTurns",
      label: "Max turns",
      description: "Upper bound on conversation turns per run (1–100).",
      kind: "integer",
      min: 1,
      max: 100,
      placeholder: "8",
      path: ["runtime", "maxTurns"],
    },
    {
      id: "runtime.workspace",
      label: "Workspace",
      description: "Working directory the agent operates from.",
      kind: "path",
      placeholder: ".",
      path: ["runtime", "workspace"],
    },
  ],
});
