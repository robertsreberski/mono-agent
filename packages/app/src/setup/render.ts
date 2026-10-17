import { modelReferenceFromConfigJson } from "@mono-agent/config";
import process from "node:process";

import { riskColor } from "../cli-validate-config-command.js";
import type { InitMonoAgentFolderResult } from "./scaffold-types.js";
import { deriveLaunchdLabel, launchdPathsFor } from "../launchd.js";
import { providerSetupActionCommandLine } from "../provider-setup.js";
import type { ProviderSetupPlan } from "../provider-setup.js";
import type {
  ReadinessProbeResult,
  ReadinessRouteResult,
} from "../readiness-probe.js";
import type { SecretChecklistItem, WizardPlan } from "./wizard-types.js";
import * as ui from "../ui.js";

export function readinessRoutesForDisplay(plan: WizardPlan): readonly { model: string; effort?: string }[] {
  const runtime = (plan.configJson.runtime ?? {}) as Record<string, unknown>;
  const primaryEffort = typeof runtime.effort === "string" ? runtime.effort : undefined;
  const routes: Array<{ model: string; effort?: string }> = [];
  const primary = modelReferenceFromConfigJson(plan.configJson.runtime?.model);
  if (primary !== undefined) {
    routes.push({ model: primary, ...(primaryEffort === undefined ? {} : { effort: primaryEffort }) });
  }
  if (Array.isArray(runtime.fallbacks) && runtime.fallbacks.length > 0) {
    for (const raw of runtime.fallbacks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.model !== "string") continue;
      routes.push({
        model: entry.model,
        ...(typeof entry.effort === "string" ? { effort: entry.effort } : {}),
      });
    }
  }
  return routes;
}

export function printReadinessRouteSummary(
  result: ReadinessProbeResult,
  planned: readonly { model: string; effort?: string }[],
): void {
  const reported = result.routes ?? planned.map((route, index): ReadinessRouteResult => ({
    key: `${index}:${route.model}`,
    index,
    ...route,
    status: result.ok ? "verified" : result.kind === "cancelled" ? "interrupted" : "failed",
    ...(!result.ok ? { kind: result.kind, message: result.message } : {}),
  }));
  for (const route of reported) {
    const badge = route.status === "verified" || route.status === "skipped_verified"
      ? ui.badge("ok")
      : route.status === "interrupted"
        ? ui.badge("waiting")
        : ui.badge("error");
    const state = route.status === "skipped_verified" ? "verified earlier" : route.status.replaceAll("_", " ");
    process.stdout.write(
      `${badge}Route ${route.index + 1}/${planned.length}: ${route.model} ` +
      ui.style.dim(`(effort: ${route.effort ?? "provider-default"})`) +
      ` — ${state}${route.message === undefined ? "" : `: ${route.message}`}\n`,
    );
  }
  if (!result.ok && result.interrupted === true) {
    process.stderr.write(ui.errorLine("Preflight was interrupted."));
  }
}

export function configurationRecoveryEditLabel(step: number | undefined): string {
  switch (step) {
    case 0: return "Edit agent name";
    case 1: return "Edit model routes";
    case 4: return "Edit memory";
    case 5: return "Edit capability details";
    case 6: return "Edit tools";
    case 7: return "Edit route safety and sandbox";
    default: return "Edit setup choices";
  }
}

export function printIncompleteSetup(reasons: readonly string[], configPath: string): void {
  process.stderr.write(ui.hint("INCOMPLETE SETUP: no readiness claim was made and the agent was not started.\n"));
  for (const reason of reasons) process.stderr.write(ui.style.yellow(`  - ${reason}\n`));
  process.stderr.write(ui.hint(`Review ${configPath}, run \`mono-agent validate\`, then retry the first turn.\n`));
}

export function printProviderSetupPlan(plan: ProviderSetupPlan): void {
  for (const action of plan.actions) {
    process.stdout.write(
      `  ${action.label}: ${providerSetupActionCommandLine(action)} ${ui.style.dim(`(cwd: ${action.cwd})`)}\n`,
    );
  }
}

interface InitChangeDisplayRow {
  readonly label: "created" | "updated" | "kept" | "would create" | "would update";
  readonly path: string;
  readonly unchanged: boolean;
}

/** Safe reporting rows: paths and outcomes only, never secret contents. */
export function initChangeDisplayRows(result: InitMonoAgentFolderResult): readonly InitChangeDisplayRow[] {
  const labels = {
    created: "created",
    updated: "updated",
    unchanged: "kept",
    "planned-create": "would create",
    "planned-update": "would update",
  } as const;
  return result.changes.map((change) => ({
    label: labels[change.kind],
    path: change.path,
    unchanged: change.kind === "unchanged",
  }));
}

/** Human-readable, value-free proof of where the wizard Role did (or did not) land. */
export function identityRoleDisplayLine(identityRole: InitMonoAgentFolderResult["identityRole"]): string {
  switch (identityRole.status) {
    case "created":
      return `Role saved to ${identityRole.path} → ${identityRole.section}. ` +
        `Edit ${identityRole.path} → ${identityRole.section} later to change it.`;
    case "preserved":
      return `${identityRole.path} already existed and was preserved; the entered Role was not written. ` +
        `Add or edit ${identityRole.path} → ${identityRole.section} to set it.`;
    case "planned-create":
      return `Dry run: Role would be saved to ${identityRole.path} → ${identityRole.section}.`;
  }
}

interface SecretChecklistDisplayRow {
  readonly envVar: string;
  readonly label: string;
  readonly description: string;
  readonly status: "configured" | "missing" | "optional";
}

export function secretChecklistDisplayRows(
  secrets: readonly SecretChecklistItem[],
  configured: ReadonlySet<string>,
): readonly SecretChecklistDisplayRow[] {
  return secrets.map((secret) => ({
    envVar: secret.envVar,
    label: secret.label,
    description: secret.description,
    status: configured.has(secret.envVar) ? "configured" : secret.required ? "missing" : "optional",
  }));
}

export function printInitResult(result: InitMonoAgentFolderResult): void {
  if (result.dryRun) {
    process.stdout.write(ui.style.dim("Dry run — nothing was written.\n"));
  }
  for (const row of initChangeDisplayRows(result)) {
    const prefix = row.unchanged ? "  " : ui.badge("ok");
    const rendered = row.unchanged
      ? ui.style.dim(row.label.padEnd(12))
      : ui.style.green(row.label.padEnd(12));
    // Sensitive files are safe to identify by path; their contents are never
    // included in this result or printed here.
    process.stdout.write(`${prefix}${rendered}  ${row.path}\n`);
  }
  process.stdout.write(`\n${identityRoleDisplayLine(result.identityRole)}\n`);
  if (result.knowledgeFiles.length > 0) {
    process.stdout.write(`\nIdentity references existing knowledge: ${ui.style.cyan(result.knowledgeFiles.join(", "))}\n`);
  }
  // Internal `provider:*` modules are auto-added for local models; they are an
  // implementation detail, not a user-facing capability, so exclude them here.
  const capabilities = result.plan.selectedModules.filter((module) => module.kind !== "provider");
  if (capabilities.length > 0) {
    process.stdout.write("\n" + ui.heading("Capabilities"));
    for (const module of capabilities) {
      process.stdout.write(`  ${ui.style.cyan(module.title)} ${ui.style.dim(`(risk: ${riskColor(module.riskLevel)})`)}\n`);
    }
  }
  if (result.secretPersistence.status === "persisted") {
    process.stdout.write("\n" + ui.style.dim(
      result.secretPersistence.changed
        ? "Required secrets were securely merged into .env (mode 0600).\n"
        : "Required secrets were already securely configured in .env.\n",
    ));
  } else if (result.secretPersistence.status === "planned") {
    process.stdout.write("\n" + ui.style.dim("Dry run: required secrets would be securely merged into .env.\n"));
  } else if (result.secretPersistence.status === "refused") {
    process.stderr.write(ui.hint(
      `Automatic secret persistence was refused${result.secretPersistence.reason === undefined ? "" : ` (${result.secretPersistence.reason})`}. No secret value was written.\n` +
      (result.secretPersistence.detail === undefined ? "" : `${result.secretPersistence.detail}\n`),
    ));
  } else if (result.plan.envExample !== undefined) {
    process.stdout.write("\n" + ui.style.dim("Use .env.example as a reference and add missing values to .env; do not overwrite an existing .env.\n"));
  }
}

export function printSecretsChecklist(
  secrets: readonly SecretChecklistItem[],
  configured: ReadonlySet<string> = new Set(),
): void {
  process.stdout.write("\n" + ui.heading("Secrets checklist"));
  if (secrets.length === 0) {
    process.stdout.write(ui.style.dim("No secrets required by the selected capabilities.\n"));
    return;
  }
  process.stdout.write(ui.style.dim("Secret values are never written to config JSON and are never printed.\n"));
  for (const secret of secretChecklistDisplayRows(secrets, configured)) {
    const status = secret.status === "configured"
      ? ui.style.green(secret.status)
      : ui.style.yellow(secret.status);
    process.stdout.write(
      `  ${ui.style.bold(secret.envVar)} ${ui.style.dim(`- ${secret.label}: ${secret.description}`)} ${status}\n`,
    );
  }
}

/**
 * Browser-console defaults for the handoff text. Mirrored from
 * `web-command.ts` (DEFAULT_WEB_HOST/DEFAULT_WEB_PORT) instead of importing that
 * large module into the init path; `cli-first-run-state.test.ts` asserts parity.
 */
export const BROWSER_CONSOLE_HOST = "127.0.0.1";
export const BROWSER_CONSOLE_PORT = 5050;
const BROWSER_CONSOLE_COMMAND = "mono-agent web run --loopback";
const BROWSER_CONSOLE_URL = `http://${BROWSER_CONSOLE_HOST}:${String(BROWSER_CONSOLE_PORT)}`;

/**
 * The one truthful console caveat, shared by every handoff: the loopback bind
 * narrows the listener only — an existing Tailscale Serve route, reverse proxy,
 * or tunnel that already points at the port is not removed, and the console has
 * no application login.
 */
function browserConsoleBoundaryLine(): string {
  return ui.style.dim(
    "The console has no login, so keep it on loopback. --loopback narrows the listener only: an existing proxy, " +
    "tunnel, or Tailscale route that points at the port is not removed.\n",
  );
}

/** Machine-local discovery: a remote session can only reach this console by forwarding the port. */
function remoteSessionHintLines(): readonly string[] {
  if (process.env.SSH_CONNECTION === undefined && process.env.SSH_TTY === undefined) return [];
  return [ui.style.dim(
    "Remote session: the console discovers agents on the machine it runs on. Forward the port to the computer with " +
    `the browser (ssh -L ${String(BROWSER_CONSOLE_PORT)}:${BROWSER_CONSOLE_HOST}:${String(BROWSER_CONSOLE_PORT)} <this-host>) ` +
    `and open ${BROWSER_CONSOLE_URL} there — or move both the agent and the console to that computer.\n`,
  )];
}

export function printNextSteps(configPath: string): void {
  const startCommand = process.platform === "darwin" || process.platform === "linux"
    ? "mono-agent start"
    : "mono-agent start --foreground";
  const lines = [
    "\n" + ui.heading("Next steps"),
    ui.style.dim("Scaffold only: no readiness proof and no process was started.\n"),
    `  ${ui.style.bold("1.")} mono-agent validate\n`,
    `  ${ui.style.bold("2.")} ${startCommand} ${ui.style.dim("(add --foreground where no user service manager exists)")}\n`,
    `  ${ui.style.bold("3.")} ${BROWSER_CONSOLE_COMMAND} ${ui.style.dim("(keep this terminal open)")}\n`,
    `  ${ui.style.bold("4.")} Open ${ui.style.cyan(BROWSER_CONSOLE_URL)} and send a message ${ui.style.dim(`(add --port <n> if ${String(BROWSER_CONSOLE_PORT)} is taken)`)}\n`,
    ui.style.dim(`Edit ${configPath} to change model, channels, skills, memory, or sandbox.\n`),
    browserConsoleBoundaryLine(),
    ...remoteSessionHintLines(),
  ];
  process.stdout.write(lines.join(""));
}

export function printUnsupportedGuidedInitHandoff(configPath: string, envFile?: string): void {
  const flags = guidedHandoffFlags(configPath, envFile);
  const backgroundSupported = process.platform === "linux";
  const startCommand = backgroundSupported ? "mono-agent start" : "mono-agent start --foreground";
  const lines = [
    "\n" + ui.heading("Manual start required"),
    ui.style.yellow(backgroundSupported
      ? "Guided init does not start the Linux systemd user service automatically.\n"
      : "Automatic background start requires macOS launchd or Linux systemd.\n"),
    ui.style.dim("The validated agent files were preserved, but no agent process was started and readiness is not claimed.\n"),
    `  ${ui.style.bold("Terminal 1:")} ${startCommand}${flags}` +
      (backgroundSupported ? ` ${ui.style.dim("(add --foreground when no usable systemd user manager exists)")}` : "") + "\n",
    `  ${ui.style.bold("Terminal 2:")} ${BROWSER_CONSOLE_COMMAND} ${ui.style.dim("(keep it open)")}\n`,
    `  ${ui.style.bold("Then open:")} ${ui.style.cyan(BROWSER_CONSOLE_URL)} and send a message ${ui.style.dim(`(add --port <n> if ${String(BROWSER_CONSOLE_PORT)} is taken)`)}\n`,
    ...(backgroundSupported
      ? []
      : [ui.style.dim("Keep the foreground agent process running while you use the console.\n")]),
    browserConsoleBoundaryLine(),
    ...remoteSessionHintLines(),
  ];
  process.stdout.write(lines.join(""));
}

export function printReadyAgentHandoff(configPath: string, envFile?: string): void {
  const flags = guidedHandoffFlags(configPath, envFile);
  const lines = [
    "\n" + ui.heading("Chat in the browser"),
    `  ${ui.style.bold("1.")} mono-agent status${flags} ${ui.style.dim("(confirm the background agent is running)")}\n`,
    `  ${ui.style.bold("2.")} ${BROWSER_CONSOLE_COMMAND} ${ui.style.dim("(second terminal; keep it open)")}\n`,
    `  ${ui.style.bold("3.")} Open ${ui.style.cyan(BROWSER_CONSOLE_URL)} and send a message ${ui.style.dim(`(add --port <n> if ${String(BROWSER_CONSOLE_PORT)} is taken)`)}\n`,
    browserConsoleBoundaryLine(),
    ...remoteSessionHintLines(),
    ui.style.dim(`After editing ${configPath}: mono-agent validate${flags}, then mono-agent restart${flags}.\n`),
  ];
  process.stdout.write(lines.join(""));
}

export function printUnexpectedGuidedBackgroundFailure(configPath: string, envFile: string | undefined, error: unknown): void {
  const flags = guidedHandoffFlags(configPath, envFile);
  const paths = launchdPathsFor(deriveLaunchdLabel(configPath));
  process.stderr.write(ui.errorLine(
    `The background lifecycle failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
  ));
  process.stderr.write(ui.style.dim(
    "The validated agent files were preserved, but the background agent is not ready. Retry or inspect with:\n",
  ));
  process.stderr.write(
    `  ${ui.style.gray("logs:  ")} ${paths.stderrPath}\n` +
      `          ${paths.stdoutPath}\n` +
      `  ${ui.style.gray("retry: ")} mono-agent start${flags}\n` +
      `  ${ui.style.gray("status:")} mono-agent status${flags}\n` +
      `  ${ui.style.gray("follow:")} mono-agent logs${flags} --follow\n`,
  );
}

function guidedHandoffFlags(configPath: string, envFile?: string): string {
  return ` --config ${shellCommandArgument(configPath)}`
    + (envFile === undefined ? "" : ` --env-file ${shellCommandArgument(envFile)}`);
}

function shellCommandArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
