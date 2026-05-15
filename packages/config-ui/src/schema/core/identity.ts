import { defineFieldGroup } from "../field-group.js";

export const identityGroup = defineFieldGroup({
  id: "identity",
  label: "Identity",
  description: "Who the agent is and which skills it draws from.",
  fields: [
    {
      id: "context.identityPath",
      label: "Identity document",
      description: "Markdown file describing the agent's persona, role, and discipline.",
      kind: "path",
      required: true,
      placeholder: "./IDENTITY.md",
      path: ["context", "identityPath"],
    },
    {
      id: "context.soulPath",
      label: "Soul document",
      description: "Optional secondary character/voice document layered after identity.",
      kind: "path",
      placeholder: "./SOUL.md",
      path: ["context", "soulPath"],
    },
    {
      id: "context.skillsRoot",
      label: "Skills root",
      description: "Directory that contains the skills available to the agent.",
      kind: "path",
      placeholder: "./skills",
      path: ["context", "skillsRoot"],
    },
    {
      id: "context.selectedSkills",
      label: "Selected skills",
      description: "Comma-separated list of skill names the agent may use.",
      kind: "csv",
      placeholder: "research, review",
      path: ["context", "selectedSkills"],
    },
  ],
});
