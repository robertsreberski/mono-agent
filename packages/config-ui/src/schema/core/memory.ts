import { defineFieldGroup } from "../field-group.js";

export const memoryGroup = defineFieldGroup({
  id: "memory",
  label: "Memory",
  description: "Where the agent's persistent notes live (optional).",
  fields: [
    {
      id: "memory.path",
      label: "Memory file",
      description: "Markdown file the memory layer reads and writes. Leave empty to disable memory.",
      kind: "path",
      placeholder: "./MEMORY.md",
      path: ["memory", "path"],
    },
    {
      id: "memory.maxBytes",
      label: "Max bytes",
      description: "Hard cap on the memory file size in bytes (1–1,000,000).",
      kind: "integer",
      min: 1,
      max: 1_000_000,
      placeholder: "64000",
      path: ["memory", "maxBytes"],
    },
    {
      id: "memory.scope",
      label: "Scope",
      description: "Whether memory is one shared file or one per conversation.",
      kind: "select",
      options: [
        { value: "single-file", label: "single-file" },
        { value: "per-conversation", label: "per-conversation" },
      ],
      path: ["memory", "scope"],
    },
    {
      id: "memory.writeMode",
      label: "Write mode",
      description:
        "disabled = never write; append-host-summary = let the host append after each run.",
      kind: "select",
      options: [
        { value: "disabled", label: "disabled" },
        { value: "append-host-summary", label: "append-host-summary" },
      ],
      path: ["memory", "writeMode"],
    },
  ],
});
