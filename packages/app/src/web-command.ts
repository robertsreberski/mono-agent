import { type RunWebCommandOptions, type RunWebCommandDeps } from "./service/web/types.js";
import process from "node:process";

import { invalidWebConsoleName, isWebTheme, WEB_THEMES } from "./web-service-definition.js";
import { errorMessage, renderWebHelp } from "./service/web/presentation.js";
import { resetWeb, runWebForeground, startWebBackground, stopWebBackground, tailWebLogs } from "./service/web/service.js";
import { statusWeb } from "./service/web/status.js";
import * as ui from "./ui.js";

/** Route the `mono-agent web` service namespace. Bare invocation is read-only. */
export async function runWebCommand(
  options: RunWebCommandOptions,
  deps: RunWebCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const action = options.positionals[0];
  if (options.positionals.length > 1 || (action !== undefined && !WEB_ACTIONS.has(action))) {
    stderr.write(ui.errorLine(`Unknown mono-agent web action \`${options.positionals.join(" ")}\`.`));
    stdout.write(renderWebHelp());
    return 2;
  }
  const validation = validateWebFlags(action, options);
  if (validation !== undefined) {
    stderr.write(ui.errorLine(validation));
    stdout.write(renderWebHelp());
    return 2;
  }
  // The Linux lifecycle publishes no Tailscale route of its own; refuse the flag
  // instead of accepting a meaningless request.
  if ((deps.platform ?? process.platform) === "linux"
    && options.shareTailnet === true && (action === "start" || action === "restart")) {
    stderr.write(ui.errorLine(
      "Linux HTTPS routes are externally managed; --share-tailnet manages the macOS Tailscale Serve route.",
    ));
    stdout.write(renderWebHelp());
    return 2;
  }

  if ((deps.platform ?? process.platform) === "linux" && action !== "run" && action !== "reset") {
    if (action === undefined) stdout.write(renderWebHelp());
    const { runSystemdWebCommand } = await import("./systemd-command.js");
    const { isSystemdUserManagerUnavailable } = await import("./systemd.js");
    try {
      return await runSystemdWebCommand(options, {
        ...deps.systemd,
        ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
        stdout, stderr,
      });
    } catch (error) {
      if (!isSystemdUserManagerUnavailable(error) || (action !== undefined && action !== "status")) throw error;
      if (action === undefined) {
        await statusWeb(options, deps, false);
        return 0;
      }
      return await statusWeb(options, deps, true);
    }
  }

  if ((deps.platform ?? process.platform) === "linux" && action === "reset") {
    const { withSystemdLock, SYSTEMD_WEB_IDENTITY } = await import("./systemd.js");
    try {
      return await withSystemdLock(SYSTEMD_WEB_IDENTITY, {
        ...deps.systemd, ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
      }, () => resetWeb(options, deps));
    } catch (error) {
      stderr.write(ui.errorLine(`Linux web reset failed: ${errorMessage(error)}`));
      return 1;
    }
  }

  if (action === undefined) {
    stdout.write(renderWebHelp());
    await statusWeb(options, deps, false);
    return 0;
  }
  switch (action) {
    case "run":
      return await runWebForeground(options, deps);
    case "start":
      return await startWebBackground(options, deps, false);
    case "restart":
      return await startWebBackground(options, deps, true);
    case "stop":
      return await stopWebBackground(options, deps);
    case "status":
      return await statusWeb(options, deps, true);
    case "logs":
      return await tailWebLogs(options, deps);
    case "reset":
      return await resetWeb(options, deps);
  }
  return 2;
}

const WEB_ACTIONS: ReadonlySet<string> = new Set(["start", "stop", "restart", "status", "logs", "run", "reset"]);

function validateWebFlags(action: string | undefined, options: RunWebCommandOptions): string | undefined {
  if (options.loopback === true && options.host !== undefined) {
    return "Choose either --loopback or --host, not both.";
  }
  if (options.shareTailnet === true && action !== "start" && action !== "restart") {
    return "--share-tailnet is only supported for `mono-agent web start` and `mono-agent web restart`.";
  }
  if (options.json === true && action !== "status") {
    return "--json is only supported for `mono-agent web status`.";
  }
  if (options.port !== undefined && options.port === 0) {
    return "mono-agent web requires a stable --port between 1 and 65535.";
  }
  if (options.theme !== undefined && !isWebTheme(options.theme)) {
    return `--theme must be one of: ${WEB_THEMES.join(", ")}.`;
  }
  if (options.name !== undefined) {
    const nameError = invalidWebConsoleName(options.name);
    if (nameError !== undefined) return nameError;
  }
  if ((options.host !== undefined || options.port !== undefined || options.theme !== undefined
    || options.name !== undefined || options.loopback === true)
    && action !== "start" && action !== "restart" && action !== "run") {
    return "--host, --port, --theme, --name, and --loopback are only supported for web start, restart, or run.";
  }
  if ((options.follow === true || options.lines !== undefined) && action !== "logs") {
    return "--follow and --lines are only supported for mono-agent web logs.";
  }
  if ((options.all === true || options.yes === true) && action !== "reset") {
    return "--all and --yes are only supported for mono-agent web reset in this command namespace.";
  }
  if (action === "reset" && (options.all !== true || options.yes !== true)) {
    return "Destructive reset requires the exact confirmation: mono-agent web reset --all --yes.";
  }
  return undefined;
}
