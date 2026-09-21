import process from "node:process";

import { runAuditRuns } from "./audit-runs.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { runMetrics } from "./metrics.js";
import { runInspection, writeRunInspectionUsageFailure } from "./run-inspection.js";
import * as ui from "./ui.js";

/**
 * Thin dispatcher for the consolidated `runs` command. The mode positional
 * selects the read-only engine: `report` (default) aggregates metrics,
 * `audit` checks artifact structure, and `list`/`show` inspect bounded run data.
 * The existing engine modules remain untouched; this wrapper only routes and
 * forwards each subcommand's relevant flags.
 */
export async function runRunsCommand(args: ParsedCliArgs): Promise<number> {
  const [mode = "report", ...extra] = args.positionals;
  if (mode === "list" || mode === "show") {
    const positionalsAreValid = mode === "list" ? extra.length === 0 : extra.length === 1;
    const hasModeInappropriateFlag = args.consumerPath !== undefined
      || args.groupBy !== undefined
      || args.since !== undefined
      || args.until !== undefined
      || args.staleAfterMs !== undefined;
    if (!positionalsAreValid || hasModeInappropriateFlag) {
      writeRunInspectionUsageFailure(args.json === true);
      return 2;
    }
    const common = {
      ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
      ...(args.artifactDir === undefined ? {} : { artifactDir: args.artifactDir }),
      includeMemory: args.includeMemory,
      json: args.json === true,
    };
    return mode === "list"
      ? await runInspection({ mode: "list", ...common })
      : await runInspection({ mode: "show", runId: extra[0]!, ...common });
  }

  if (mode !== "report" && mode !== "audit") {
    process.stderr.write(ui.errorLine(`Unknown \`runs\` mode \`${mode}\`. Expected report, audit, list, or show.`));
    return 2;
  }
  if (extra.length > 0) {
    process.stderr.write(ui.errorLine(`\`mono-agent runs ${mode}\` takes no extra arguments; got \`${extra.join(" ")}\`.`));
    return 2;
  }

  // Per-mode flag strictness. Parse-time only knows the command is `runs`, so the
  // subcommand-inappropriate flags are rejected here rather than being silently
  // dropped (which, for --consumer, would quietly read the wrong artifact folder).
  // These reject combinations that do not belong to the selected mode.
  if (mode === "audit") {
    const reportOnly: string[] = [];
    if (args.groupBy !== undefined) reportOnly.push("--by");
    if (args.since !== undefined) reportOnly.push("--since");
    if (args.until !== undefined) reportOnly.push("--until");
    if (reportOnly.length > 0) {
      process.stderr.write(ui.errorLine(
        `${reportOnly.join(", ")} ${reportOnly.length === 1 ? "is" : "are"} only supported for \`mono-agent runs report\`.`,
      ));
      return 2;
    }
    return await runAuditRuns({
      ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
      ...(args.artifactDir === undefined ? {} : { artifactDir: args.artifactDir }),
      ...(args.consumerPath === undefined ? {} : { consumerPath: args.consumerPath }),
      ...(args.staleAfterMs === undefined ? {} : { staleAfterMs: args.staleAfterMs }),
      json: args.json === true,
      includeMemory: args.includeMemory,
    });
  }

  const auditOnly: string[] = [];
  if (args.consumerPath !== undefined) auditOnly.push("--consumer");
  if (args.staleAfterMs !== undefined) auditOnly.push("--stale-after-ms");
  if (auditOnly.length > 0) {
    process.stderr.write(ui.errorLine(
      `${auditOnly.join(", ")} ${auditOnly.length === 1 ? "is" : "are"} only supported for \`mono-agent runs audit\`.`,
    ));
    return 2;
  }

  return await runMetrics({
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    ...(args.artifactDir === undefined ? {} : { artifactDir: args.artifactDir }),
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.until === undefined ? {} : { until: args.until }),
    ...(args.groupBy === undefined ? {} : { groupBy: args.groupBy }),
    json: args.json === true,
    includeMemory: args.includeMemory,
  });
}
