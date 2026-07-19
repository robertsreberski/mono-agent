import process from "node:process";

import { runAuditRuns } from "./audit-runs.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { runMetrics } from "./metrics.js";
import * as ui from "./ui.js";

/**
 * Thin dispatcher for the consolidated `runs` command. The mode positional
 * selects the read-only engine: `report` (default) aggregates metrics via
 * `runMetrics`, `audit` runs the structural artifact audit via `runAuditRuns`.
 * The engine modules (`metrics.ts`/`audit-runs.ts`) are deliberately untouched —
 * this wrapper only routes and forwards the subcommand-relevant flags.
 *
 * The legacy `audit-runs`/`metrics` spellings normalize to `runs audit`/`runs`
 * in `parseCliArgs`, so their existing invocations arrive here unchanged.
 */
export async function runRunsCommand(args: ParsedCliArgs): Promise<number> {
  const [mode = "report", ...extra] = args.positionals;
  if (mode !== "report" && mode !== "audit") {
    process.stderr.write(ui.errorLine(`Unknown \`runs\` mode \`${mode}\`. Expected report or audit.`));
    return 2;
  }
  if (extra.length > 0) {
    process.stderr.write(ui.errorLine(`\`mono-agent runs ${mode}\` takes no extra arguments; got \`${extra.join(" ")}\`.`));
    return 2;
  }

  if (mode === "audit") {
    return await runAuditRuns({
      ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
      ...(args.artifactDir === undefined ? {} : { artifactDir: args.artifactDir }),
      ...(args.consumerPath === undefined ? {} : { consumerPath: args.consumerPath }),
      ...(args.staleAfterMs === undefined ? {} : { staleAfterMs: args.staleAfterMs }),
      json: args.json === true,
      includeMemory: args.includeMemory,
    });
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
