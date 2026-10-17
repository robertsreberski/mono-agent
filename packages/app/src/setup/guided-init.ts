import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";

import {
  defaultBackgroundDeps,
  ensureBackgroundReady,
  managedBackgroundEnvironment,
  resolveInstanceTarget,
} from "../background.js";
import type { BackgroundLaunchResult } from "../background.js";
import { captureDurableBackgroundInputs } from "../background-snapshot.js";
import type { BackgroundSnapshot } from "../background-snapshot.js";
import type { ParsedCliArgs } from "../cli-args.js";
import { isAbortLike } from "../cli-cancellation.js";
import {
  formatSection,
  renderPlanCompleteness,
} from "../cli-validate-config-command.js";
import { validateMonoAgentFolder } from "../doctor.js";
import type { ValidationReport } from "../doctor-types.js";
import { effectiveFirstRunEnvironment, evaluateFirstRunConfigurationReadiness, evaluateFirstRunReadiness, hasSensitivePersistedEnvironmentValue, piAuthPathBackgroundConflict, resolveEffectivePiAuthPath, selectedSecretEnvironmentConflicts, selectedSecretValues, unexpectedPersistedMonoAgentOverrides, validateWizardPlanInStaging, withExactProcessEnvironment } from "../first-run-readiness.js";
import { readCliConfigSnapshot, readCliDotenvSnapshot } from "../service/background/source-inputs.js";
import type { CliConfigSnapshot, CliDotenvSnapshot, CliEnvironment } from "../service/background/source-inputs.js";
import {
  initMonoAgentFolder,
  secretEnvConcurrentModificationCause,
  verifySecretEnvPersistenceGuard,
} from "../init.js";
import type { InitMonoAgentFolderResult } from "../init.js";
import {
  detectProviderCredentialStates,
  isProviderSetupPiApiKeyAction,
  planProviderSetup,
} from "../provider-setup.js";
import type { ProviderSetupPlan } from "../provider-setup.js";
import { readinessProbeTimeoutMs, runAllRouteReadinessProbe } from "../readiness-probe.js";
import type {
  ReadinessProbeResult,
  ReadinessRouteResult,
} from "../readiness-probe.js";
import { setupManagedSrt } from "../sandbox-manager.js";
import { composeWizardPlan, referencedSetupModelRefs } from "../wizard/answers.js";
import type { WizardAnswers, WizardPlan } from "./wizard-types.js";
import { runInitWizard, runSetupRepairWizard } from "../wizard/run.js";
import { withScopedPreflightCancellation } from "./cancellation.js";
import { nonEmptyEnv, pathExists, runProviderSetupBeforeInit } from "./provider-setup-gate.js";
import {
  BROWSER_CONSOLE_HOST,
  BROWSER_CONSOLE_PORT,
  configurationRecoveryEditLabel,
  printIncompleteSetup,
  printInitResult,
  printReadinessRouteSummary,
  printReadyAgentHandoff,
  printSecretsChecklist,
  printUnexpectedGuidedBackgroundFailure,
  printUnsupportedGuidedInitHandoff,
  readinessRoutesForDisplay,
} from "./render.js";
import type { RunInitEnvironmentContext } from "./types.js";
import * as p from "@clack/prompts";
import * as ui from "../ui.js";

export async function runGuidedInit(args: ParsedCliArgs, environment: RunInitEnvironmentContext, cwd: string): Promise<number> {
  // Existing-config pre-check — don't walk the wizard into a guaranteed no-op.
  if (await pathExists(resolve(cwd, "mono-agent.config.json"))) {
    process.stdout.write(ui.hint(
      "Found an existing mono-agent.config.json — `mono-agent init` never overwrites. Run `mono-agent validate`, " +
      "start the agent if it is not running, then `mono-agent web run --loopback` for the browser console " +
      `(open http://${BROWSER_CONSOLE_HOST}:${String(BROWSER_CONSOLE_PORT)}).\n`,
    ));
    return 0;
  }
  let resolvedPiAuthPath = resolveEffectivePiAuthPath({
    cwd,
    ...(nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH)
      ? { envPath: environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH }
      : {}),
  });
  const initial = await runInitWizard({
    cwd,
    piAuthPath: resolvedPiAuthPath,
    persistedEnv: environment.dotenvEnv,
  });
  if (initial.status === "cancelled") return 1;
  let answers = initial.answers;
  let moduleSecrets = { ...initial.moduleSecrets };
  let providerEnvironmentSecrets: Record<string, string> = { ...initial.providerEnvironmentSecrets };
  let providerSetupSecrets = { ...initial.providerSetupSecrets };
  let piApiKeyPersistenceByProvider = { ...initial.piApiKeyPersistenceByProvider };
  let piAuthMethods = { ...initial.piAuthMethods };
  let credentialStates = { ...initial.credentialStates };
  let pendingProviderSetup = initial.runProviderSetup;
  let readinessProgress: ReadinessProgress | undefined;
  let sandboxMutationCompleted = false;
  let deferredFailure: ReadinessProbeFailure | undefined;

  firstRun: for (;;) {
    let dotenvSnapshot: CliDotenvSnapshot = { env: {}, fingerprint: "unreadable" };
    let failure: ReadinessProbeResult | undefined = deferredFailure;
    let configurationRecoveryStep: number | undefined;
    let invalidPlanStage: "configuration" | "final_readiness" | undefined;
    deferredFailure = undefined;
    try {
      dotenvSnapshot = await readCliDotenvSnapshot(environment.dotenvPath);
    } catch {
      failure ??= dotenvReadinessFailure("The persisted .env could not be read safely. Fix it before retrying setup.");
    }
    const plan = composeWizardPlan(answers, {
      dirBasename: basename(cwd),
      skillsRootExists: await pathExists(resolve(cwd, "skills")),
    });
    resolvedPiAuthPath = resolveEffectivePiAuthPath({
      cwd,
      ...(nonEmptyEnv(dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH)
        ? { envPath: dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH }
        : {}),
      ...(nonEmptyEnv(plan.configJson.providers?.piAuthPath)
        ? { configPath: plan.configJson.providers.piAuthPath }
        : {}),
    });
    const effectiveEnv = effectiveFirstRunEnvironment({
      shellEnv: environment.shellEnv,
      dotenvEnv: dotenvSnapshot.env,
      enteredSecrets: { ...moduleSecrets, ...providerEnvironmentSecrets },
      resolvedPiAuthPath,
    });
    // Re-submit every selected durable value, not only values typed during this
    // wizard session. That lets the secure merge tighten an existing .env to
    // 0600 while preserving its non-empty operator-owned values verbatim.
    const selectedSecrets = {
      ...selectedSecretValues(plan, effectiveEnv),
      ...providerEnvironmentSecrets,
    };
    const secureExistingDotenv = hasSensitivePersistedEnvironmentValue(dotenvSnapshot.env);
    const conflicts = selectedSecretEnvironmentConflicts(
      plan,
      environment.shellEnv,
      dotenvSnapshot.env,
      moduleSecrets,
    );
    const persistedOverrides = unexpectedPersistedMonoAgentOverrides(plan, dotenvSnapshot.env);

    if (failure === undefined && persistedOverrides.length > 0) {
      failure = {
        ok: false,
        kind: "invalid_plan",
        message:
          `Persisted .env contains mono-agent config override${persistedOverrides.length === 1 ? "" : "s"}: ` +
          `${persistedOverrides.join(", ")}. Remove ${persistedOverrides.length === 1 ? "it" : "them"} so the ` +
          "generated config is the exact config validated and started.",
      };
    }
    if (failure === undefined && conflicts.length > 0) {
      failure = {
        ok: false,
        kind: "invalid_plan",
        message:
          `Selected secret${conflicts.length === 1 ? "" : "s"} ${conflicts.join(", ")} ` +
          "differ between the exported shell, persisted .env, or newly entered value. " +
          "Unset the shell value or make every source match, then retry.",
      };
    }
    if (failure === undefined && piAuthPathBackgroundConflict({
      cwd,
      shellPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH,
      dotenvPath: dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH,
      ...(nonEmptyEnv(plan.configJson.providers?.piAuthPath)
        ? { configPath: plan.configJson.providers.piAuthPath }
        : {}),
    })) {
      failure = {
        ok: false,
        kind: "invalid_plan",
        message:
          "The exported MONO_AGENT_PI_AUTH_PATH selects a different credential store than a background start. " +
          "Persist the same path in .env or providers.piAuthPath, or unset the shell override, then retry.",
      };
    }

    if (failure === undefined && pendingProviderSetup) {
      pendingProviderSetup = false;
      const modelRefs = referencedSetupModelRefs(plan);
      const credentialObservation = await withScopedPreflightCancellation(async (abortSignal) => ({
        states: await detectProviderCredentialStates({
          modelRefs,
          cwd,
          piAuthPath: resolvedPiAuthPath,
          persistedEnv: dotenvSnapshot.env,
          abortSignal,
        }),
        interrupted: abortSignal.aborted,
      }));
      if (credentialObservation.interrupted) {
        pendingProviderSetup = true;
        deferredFailure = {
          ok: false,
          kind: "cancelled",
          message: "Provider status detection was interrupted. No agent files were written.",
          interrupted: true,
        };
        continue firstRun;
      }
      credentialStates = credentialObservation.states;
      const plannedSetup = planProviderSetup({
        modelRefs,
        cwd,
        piAuthPath: resolvedPiAuthPath,
        credentialStates,
        piApiKeyPersistenceByProvider,
        piAuthMethods,
      });
      const environmentApiKeys = environmentProviderApiKeys(plannedSetup, effectiveEnv);
      const missingEnvironmentKeys = plannedSetup.actions
        .filter(isProviderSetupPiApiKeyAction)
        .filter((action) => action.persistence === "environment" && environmentApiKeys[action.id] === undefined)
        .map((action) => action.envVar);
      if (missingEnvironmentKeys.length > 0) {
        for (const envVar of missingEnvironmentKeys) {
          const answer = await p.password({
            message: `Enter ${envVar} for the agent's owner-only .env`,
            validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
            clearOnError: true,
          });
          if (p.isCancel(answer)) return 1;
          providerEnvironmentSecrets[envVar] = answer;
        }
        pendingProviderSetup = true;
        continue firstRun;
      }
      const setup = await withScopedPreflightCancellation((abortSignal) =>
        withExactProcessEnvironment(effectiveEnv, () =>
          runProviderSetupBeforeInit({
            modelRefs,
            cwd,
            auth: true,
            dryRun: false,
            piAuthPath: resolvedPiAuthPath,
            apiKeys: { ...providerSetupSecrets, ...environmentApiKeys },
            credentialStates,
            persistedEnv: dotenvSnapshot.env,
            piApiKeyPersistenceByProvider,
            piAuthMethods,
            abortSignal,
          })), { keypress: false });
      if (setup === "fatal") return 130;
      if (setup === "interrupted") {
        pendingProviderSetup = true;
        failure = {
          ok: false,
          kind: "cancelled",
          message: "Provider setup was interrupted. No agent files were written.",
          interrupted: true,
        };
      } else if (setup === "failed") {
        // A plain retry must revisit provider setup rather than falling
        // through to a guaranteed-failing model turn.
        pendingProviderSetup = true;
        failure = {
          ok: false,
          kind: "provider_failed",
          message: "Provider setup did not complete. No agent files were written.",
        };
      }
    }

    if (failure === undefined) {
      if (answers.sandbox) {
        const sandboxPreflight = await runGuidedSandboxPreflight(sandboxMutationCompleted);
        sandboxMutationCompleted = sandboxMutationCompleted || sandboxPreflight.ok;
        if (!sandboxPreflight.ok) failure = sandboxPreflight;
      }
    }

    if (failure === undefined) {
      const configurationGate = await runConfigurationPreflightWithSpinner({
        cwd,
        answers,
        plan,
        env: effectiveEnv,
        secretValues: selectedSecrets,
        secureExistingDotenv,
      });
      if (configurationGate.interrupted === true) {
        failure = {
          ok: false,
          kind: "cancelled",
          message: "Configuration preflight was interrupted. No agent files were written.",
          interrupted: true,
        };
      } else if (!configurationGate.ready) {
        configurationRecoveryStep = focusedConfigurationRepairStep(configurationGate.failedSectionIds);
        invalidPlanStage = "configuration";
        failure = {
          ok: false,
          kind: "invalid_plan",
          message: `Configuration preflight did not pass: ${configurationGate.reasons.join(" ")}`,
        };
      }
    }

    if (failure === undefined) {
      const readiness = await runReadinessProbeWithSpinner({
        plan,
        effectiveEnv,
        resolvedPiAuthPath,
        ...(readinessProgress === undefined ? {} : {
          resume: {
            planFingerprint: readinessProgress.planFingerprint,
            successfulRouteKeys: readinessProgress.successfulRouteKeys,
          },
        }),
      });
      readinessProgress = mergeReadinessProgress(readinessProgress, readiness, plan);
      failure = readiness;
    }

    readyAttempt: if (failure.ok) {
      const stagedGate = await runFinalReadinessValidationWithSpinner({
        cwd,
        answers,
        plan,
        env: effectiveEnv,
        secretValues: selectedSecrets,
        secureExistingDotenv,
        verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
      });
      if (stagedGate.interrupted === true) {
        failure = {
          ok: false,
          kind: "cancelled",
          message: "Final readiness validation was interrupted. No agent files were written.",
          interrupted: true,
        };
        break readyAttempt;
      }
      if (stagedGate.ready) {
        const drift = await firstRunDotenvDrift(environment.dotenvPath, dotenvSnapshot);
        if (drift !== undefined) {
          failure = drift;
          break readyAttempt;
        }
        let result: InitMonoAgentFolderResult;
        try {
          result = await initMonoAgentFolder({
            dir: cwd,
            answers,
            env: effectiveEnv,
            ...(nonEmptyEnv(dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH)
              ? { authPathForConfig: resolvedPiAuthPath } : {}),
            secretValues: selectedSecrets,
            secureExistingDotenv,
            requireConfigCreation: true,
          });
        } catch (error) {
          const recovery = secretPersistenceRecoveryMessage(error);
          process.stderr.write(ui.errorLine(
            `The validated scaffold could not be committed safely. The agent was not started; inspect the destination before retrying.${recovery}`,
          ));
          return 1;
        }
        let committedConfigSnapshot: CliConfigSnapshot;
        try {
          committedConfigSnapshot = await readCliConfigSnapshot(result.configPath);
        } catch {
          printIncompleteSetup(
            ["The committed config could not be read back as the regular file setup created."],
            result.configPath,
          );
          return 1;
        }
        if (committedConfigSnapshot.contents !== `${JSON.stringify(result.plan.configJson, null, 2)}\n`) {
          printIncompleteSetup(
            ["The committed config does not match the exact plan setup validated."],
            result.configPath,
          );
          return 1;
        }
        let committedDotenvSnapshot: CliDotenvSnapshot;
        try {
          committedDotenvSnapshot = await readCliDotenvSnapshot(environment.dotenvPath);
        } catch {
          printIncompleteSetup(
            ["The committed .env could not be read back safely; no readiness claim is safe."],
            result.configPath,
          );
          return 1;
        }
        // A missing default .env is a valid, durable empty environment. Keep
        // proving its absence in the approved snapshot, but do not turn that
        // default into an explicit --env-file argument: the managed worker
        // treats an explicitly named missing file as an operator error.
        const backgroundEnvFile = args.envFile === undefined
          && committedDotenvSnapshot.fingerprint === "missing"
          ? undefined
          : environment.dotenvPath;
        const postWriteConflicts = selectedSecretEnvironmentConflicts(
          result.plan,
          environment.shellEnv,
          committedDotenvSnapshot.env,
          moduleSecrets,
        );
        const postWriteOverrides = unexpectedPersistedMonoAgentOverrides(
          result.plan,
          committedDotenvSnapshot.env,
        );
        const postWritePiAuthConflict = piAuthPathBackgroundConflict({
          cwd,
          shellPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH,
          dotenvPath: committedDotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH,
          ...(nonEmptyEnv(result.plan.configJson.providers?.piAuthPath)
            ? { configPath: result.plan.configJson.providers.piAuthPath }
            : {}),
        });
        if (postWriteConflicts.length > 0 || postWriteOverrides.length > 0 || postWritePiAuthConflict) {
          printIncompleteSetup(
            ["The committed .env no longer matches the values and generated config that setup approved."],
            result.configPath,
          );
          return 1;
        }
        const postWriteEnv = effectiveFirstRunEnvironment({
          shellEnv: environment.shellEnv,
          dotenvEnv: committedDotenvSnapshot.env,
          resolvedPiAuthPath,
        });
        if (!sameConcreteEnvironment(effectiveEnv, postWriteEnv)) {
          printIncompleteSetup(
            ["The durable environment changed after the primary-model check. Retry setup before claiming readiness."],
            result.configPath,
          );
          return 1;
        }
        let committedBackgroundSnapshot: BackgroundSnapshot;
        let committedBackgroundEnvironment: Readonly<Record<string, string>>;
        let committedBackgroundConfigSourceFingerprint: string;
        try {
          const durableInputs = await captureDurableBackgroundInputs({
            cwd,
            configPath: result.configPath,
            envFile: environment.dotenvPath,
            operationalEnvironment: managedBackgroundEnvironment(postWriteEnv),
          });
          committedBackgroundSnapshot = durableInputs.snapshot;
          committedBackgroundEnvironment = durableInputs.environment;
          committedBackgroundConfigSourceFingerprint = durableInputs.configSourceFingerprint;
        } catch {
          printIncompleteSetup(
            ["The complete committed config, dotenv, Identity, Soul, and MCP snapshot could not be proven safely."],
            result.configPath,
          );
          return 1;
        }
        if (committedBackgroundConfigSourceFingerprint !== committedConfigSnapshot.fingerprint) {
          printIncompleteSetup(
            ["The committed config or durable environment changed before the background snapshot was captured."],
            result.configPath,
          );
          return 1;
        }
        printInitResult(result);
        let report: ValidationReport;
        try {
          report = await validateMonoAgentFolder({
            env: postWriteEnv,
            cwd,
            configPath: result.configPath,
            liveness: true,
            verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
          });
        } catch {
          printIncompleteSetup(
            ["Post-write validation could not complete; no readiness claim is safe."],
            result.configPath,
          );
          return 1;
        }
        process.stdout.write("\n" + ui.heading("Validation"));
        for (const section of report.sections) process.stdout.write(formatSection(section));
        process.stdout.write(renderPlanCompleteness(result.plan.validateExpectations, "Selected capabilities", report));
        const configuredSecrets = configuredSecretNames(result, postWriteEnv);
        printSecretsChecklist(result.plan.secrets, configuredSecrets);
        const finalGate = evaluateFirstRunReadiness({
          plan: result.plan,
          report,
          secretPersistence: result.secretPersistence,
          verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
        });
        if (!finalGate.ready) {
          printIncompleteSetup(finalGate.reasons, result.configPath);
          return 1;
        }
        const postValidationConfigDrift = await firstRunConfigDrift(
          result.configPath,
          committedConfigSnapshot,
        );
        if (postValidationConfigDrift !== undefined) {
          printIncompleteSetup([postValidationConfigDrift.message], result.configPath);
          return 1;
        }
        const postValidationDrift = await firstRunDotenvDrift(
          environment.dotenvPath,
          committedDotenvSnapshot,
        );
        if (postValidationDrift !== undefined) {
          printIncompleteSetup([postValidationDrift.message], result.configPath);
          return 1;
        }
        const postValidationSecretGuard = await firstRunSecretEnvGuardFailure(
          environment.dotenvPath,
          result.secretPersistence.status === "persisted",
        );
        if (postValidationSecretGuard !== undefined) {
          printIncompleteSetup([postValidationSecretGuard.message], result.configPath);
          return 1;
        }
        process.stdout.write(
          ui.badge("ok") + ui.style.green("All runtime route checks passed — every selected model produced a real no-tool response.\n") +
          ui.badge("ok") + ui.style.green("Agent configuration validated — every selected capability passed full validation.\n"),
        );
        const preTuiConfigDrift = await firstRunConfigDrift(
          result.configPath,
          committedConfigSnapshot,
        );
        if (preTuiConfigDrift !== undefined) {
          printIncompleteSetup([preTuiConfigDrift.message], result.configPath);
          return 1;
        }
        const preTuiDotenvDrift = await firstRunDotenvDrift(
          environment.dotenvPath,
          committedDotenvSnapshot,
        );
        if (preTuiDotenvDrift !== undefined) {
          printIncompleteSetup([preTuiDotenvDrift.message], result.configPath);
          return 1;
        }
        const preTuiSecretGuard = await firstRunSecretEnvGuardFailure(
          environment.dotenvPath,
          result.secretPersistence.status === "persisted",
        );
        if (preTuiSecretGuard !== undefined) {
          printIncompleteSetup([preTuiSecretGuard.message], result.configPath);
          return 1;
        }
        if (process.platform !== "darwin") {
          printUnsupportedGuidedInitHandoff(result.configPath, backgroundEnvFile);
          return 0;
        }
        process.stdout.write(ui.hint("Starting the managed background agent…"));
        let background: BackgroundLaunchResult;
        try {
          const resolvedBackgroundTarget = await resolveInstanceTarget({
            args: {
              configPath: result.configPath,
              ...(backgroundEnvFile === undefined ? {} : { envFile: backgroundEnvFile }),
            },
            env: { ...committedBackgroundEnvironment },
            cwd,
            cliPath: fileURLToPath(new URL("../cli.js", import.meta.url)),
          });
          const backgroundTarget = {
            ...resolvedBackgroundTarget,
            expectedSnapshot: committedBackgroundSnapshot,
          };
          background = await ensureBackgroundReady(
            backgroundTarget,
            defaultBackgroundDeps(),
          );
        } catch (error) {
          printUnexpectedGuidedBackgroundFailure(result.configPath, backgroundEnvFile, error);
          return 1;
        }
        if (!background.ok) {
          process.stderr.write(ui.hint(
            "The validated agent files were preserved, but the background agent is not ready.",
          ));
          return 1;
        }
        process.stdout.write(ui.badge("ok") + ui.style.green(
          "Agent ready — the background process reported startup complete.\n",
        ));
        printReadyAgentHandoff(result.configPath, backgroundEnvFile);
        return 0;
      }
      configurationRecoveryStep = focusedConfigurationRepairStep(stagedGate.failedSectionIds);
      invalidPlanStage = "final_readiness";
      failure = {
        ok: false,
        kind: "invalid_plan",
        message: `Runtime route checks passed, but the complete agent is not ready: ${stagedGate.reasons.join(" ")}`,
      };
    }

    if (failure.ok) throw new Error("First-run recovery reached without a failure.");
    if (failure.interrupted === true || failure.kind === "cancelled") {
      interruptedRecoveryMenu: for (;;) {
        const interruptedRecovery = await selectInterruptedFirstRunRecovery();
        if (interruptedRecovery === "cancel") return 1;
        if (interruptedRecovery === "restart") {
          readinessProgress = undefined;
          break interruptedRecoveryMenu;
        }
        if (interruptedRecovery === "edit") {
          const repaired = await runSetupRepairWizard({
            cwd,
            answers,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            moduleSecrets,
            providerSetupSecrets,
            providerEnvironmentSecrets,
            piApiKeyPersistenceByProvider,
            piAuthMethods,
            credentialStates,
            runProviderSetup: pendingProviderSetup,
          });
          if (repaired.status === "cancelled") continue interruptedRecoveryMenu;
          answers = repaired.answers;
          moduleSecrets = { ...repaired.moduleSecrets };
          providerSetupSecrets = { ...repaired.providerSetupSecrets };
          providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
          piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
          piAuthMethods = { ...repaired.piAuthMethods };
          credentialStates = { ...repaired.credentialStates };
          pendingProviderSetup = repaired.runProviderSetup;
          if (pendingProviderSetup) readinessProgress = undefined;
        }
        break interruptedRecoveryMenu;
      }
      continue firstRun;
    }
    if (failure.message.startsWith("[sandbox_preflight_failed]")) {
      sandboxRecoveryMenu: for (;;) {
        const recovery = await selectSandboxPreflightRecovery();
        if (recovery === "cancel") return 1;
        if (recovery === "edit") {
          const edited = await runSetupRepairWizard({
            cwd,
            answers,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            moduleSecrets,
            providerSetupSecrets,
            providerEnvironmentSecrets,
            piApiKeyPersistenceByProvider,
            piAuthMethods,
            credentialStates,
            runProviderSetup: pendingProviderSetup,
          });
          if (edited.status === "cancelled") continue sandboxRecoveryMenu;
          answers = edited.answers;
          moduleSecrets = { ...edited.moduleSecrets };
          providerSetupSecrets = { ...edited.providerSetupSecrets };
          providerEnvironmentSecrets = { ...edited.providerEnvironmentSecrets };
          piApiKeyPersistenceByProvider = { ...edited.piApiKeyPersistenceByProvider };
          piAuthMethods = { ...edited.piAuthMethods };
          credentialStates = { ...edited.credentialStates };
          pendingProviderSetup = edited.runProviderSetup;
          if (pendingProviderSetup) readinessProgress = undefined;
        }
        break sandboxRecoveryMenu;
      }
      continue firstRun;
    }
    let recoveryFailure: ReadinessProbeFailure = failure;
    recoveryMenu: for (;;) {
      p.log.error(`[${recoveryFailure.kind}] ${recoveryFailure.message}`);
      const recovery = await selectFirstRunRecovery(
        recoveryFailure,
        configurationRecoveryStep,
        invalidPlanStage,
      );
      if (recovery === "cancel") return 1;
      if (recovery === "save") {
        let saved: InitMonoAgentFolderResult;
        try {
          saved = await initMonoAgentFolder({
            dir: cwd,
            answers,
            env: effectiveEnv,
            ...(nonEmptyEnv(dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH)
              ? { authPathForConfig: resolvedPiAuthPath } : {}),
            secretValues: selectedSecrets,
            secureExistingDotenv,
            requireConfigCreation: true,
          });
        } catch (error) {
          const recovery = secretPersistenceRecoveryMessage(error);
          process.stderr.write(ui.errorLine(
            `The incomplete scaffold could not be committed safely; inspect the destination and retry.${recovery}`,
          ));
          return 1;
        }
        printInitResult(saved);
        let durableSavedEnv: CliEnvironment = {};
        if (saved.secretPersistence.status === "persisted") {
          try {
            durableSavedEnv = (await readCliDotenvSnapshot(environment.dotenvPath)).env;
          } catch {
            durableSavedEnv = {};
          }
        }
        printSecretsChecklist(
          saved.plan.secrets,
          configuredSecretNames(saved, durableSavedEnv),
        );
        printIncompleteSetup([recoveryFailure.message], saved.configPath);
        return 1;
      }
      if (recovery === "edit") {
        const repaired = await runSetupRepairWizard({
          cwd,
          answers,
          piAuthPath: resolvedPiAuthPath,
          persistedEnv: dotenvSnapshot.env,
          ...(configurationRecoveryStep === undefined ? {} : { initialStep: configurationRecoveryStep }),
          moduleSecrets,
          providerSetupSecrets,
          providerEnvironmentSecrets,
          piApiKeyPersistenceByProvider,
          piAuthMethods,
          credentialStates,
          runProviderSetup: pendingProviderSetup,
        });
        if (repaired.status === "cancelled") continue recoveryMenu;
        answers = repaired.answers;
        moduleSecrets = { ...repaired.moduleSecrets };
        providerSetupSecrets = { ...repaired.providerSetupSecrets };
        providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
        piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
        piAuthMethods = { ...repaired.piAuthMethods };
        credentialStates = { ...repaired.credentialStates };
        pendingProviderSetup = repaired.runProviderSetup;
        if (pendingProviderSetup) readinessProgress = undefined;
        continue firstRun;
      }
      if (recovery === "model") {
        const repaired = await runSetupRepairWizard({
          cwd,
          answers,
          piAuthPath: resolvedPiAuthPath,
          persistedEnv: dotenvSnapshot.env,
          initialStep: 1,
          moduleSecrets,
          providerSetupSecrets,
          providerEnvironmentSecrets,
          piApiKeyPersistenceByProvider,
          piAuthMethods,
          credentialStates,
          runProviderSetup: pendingProviderSetup,
        });
        if (repaired.status === "cancelled") continue recoveryMenu;
        answers = repaired.answers;
        moduleSecrets = { ...repaired.moduleSecrets };
        providerSetupSecrets = { ...repaired.providerSetupSecrets };
        providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
        piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
        piAuthMethods = { ...repaired.piAuthMethods };
        credentialStates = { ...repaired.credentialStates };
        pendingProviderSetup = repaired.runProviderSetup;
        if (pendingProviderSetup) readinessProgress = undefined;
        continue firstRun;
      }
      if (recovery === "auth") {
        if (referencedSetupModelRefs(plan).some((ref) => ref.startsWith("openai:"))) {
          const method = await p.select<"oauth" | "api-key">({
            message: "Retry OpenAI authentication with which method? A successful login replaces the stored OpenAI credential.",
            initialValue: piAuthMethods.openai ?? "oauth",
            options: [
              { value: "oauth", label: "Sign in with ChatGPT" },
              { value: "api-key", label: "OpenAI API key" },
            ],
          });
          if (p.isCancel(method)) return 1;
          piAuthMethods = { ...piAuthMethods, openai: method };
          if (method === "api-key") {
            // Authentication recovery must review the destination again. An old
            // environment choice cannot replace a stored credential and would
            // otherwise repeat the same guard failure on every retry.
            const { openai: _oldPersistence, ...otherPersistence } = piApiKeyPersistenceByProvider;
            piApiKeyPersistenceByProvider = otherPersistence;
          }
          if (method === "oauth") {
            const { ["pi-api-key:openai"]: _priorOpenAIKey, ...remainingSetupSecrets } = providerSetupSecrets;
            providerSetupSecrets = remainingSetupSecrets;
            const { OPENAI_API_KEY: _priorOpenAIEnv, ...remainingEnvironmentSecrets } = providerEnvironmentSecrets;
            providerEnvironmentSecrets = remainingEnvironmentSecrets;
          }
        }
        // Authentication can replace credential bytes without changing the
        // route/config fingerprint. Every route must be proven again.
        readinessProgress = undefined;
        const setupPlan = planProviderSetup({
          modelRefs: referencedSetupModelRefs(plan),
          cwd,
          piAuthPath: resolvedPiAuthPath,
          forceAuthentication: true,
          piAuthMethods,
        });
        const prompted = await promptProviderSetupSecrets(
          setupPlan,
          providerSetupSecrets,
          piApiKeyPersistenceByProvider,
          providerEnvironmentSecrets,
        );
        if (prompted === undefined) return 1;
        providerSetupSecrets = prompted.apiKeys;
        piApiKeyPersistenceByProvider = prompted.persistenceByProvider;
        providerEnvironmentSecrets = prompted.environmentSecrets;
        readinessProgress = undefined;
        const selectedSetupPlan = planProviderSetup({
          modelRefs: referencedSetupModelRefs(plan),
          cwd,
          piAuthPath: resolvedPiAuthPath,
          forceAuthentication: true,
          piApiKeyPersistenceByProvider,
          piAuthMethods,
        });
        const environmentApiKeys = environmentProviderApiKeys(
          selectedSetupPlan,
          { ...effectiveEnv, ...providerEnvironmentSecrets },
        );
        const missingEnvironmentKeys = selectedSetupPlan.actions
          .filter(isProviderSetupPiApiKeyAction)
          .filter((action) => action.persistence === "environment" && environmentApiKeys[action.id] === undefined)
          .map((action) => action.envVar);
        if (missingEnvironmentKeys.length > 0) {
          recoveryFailure = {
            ok: false,
            kind: "provider_failed",
            message: `Add ${missingEnvironmentKeys.join(", ")} to the durable owner-only .env, then retry authentication. No agent files were written.`,
          };
          continue recoveryMenu;
        }
        const setup = await withScopedPreflightCancellation((abortSignal) =>
          withExactProcessEnvironment(effectiveEnv, () =>
            runProviderSetupBeforeInit({
              modelRefs: referencedSetupModelRefs(plan),
              cwd,
              auth: true,
              dryRun: false,
              piAuthPath: resolvedPiAuthPath,
              apiKeys: { ...providerSetupSecrets, ...environmentApiKeys },
              forceAuthentication: true,
              piApiKeyPersistenceByProvider,
              piAuthMethods,
              abortSignal,
            })), { keypress: false });
        if (setup === "fatal") return 130;
        if (setup === "interrupted") {
          pendingProviderSetup = true;
          deferredFailure = {
            ok: false,
            kind: "cancelled",
            message: "Provider setup was interrupted. No agent files were written.",
            interrupted: true,
          };
          continue firstRun;
        }
        if (setup === "failed") {
          pendingProviderSetup = true;
          recoveryFailure = {
            ok: false,
            kind: "provider_failed",
            message: "Provider setup still needs attention. No agent files were written.",
          };
          continue recoveryMenu;
        }
        pendingProviderSetup = false;
      }
      // "retry" deliberately reruns only the live checks. Provider setup is a
      // separate explicit recovery action and is never repeated automatically.
      continue firstRun;
    }
  }
}

type ReadinessProbeFailure = Extract<ReadinessProbeResult, { readonly ok: false }>;

type AssessedConfigurationReadiness = ReturnType<typeof evaluateFirstRunConfigurationReadiness> & {
  readonly failedSectionIds: readonly string[];
  readonly interrupted?: true;
};

type AssessedFinalReadiness = ReturnType<typeof evaluateFirstRunReadiness> & {
  readonly failedSectionIds: readonly string[];
  readonly interrupted?: true;
};

const FIRST_RUN_STAGING_FAILURE_MAX_LENGTH = 500;
const FIRST_RUN_SENSITIVE_ENV_NAME = /(api.?key|credential|password|secret|token)/iu;

function throwIfFirstRunPreflightAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error("Preflight was interrupted.");
  error.name = "AbortError";
  throw error;
}

function firstRunStagingFailureDetail(
  error: unknown,
  sensitiveValues: Iterable<string> = [],
): string {
  let message = reasonOf(error);
  for (const value of [...new Set(sensitiveValues)].filter((candidate) => candidate.length >= 4).sort(
    (left, right) => right.length - left.length,
  )) {
    message = message.replaceAll(value, "[secret-redacted]");
  }
  const normalized = message
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [secret-redacted]")
    .replace(
      /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)(\s*[=:]\s*)([^\s,;]+)/giu,
      (_match, label: string, separator: string) => `${label}${separator}[secret-redacted]`,
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return "Unknown staging failure.";
  return normalized.length <= FIRST_RUN_STAGING_FAILURE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, FIRST_RUN_STAGING_FAILURE_MAX_LENGTH - 1).trimEnd()}…`;
}

function firstRunStagingSensitiveValues(
  env: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>>,
): readonly string[] {
  return [
    ...Object.entries(env)
      .filter((entry): entry is [string, string] =>
        FIRST_RUN_SENSITIVE_ENV_NAME.test(entry[0])
        && typeof entry[1] === "string"
        && entry[1].length > 0
      )
      .map(([, value]) => value),
    ...Object.values(explicit),
  ];
}

async function runConfigurationPreflightWithSpinner(
  options: Omit<Parameters<typeof assessPrewriteFirstRunConfigurationReadiness>[0], "abortSignal">,
): Promise<AssessedConfigurationReadiness> {
  process.stdout.write("\n" + ui.heading("Configuration preflight"));
  const spinner = p.spinner();
  try {
    return await withScopedPreflightCancellation(async (abortSignal) => {
      spinner.start("Validating generated files and selected capabilities before runtime calls");
      const gate = await assessPrewriteFirstRunConfigurationReadiness({ ...options, abortSignal });
      if (abortSignal.aborted || spinner.isCancelled) {
        spinner.cancel("Configuration preflight interrupted");
        return interruptedConfigurationAssessment();
      }
      if (gate.ready) {
        spinner.stop("Selected capabilities are ready for runtime checks");
      } else {
        spinner.error("Configuration preflight needs attention");
      }
      return gate;
    });
  } catch (error) {
    if (!isAbortLike(error)) throw error;
    spinner.cancel("Configuration preflight interrupted");
    return interruptedConfigurationAssessment();
  }
}

function interruptedConfigurationAssessment(): AssessedConfigurationReadiness {
  return {
    ready: false,
    reasons: ["Configuration preflight was interrupted."],
    failedSectionIds: [],
    interrupted: true,
  };
}

async function runFinalReadinessValidationWithSpinner(
  options: Omit<Parameters<typeof assessPrewriteFirstRunReadiness>[0], "abortSignal">,
): Promise<AssessedFinalReadiness> {
  process.stdout.write("\n" + ui.heading("Final readiness validation"));
  const spinner = p.spinner();
  try {
    return await withScopedPreflightCancellation(async (abortSignal) => {
      spinner.start("Revalidating the effective files after runtime route checks");
      const gate = await assessPrewriteFirstRunReadiness({ ...options, abortSignal });
      if (abortSignal.aborted || spinner.isCancelled) {
        spinner.cancel("Final readiness validation interrupted");
        return interruptedFinalReadinessAssessment();
      }
      if (gate.ready) spinner.stop("Effective files and runtime routes are ready");
      else spinner.error("Final readiness validation needs attention");
      return gate;
    });
  } catch (error) {
    if (!isAbortLike(error)) throw error;
    spinner.cancel("Final readiness validation interrupted");
    return interruptedFinalReadinessAssessment();
  }
}

function interruptedFinalReadinessAssessment(): AssessedFinalReadiness {
  return {
    ready: false,
    reasons: ["Final readiness validation was interrupted."],
    failedSectionIds: [],
    interrupted: true,
  };
}

async function assessPrewriteFirstRunConfigurationReadiness(options: {
  readonly cwd: string;
  readonly answers: WizardAnswers;
  readonly plan: WizardPlan;
  readonly env: Record<string, string | undefined>;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly secureExistingDotenv: boolean;
  readonly abortSignal?: AbortSignal;
}): Promise<AssessedConfigurationReadiness> {
  try {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const preview = await initMonoAgentFolder({
      dir: options.cwd,
      answers: options.answers,
      env: options.env,
      secretValues: options.secretValues,
      secureExistingDotenv: options.secureExistingDotenv,
      dryRun: true,
    });
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const report = await validateWizardPlanInStaging({
      plan: options.plan,
      sourceCwd: options.cwd,
      env: options.env,
      verifiedCredentialModelRefs: [],
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    const gate = evaluateFirstRunConfigurationReadiness({
      plan: options.plan,
      report,
      secretPersistence: preview.secretPersistence,
    });
    return {
      ...gate,
      failedSectionIds: configurationFailureSectionIds(options.plan, report, true),
    };
  } catch (error) {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      ready: false,
      reasons: [
        `The complete generated configuration could not be validated safely in staging: ${firstRunStagingFailureDetail(
          error,
          firstRunStagingSensitiveValues(options.env, options.secretValues),
        )}`,
      ],
      failedSectionIds: [],
    };
  }
}

async function assessPrewriteFirstRunReadiness(options: {
  readonly cwd: string;
  readonly answers: WizardAnswers;
  readonly plan: WizardPlan;
  readonly env: Record<string, string | undefined>;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly secureExistingDotenv: boolean;
  readonly verifiedCredentialModelRefs: readonly string[];
  readonly abortSignal?: AbortSignal;
}): Promise<AssessedFinalReadiness> {
  try {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const preview = await initMonoAgentFolder({
      dir: options.cwd,
      answers: options.answers,
      env: options.env,
      secretValues: options.secretValues,
      secureExistingDotenv: options.secureExistingDotenv,
      dryRun: true,
    });
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const report = await validateWizardPlanInStaging({
      plan: options.plan,
      sourceCwd: options.cwd,
      env: options.env,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    const gate = evaluateFirstRunReadiness({
      plan: options.plan,
      report,
      secretPersistence: preview.secretPersistence,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
    });
    return {
      ...gate,
      failedSectionIds: configurationFailureSectionIds(options.plan, report, false),
    };
  } catch (error) {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      ready: false,
      reasons: [
        `The complete generated plan could not be validated safely in staging: ${firstRunStagingFailureDetail(
          error,
          firstRunStagingSensitiveValues(options.env, options.secretValues),
        )}`,
      ],
      failedSectionIds: [],
    };
  }
}

function configurationFailureSectionIds(
  plan: WizardPlan,
  report: ValidationReport,
  deferWaitingCredentials: boolean,
): readonly string[] {
  const byId = new Map(report.sections.map((section) => [section.id, section]));
  const ids = new Set<string>();
  for (const expectation of plan.validateExpectations) {
    const actual = byId.get(expectation.sectionId)?.status;
    if (
      actual === expectation.mustBe
      || (deferWaitingCredentials && expectation.sectionId === "credentials" && actual === "waiting")
    ) continue;
    ids.add(expectation.sectionId);
  }
  if (!report.ok) {
    for (const section of report.sections) {
      if (section.status === "error") ids.add(section.id);
    }
  }
  return [...ids];
}

function sameConcreteEnvironment(left: CliEnvironment, right: CliEnvironment): boolean {
  const concreteEntries = (env: CliEnvironment): readonly (readonly [string, string])[] =>
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  const leftEntries = concreteEntries(left);
  const rightEntries = concreteEntries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(
    ([name, value], index) => rightEntries[index]?.[0] === name && rightEntries[index]?.[1] === value,
  );
}

function dotenvReadinessFailure(message: string): ReadinessProbeFailure {
  return { ok: false, kind: "invalid_plan", message };
}

async function firstRunDotenvDrift(
  path: string,
  expected: CliDotenvSnapshot,
): Promise<ReadinessProbeFailure | undefined> {
  let current: CliDotenvSnapshot;
  try {
    current = await readCliDotenvSnapshot(path);
  } catch {
    return dotenvReadinessFailure("The persisted .env became unreadable during setup. Readiness cannot be claimed.");
  }
  if (current.fingerprint === expected.fingerprint) return undefined;
  return dotenvReadinessFailure(
    "The persisted .env changed while setup was validating the agent. Review the change, then retry so the exact durable values can be checked.",
  );
}

async function firstRunConfigDrift(
  path: string,
  expected: CliConfigSnapshot,
): Promise<ReadinessProbeFailure | undefined> {
  let current: CliConfigSnapshot;
  try {
    current = await readCliConfigSnapshot(path);
  } catch {
    return dotenvReadinessFailure(
      "The committed config became unreadable or unsafe during setup. Readiness cannot be claimed.",
    );
  }
  if (current.fingerprint === expected.fingerprint) return undefined;
  return dotenvReadinessFailure(
    "The committed config changed while setup was validating the agent. Review the change, then retry so the exact plan can be checked.",
  );
}

async function firstRunSecretEnvGuardFailure(
  path: string,
  required: boolean,
): Promise<ReadinessProbeFailure | undefined> {
  if (!required) return undefined;
  try {
    if (await verifySecretEnvPersistenceGuard(path)) return undefined;
  } catch {
    // Fall through to one stable, non-secret-bearing operator message.
  }
  return dotenvReadinessFailure(
    "The committed .env is no longer owner-only, safely ignored, and untracked. Readiness cannot be claimed.",
  );
}

function secretPersistenceRecoveryMessage(error: unknown): string {
  const cause = secretEnvConcurrentModificationCause(error);
  return cause === undefined ? "" : ` ${cause.message}`;
}

interface ReadinessProgress {
  readonly planFingerprint: string;
  readonly successfulRouteKeys: readonly string[];
  readonly verifiedModelRefs: readonly string[];
}

function readinessPlanIdentity(plan: WizardPlan): {
  readonly fingerprint: string;
  readonly routes: readonly (Readonly<{ index: number; model: string; effort?: string; key: string }>)[];
} {
  const displayed = readinessRoutesForDisplay(plan);
  const immutable = displayed.map((route, index) => ({
    index,
    model: route.model,
    effort: route.effort ?? null,
  }));
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ version: 1, routes: immutable }))
      .digest("hex"),
    routes: displayed.map((route, index) => ({
      index,
      ...route,
      key: createHash("sha256")
        .update(JSON.stringify({ version: 1, index, model: route.model, effort: route.effort ?? null }))
        .digest("hex"),
    })),
  };
}

function mergeReadinessProgress(
  previous: ReadinessProgress | undefined,
  result: ReadinessProbeResult,
  plan: WizardPlan,
): ReadinessProgress {
  const identity = readinessPlanIdentity(plan);
  const fingerprint = result.planFingerprint ?? identity.fingerprint;
  const successfulKeys = new Set(
    previous?.planFingerprint === fingerprint ? previous.successfulRouteKeys : [],
  );
  const verifiedRefs = new Set(
    previous?.planFingerprint === fingerprint ? previous.verifiedModelRefs : [],
  );
  const reported = result.routes ?? (result.ok
    ? identity.routes.map((route): ReadinessRouteResult => ({ ...route, status: "verified" }))
    : []);
  for (const route of reported) {
    if (route.status === "verified" || route.status === "skipped_verified") {
      successfulKeys.add(route.key);
      verifiedRefs.add(route.model);
    }
  }
  const currentRefs = new Set(identity.routes.map((route) => route.model));
  return {
    planFingerprint: fingerprint,
    successfulRouteKeys: [...successfulKeys],
    verifiedModelRefs: [...verifiedRefs].filter((ref) => currentRefs.has(ref)),
  };
}

async function runGuidedSandboxPreflight(
  installedEarlier: boolean,
): Promise<ReadinessProbeResult> {
  process.stdout.write("\n" + ui.heading("Sandbox preflight"));
  return await withScopedPreflightCancellation(async (signal) => {
    try {
      process.stdout.write(ui.style.dim(
        installedEarlier
          ? "Rechecking the pinned managed SRT copy and its functional enforcement postcondition.\n"
          : "Installing the pinned managed SRT copy in the private user cache, then running the functional enforcement check.\n",
      ));
      const setup = await setupManagedSrt({ signal, verify: true });
      if (setup.status.source !== "managed" || setup.status.state !== "ready" || setup.check === undefined) {
        throw new Error("Managed SRT setup did not return a ready managed functional-check result.");
      }
      process.stdout.write(`${ui.badge("ok")}Managed SRT ${setup.repaired ? "repaired" : setup.installed ? "installed" : "verified"}; functional postcondition passed.\n`);
      return { ok: true };
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("Preflight was interrupted."));
        return {
          ok: false,
          kind: "cancelled",
          message: "Sandbox preflight was interrupted. No agent files were written.",
          interrupted: true,
        };
      }
      return {
        ok: false,
        kind: "provider_failed",
        message: `[sandbox_preflight_failed] ${reasonOf(error)} No agent files were written; retry setup or edit the sandbox choice.`,
      };
    }
  });
}

async function runReadinessProbeWithSpinner(options: {
  readonly plan: ReturnType<typeof composeWizardPlan>;
  readonly effectiveEnv: Record<string, string | undefined>;
  readonly resolvedPiAuthPath: string;
  readonly resume?: Readonly<{ planFingerprint: string; successfulRouteKeys: readonly string[] }>;
}): Promise<ReadinessProbeResult> {
  const routes = readinessRoutesForDisplay(options.plan);
  process.stdout.write("\n" + ui.heading("Runtime readiness"));
  routes.forEach((route, index) => {
    const timeoutMs = readinessProbeTimeoutMs(parseMonoRuntimeModelReference(route.model));
    process.stdout.write(
      `  Route ${index + 1}/${routes.length}: ${route.model} ` +
      ui.style.dim(`(effort: ${route.effort ?? "provider-default"}; up to ${Math.ceil(timeoutMs / 1_000)}s)`) +
      "\n",
    );
  });
  process.stdout.write(ui.style.dim("Running real no-tool checks sequentially. Press Esc or Ctrl-C once to interrupt safely.\n"));

  return await withScopedPreflightCancellation(async (signal) => {
    try {
      const result = await runAllRouteReadinessProbe({
        plan: options.plan,
        hostEnv: options.effectiveEnv,
        secretValues: selectedSecretValues(options.plan, options.effectiveEnv),
        resolvedPiAuthPath: options.resolvedPiAuthPath,
        abortSignal: signal,
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        onRouteStart: (route) => {
          process.stdout.write(
            `  Checking route ${route.index + 1}/${route.total}: ${route.model} ` +
            ui.style.dim(`(effort: ${route.effort ?? "provider-default"})`) +
            "\n",
          );
        },
        onRouteComplete: (route) => {
          const ok = route.status === "verified" || route.status === "skipped_verified";
          process.stdout.write(
            `${ok ? ui.badge("ok") : route.status === "interrupted" ? ui.badge("waiting") : ui.badge("error")}` +
            `Route ${route.index + 1}/${routes.length} ${route.status.replaceAll("_", " ")}\n`,
          );
        },
      });
      process.stdout.write(ui.heading("Readiness summary"));
      printReadinessRouteSummary(result, routes);
      return result;
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("Preflight was interrupted."));
        return {
          ok: false,
          kind: "cancelled",
          message: "Preflight was interrupted before the current route completed.",
          interrupted: true,
        };
      }
      process.stderr.write(ui.errorLine("[readiness_probe_failed] Runtime readiness could not run."));
      return {
        ok: false,
        kind: "probe_failed",
        message: "Runtime readiness could not run. Review provider authentication and retry.",
      };
    }
  });
}

type FirstRunRecovery = "retry" | "auth" | "model" | "edit" | "save" | "cancel";

type InterruptedFirstRunRecovery = "resume" | "restart" | "edit" | "cancel";
type SandboxPreflightRecovery = "retry" | "edit" | "cancel";

function focusedConfigurationRepairStep(sectionIds: readonly string[]): number | undefined {
  const mapped = new Set<number>();
  for (const id of sectionIds) {
    if (id === "agent") mapped.add(0);
    else if (id === "runtime" || id === "credentials") mapped.add(1);
    else if (id === "memory" || id.startsWith("memory:")) mapped.add(4);
    else if (id === "context" || id.startsWith("channel:")) mapped.add(5);
    else if (id === "tools") mapped.add(6);
    else if (id === "sandbox") mapped.add(7);
  }
  return mapped.size === 1 ? [...mapped][0] : undefined;
}

async function selectSandboxPreflightRecovery(): Promise<SandboxPreflightRecovery> {
  const recovery = await p.select<SandboxPreflightRecovery>({
    message: "Sandbox preflight did not pass. How would you like to recover?",
    initialValue: "retry",
    options: [
      { value: "retry", label: "Retry sandbox setup and check" },
      { value: "edit", label: "Change safety or other choices" },
      { value: "cancel", label: "Cancel without writing" },
    ],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function selectInterruptedFirstRunRecovery(): Promise<InterruptedFirstRunRecovery> {
  const recovery = await p.select<InterruptedFirstRunRecovery>({
    message: "Preflight was interrupted. What would you like to do?",
    initialValue: "resume",
    options: [
      { value: "resume", label: "Resume preflight", hint: "keeps successful auth, SRT setup, and route checks" },
      { value: "restart", label: "Restart all checks", hint: "keeps successful auth and SRT installation" },
      { value: "edit", label: "Edit setup choices" },
      { value: "cancel", label: "Cancel without writing" },
    ],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function selectFirstRunRecovery(
  failure: ReadinessProbeFailure,
  configurationRepairStep?: number,
  invalidPlanStage?: "configuration" | "final_readiness",
): Promise<FirstRunRecovery> {
  type RecoveryOption = { readonly value: FirstRunRecovery; readonly label: string; readonly hint?: string };
  const sharedTail: readonly RecoveryOption[] = [
    { value: "save", label: "Save incomplete", hint: "does not call the agent ready or start it" },
    { value: "cancel", label: "Cancel without writing" },
  ] as const;
  const providerSetupFailed = failure.kind === "provider_failed"
    && /^Provider setup (?:did not complete|still needs attention)\./u.test(failure.message);
  const message = failure.kind === "invalid_plan"
    ? invalidPlanStage === "final_readiness"
      ? "Final readiness validation did not pass. What would you like to do?"
      : "Configuration preflight did not pass. What would you like to do?"
    : providerSetupFailed
      ? "Provider setup did not pass. What would you like to do?"
      : "Runtime readiness did not pass. What would you like to do?";
  const options: readonly RecoveryOption[] = failure.kind === "invalid_plan"
    ? [
        { value: "edit", label: configurationRecoveryEditLabel(configurationRepairStep) },
        {
          value: "retry",
          label: invalidPlanStage === "final_readiness"
            ? "Retry final readiness validation"
            : "Retry configuration preflight",
        },
        ...sharedTail,
      ]
    : providerSetupFailed
      ? [
          { value: "auth", label: "Repair authentication" },
          { value: "retry", label: "Retry provider setup" },
          { value: "model", label: "Edit model routes" },
          ...sharedTail,
        ]
      : failure.kind === "provider_failed"
      ? [
          { value: "retry", label: "Retry failed route" },
          { value: "auth", label: "Repair authentication" },
          { value: "model", label: "Edit model routes" },
          ...sharedTail,
        ]
      : failure.kind === "unsupported_guided_probe"
        ? [
            { value: "model", label: "Edit model routes" },
            ...sharedTail,
          ]
        : [
            { value: "retry", label: "Retry runtime checks" },
            { value: "model", label: "Edit model routes" },
            ...sharedTail,
          ];
  const recovery = await p.select<FirstRunRecovery>({
    message,
    initialValue: options[0]?.value ?? "cancel",
    options: [...options],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function promptProviderSetupSecrets(
  plan: ProviderSetupPlan,
  existing: Readonly<Record<string, string>>,
  existingPersistence: Readonly<Record<string, "secure-store" | "environment">> = {},
  existingEnvironmentSecrets: Readonly<Record<string, string>> = {},
): Promise<{
  readonly apiKeys: Record<string, string>;
  readonly persistenceByProvider: Record<string, "secure-store" | "environment">;
  readonly environmentSecrets: Record<string, string>;
} | undefined> {
  const values = { ...existing };
  const persistenceByProvider = { ...existingPersistence };
  const environmentSecrets = { ...existingEnvironmentSecrets };
  for (const action of plan.actions) {
    if (!isProviderSetupPiApiKeyAction(action)) continue;
    const reviewedPersistence = existingPersistence[action.provider];
    const persistence = reviewedPersistence ?? await p.select<"secure-store" | "environment">({
      message: `How should ${action.label} receive ${action.envVar}?`,
      initialValue: "secure-store",
      options: [
        { value: "secure-store", label: "Store securely in Pi auth.json", hint: "owner-only credential store" },
        { value: "environment", label: `Use environment variable ${action.envVar}`, hint: "save it to the agent's owner-only .env" },
      ],
    });
    if (p.isCancel(persistence)) return undefined;
    if (persistence === "environment") {
      delete values[action.id];
      persistenceByProvider[action.provider] = "environment";
      const answer = await p.password({
        message: `Enter ${action.envVar} for the agent's owner-only .env`,
        validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
        clearOnError: true,
      });
      if (p.isCancel(answer)) return undefined;
      environmentSecrets[action.envVar] = answer;
      continue;
    }
    persistenceByProvider[action.provider] = "secure-store";
    delete environmentSecrets[action.envVar];
    const answer = await p.password({
      message: `Enter ${action.label} (${action.envVar})`,
      validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
      clearOnError: true,
    });
    if (p.isCancel(answer)) return undefined;
    values[action.id] = answer;
  }
  return { apiKeys: values, persistenceByProvider, environmentSecrets };
}

function environmentProviderApiKeys(
  plan: ProviderSetupPlan,
  env: CliEnvironment,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const action of plan.actions) {
    if (!isProviderSetupPiApiKeyAction(action) || action.persistence !== "environment") continue;
    const value = env[action.envVar];
    if (nonEmptyEnv(value)) values[action.id] = value;
  }
  return values;
}

function configuredSecretNames(
  result: InitMonoAgentFolderResult,
  effectiveEnv: CliEnvironment,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const secret of result.plan.secrets) {
    if (nonEmptyEnv(effectiveEnv[secret.envVar])) names.add(secret.envVar);
  }
  return names;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
