import { join } from "node:path";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  activeProjectSkillSelections,
  checkManagedProjectSkills,
  isRetiredProjectSkillName,
  managedProjectSkillsExist,
} from "../skills/project-skills.js";
import type { ValidationSection, ValidationStatus } from "./doctor-types.js";
import { pathExists } from "./format.js";

export async function contextSection(config: MonoAgentConfig, cwd: string): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const activeSelectedSkills = activeProjectSkillSelections(config.context.selectedSkills);
  const retiredSelectedSkills = config.context.selectedSkills.filter(isRetiredProjectSkillName);

  if (await pathExists(config.context.identityPath)) {
    details.push(`Identity: ${config.context.identityPath}`);
  } else {
    status = "error";
    details.push(`Identity file is missing: ${config.context.identityPath}`);
  }

  if (config.context.soulPath !== undefined && !(await pathExists(config.context.soulPath))) {
    status = "error";
    details.push(`Soul file is missing: ${config.context.soulPath}`);
  }

  for (const skill of retiredSelectedSkills) {
    if (status === "ok") status = "waiting";
    details.push(
      `Skill \`${skill}\` is retired and ignored. Remove it from context.selectedSkills or ` +
      "MONO_AGENT_SELECTED_SKILLS, then run `mono-agent install-skill --project --check`." +
      (config.context.skillDisclosure === "index"
        ? " Skill disclosure runs as `full` until the retired selector is removed."
        : ""),
    );
  }

  if (activeSelectedSkills.length > 0 && config.context.skillsRoot !== undefined) {
    if (await pathExists(config.context.skillsRoot)) {
      details.push(`Skills root: ${config.context.skillsRoot}`);
      for (const skill of activeSelectedSkills) {
        const skillPath = join(config.context.skillsRoot, skill, "SKILL.md");
        if (await pathExists(skillPath)) {
          details.push(`Skill \`${skill}\`: ${skillPath}`);
        } else {
          status = "error";
          details.push(`Skill \`${skill}\` is selected but ${skillPath} is missing.`);
        }
      }
    } else {
      status = "error";
      details.push(`Skills root is missing: ${config.context.skillsRoot}`);
    }
  } else if (activeSelectedSkills.length > 0) {
    status = "error";
    details.push("Skills are selected but context.skillsRoot is not set.");
  }

  if (await managedProjectSkillsExist(cwd)) {
    const managed = await checkManagedProjectSkills(cwd);
    const drift = managed.statuses.filter((entry) => entry.status !== "ready");
    if (drift.length === 0) {
      details.push(`Managed project skills: current (${managed.manifestVersion ?? "unknown version"}).`);
    } else {
      if (status === "ok") status = "waiting";
      details.push(
        `Managed project skill drift: ${drift.map((entry) => `${entry.name}=${entry.status}`).join(", ")}. ` +
        "Run `mono-agent install-skill --project --check`; use --update only after reconciling modified copies.",
      );
    }
  }

  return { id: "context", label: "Context & skills", status, details };
}
