import process from "node:process";

import type { ParsedCliArgs } from "./cli-args.js";
import { installComposerSkill } from "./install-skill.js";
import { checkManagedProjectSkills, updateManagedProjectSkills } from "./project-skills.js";
import * as ui from "./ui.js";

export async function runInstallSkill(args: ParsedCliArgs): Promise<number> {
  if (args.project === true) {
    try {
      if (args.update === true) {
        const result = await updateManagedProjectSkills(process.cwd());
        for (const path of result.updated) {
          process.stdout.write(`${ui.badge("ok")}${ui.style.green("updated")}  ${path}\n`);
        }
        if (result.backupDir !== undefined) {
          process.stdout.write(`${ui.badge("ok")}backup    ${result.backupDir}\n`);
        }
        if (result.updated.length === 0) process.stdout.write(`${ui.badge("ok")}project skills are current\n`);
        return 0;
      }
      const result = await checkManagedProjectSkills(process.cwd());
      for (const status of result.statuses) {
        const badge = status.status === "ready" ? ui.badge("ok") : ui.badge("error");
        process.stdout.write(`${badge}${status.name}: ${status.status} (${status.path})\n`);
      }
      if (!result.ok && args.check !== true) {
        process.stderr.write(ui.errorLine("Project skills need attention. Run `mono-agent install-skill --project --update`; modified copies require manual reconciliation."));
      }
      return result.ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(ui.errorLine(error instanceof Error ? error.message : String(error)));
      return 1;
    }
  }
  let result;
  try {
    result = await installComposerSkill({
      target: args.target ?? "both",
      force: args.force,
    });
  } catch (error) {
    process.stderr.write(ui.errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  for (const path of result.installed) {
    process.stdout.write(`${ui.badge("ok")}${ui.style.green("installed")}  ${path}\n`);
  }
  return 0;
}
