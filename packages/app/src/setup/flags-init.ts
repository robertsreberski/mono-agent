import { basename, resolve } from "node:path";
import process from "node:process";

import type { ParsedCliArgs } from "../cli-args.js";
import { effectiveFirstRunEnvironment, resolveEffectivePiAuthPath, withExactProcessEnvironment } from "../first-run-readiness.js";
import { initMonoAgentFolder } from "../init.js";
import { composeWizardPlan, referencedSetupModelRefs } from "../wizard/answers.js";
import { answersFromCli, isWithChannel } from "../wizard/from-flags.js";
import type { WithChannel } from "../wizard/from-flags.js";
import { findPreset, presetIds } from "../wizard/presets.js";
import { withScopedPreflightCancellation } from "./cancellation.js";
import { nonEmptyEnv, pathExists, runProviderSetupBeforeInit } from "./provider-setup-gate.js";
import { printInitResult, printNextSteps, printSecretsChecklist } from "./render.js";
import type { RunInitEnvironmentContext } from "./types.js";
import * as ui from "../ui.js";

export async function runFlagsInit(args: ParsedCliArgs, environment: RunInitEnvironmentContext, cwd: string): Promise<number> {
  const presetId = resolveInitPresetId(args);
  if (presetId === "unknown") {
    return 1;
  }

  const withChannels = resolveWithChannels(args);
  if (withChannels === "invalid") {
    return 1;
  }

  const answers = answersFromCli({
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.fallbacks === undefined ? {} : { fallbacks: args.fallbacks }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.memory === undefined ? {} : { memory: args.memory }),
    ...(withChannels === undefined ? {} : { withChannels }),
    ...(presetId === undefined ? {} : { presetId }),
  });

  const previewPlan = composeWizardPlan(answers, {
    dirBasename: basename(process.cwd()),
    skillsRootExists: await pathExists(resolve(process.cwd(), "skills")),
  });
  const nonInteractivePiAuthPath = resolveEffectivePiAuthPath({
    cwd,
    ...(nonEmptyEnv(environment.shellEnv.MONO_AGENT_PI_AUTH_PATH)
      ? { envPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH }
      : nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH)
        ? { envPath: environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH }
        : {}),
    ...(nonEmptyEnv(previewPlan.configJson.providers?.piAuthPath)
      ? { configPath: previewPlan.configJson.providers.piAuthPath }
      : {}),
  });
  const nonInteractiveEnvironment = effectiveFirstRunEnvironment({
    shellEnv: environment.shellEnv,
    dotenvEnv: environment.dotenvEnv,
    resolvedPiAuthPath: nonInteractivePiAuthPath,
  });
  const setup = await withScopedPreflightCancellation((abortSignal) =>
    withExactProcessEnvironment(nonInteractiveEnvironment, () =>
      runProviderSetupBeforeInit({
        modelRefs: referencedSetupModelRefs(previewPlan),
        cwd,
        auth: args.auth === true,
        dryRun: args.dryRun,
        persistedEnv: environment.dotenvEnv,
        piAuthPath: nonInteractivePiAuthPath,
        abortSignal,
      })), { keypress: false });
  if (setup === "interrupted" || setup === "fatal") {
    return 130;
  }
  if (setup === "failed") {
    return 1;
  }

  const result = await initMonoAgentFolder({
    dir: cwd,
    answers,
    dryRun: args.dryRun,
    ...((nonEmptyEnv(environment.shellEnv.MONO_AGENT_PI_AUTH_PATH)
      || nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH))
      ? { authPathForConfig: nonInteractivePiAuthPath } : {}),
    // Memory identity is authored in JSON; the environment is only available
    // to resolve credentials that the generated JSON names.
    env: { ...environment.shellEnv, ...environment.dotenvEnv },
  });

  printInitResult(result);
  printSecretsChecklist(result.plan.secrets, new Set());
  printNextSteps(result.configPath);
  return 0;
}

/**
 * Resolve the preset id for `init`: `--preset` wins. Returns the preset id to
 * compose from, `undefined` for the default scaffold, or `"unknown"` after
 * emitting the error/hint for an unknown preset.
 */
function resolveInitPresetId(args: ParsedCliArgs): string | undefined | "unknown" {
  if (args.preset !== undefined) {
    const preset = findPreset(args.preset);
    if (preset === undefined) {
      process.stderr.write(ui.errorLine(`Unknown preset \`${args.preset}\`.`));
      process.stderr.write(ui.hint(`Available presets: ${presetIds().join(", ")}. Run \`mono-agent presets list\`.`));
      return "unknown";
    }
    return preset.id;
  }
  return undefined;
}

function resolveWithChannels(args: ParsedCliArgs): readonly WithChannel[] | undefined | "invalid" {
  if (args.withChannels === undefined) {
    return undefined;
  }
  const invalid = args.withChannels.filter((channel) => !isWithChannel(channel));
  if (invalid.length > 0) {
    process.stderr.write(ui.errorLine(`Unknown --with channel(s): ${invalid.join(", ")}.`));
    process.stderr.write(ui.hint("Valid channels: telegram, slack, webhook, openaiApi, cron."));
    return "invalid";
  }
  return args.withChannels.filter(isWithChannel);
}
