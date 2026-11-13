import * as p from "@clack/prompts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runWebCommand } from "../cli/commands/web-command.js";
import { webHealthcheck } from "../service/web/health.js";
import { inspectSystemd, SYSTEMD_WEB_IDENTITY } from "../service/systemd/systemd.js";

export type ConsoleHandoffChoice = "later" | "managed" | "foreground";
export interface ConsoleHandoffDependencies {
  readonly platform?: NodeJS.Platform;
  readonly hasUserManager?: () => Promise<boolean>;
  readonly choose?: (choices: readonly ConsoleHandoffChoice[]) => Promise<ConsoleHandoffChoice>;
  readonly write?: (text: string) => void;
  readonly promptIO?: Pick<p.CommonOptions, "input" | "output">;
  readonly existing?: () => Promise<string | undefined>;
  readonly managed?: () => Promise<string | undefined>;
  readonly foreground?: (ready: (url: string) => Promise<void>) => Promise<void>;
  readonly health?: (url: string) => Promise<boolean>;
  readonly open?: (url: string) => Promise<void>;
}

export function consoleHandoffUrl(base: string, sourceId: string): string {
  const url = new URL(base);
  url.searchParams.set("agent", sourceId);
  url.searchParams.set("settings", "capabilities");
  return url.href;
}

/** Called only after guided init's route/config readiness proof, never scaffold init. */
export async function offerConsoleHandoff(
  options: { readonly sourceId: string; readonly agentReady: boolean; readonly env: Record<string, string | undefined> },
  dependencies: ConsoleHandoffDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const write = dependencies.write ?? ((text) => process.stdout.write(text));
  write("\nOptional browser console: there is no login. Anyone who can reach it can use its operator powers (including chat and supported controls). Loopback does not protect an existing proxy, tunnel or Serve route. This handoff never enables sharing, changes an existing listener, or restarts a console.\n");
  const hasManager = platform === "darwin" || (platform === "linux" && await (dependencies.hasUserManager ?? userManagerAvailable)());
  if (!options.agentReady) write(`The agent still needs starting in a separate terminal: mono-agent start${platform !== "darwin" && !hasManager ? " --foreground" : ""}. Use the exact config/env flags printed above.\n`);
  const choices: readonly ConsoleHandoffChoice[] = hasManager ? ["later", "managed", "foreground"] : ["later", "foreground"];
  const choose = dependencies.choose ?? (async (choices) => {
    const input = dependencies.promptIO?.input ?? process.stdin;
    if (input.readableEnded || input.destroyed) return "later";
    const cancel = new AbortController();
    const onEnd = () => cancel.abort();
    const onKey = (_text: string, key: { ctrl?: boolean; name?: string }) => {
      if (key?.ctrl && key.name === "d") cancel.abort();
    };
    input.once("end", onEnd); input.on("keypress", onKey);
    try {
      const answer = await p.select<ConsoleHandoffChoice>({
      ...dependencies.promptIO, signal: cancel.signal,
      message: "Open the browser console?", initialValue: "later",
      options: choices.map((value) => ({ value, label: value === "later" ? "Not now" : value === "managed" ? "Start / reuse managed console" : "Run foreground console in this terminal (Ctrl-C to stop)" })),
    });
      return p.isCancel(answer) ? "later" : answer;
    } finally { input.off("end", onEnd); input.off("keypress", onKey); }
  });
  const choice = await choose(choices);
  if (choice === "later" || !choices.includes(choice)) return;
  const present = async (base: string) => {
    const url = consoleHandoffUrl(base, options.sourceId);
    write(`Console for this agent (waits for discovery): ${url}\n`);
    const health = new URL("/healthz", base).href;
    if (!await (dependencies.health ?? webHealthcheck)(health)) {
      write("Console health was not confirmed; browser was not opened. Inspect mono-agent web status.\n");
      return;
    }
    const headless = Boolean(options.env.SSH_CONNECTION || options.env.SSH_TTY)
      || (platform === "linux" && !options.env.DISPLAY && !options.env.WAYLAND_DISPLAY);
    if (!headless) {
      try { await (dependencies.open ?? ((url) => openBrowser(url, platform)))(url); return; }
      catch { write("Could not open a browser automatically.\n"); }
    }
    const port = new URL(base).port || "80";
    write(`Open the URL manually. For a remote host, forward the console's loopback port from your own computer: ssh -N -L ${port}:127.0.0.1:${port} <user>@<host>\nKeep the forwarding private; no login is added by forwarding.\n`);
  };
  try {
    const existing = await (dependencies.existing ?? (() => existingConsoleHandoff(options.env)))();
    if (existing !== undefined) { await present(existing); return; }
    if (choice === "managed") {
      const base = await (dependencies.managed ?? (() => startManagedConsoleHandoff(options.env)))();
      if (base === undefined) write("Console handoff did not start a healthy console. Inspect mono-agent web status; agent readiness is unchanged.\n");
      else await present(base);
    } else {
      write("Foreground console uses this terminal. Keep the agent running in a separate terminal.\n");
      await (dependencies.foreground ?? (async (ready) => {
        await runWebCommand({ positionals: ["run"], env: options.env, loopback: true }, {
          startServer: async (input) => {
            const { startWebServer } = await import("@mono-agent/web");
            const handle = await startWebServer(input);
            await ready(handle.url);
            return handle;
          },
        });
      }))(present);
    }
  } catch {
    write("Console handoff could not complete. Agent readiness is unchanged. Inspect mono-agent web status, or run mono-agent web run --loopback manually.\n");
  }
}

async function userManagerAvailable(): Promise<boolean> {
  try { await inspectSystemd(SYSTEMD_WEB_IDENTITY); return true; }
  catch { return false; }
}

async function inspectConsoleHandoff(env: Record<string, string | undefined>, run: typeof runWebCommand) {
  let json = "";
  await run({ positionals: ["status"], env, json: true }, { stdout: { write: (text) => { json += text; } } });
  return JSON.parse(json) as {
    listener?: { url?: unknown; source?: unknown; provenRunning?: unknown };
    ownedTailscaleRoute?: { state?: unknown };
  };
}

/** Status proves the existing listener identity, not merely a bound port. */
export async function existingConsoleHandoff(env: Record<string, string | undefined>, run: typeof runWebCommand = runWebCommand): Promise<string | undefined> {
  const status = await inspectConsoleHandoff(env, run);
  return status.listener?.provenRunning === true && typeof status.listener.url === "string" ? status.listener.url : undefined;
}

/** Preserve every existing listener/definition. Only a fresh install may be started here. */
export async function startManagedConsoleHandoff(
  env: Record<string, string | undefined>,
  run: typeof runWebCommand = runWebCommand,
): Promise<string | undefined> {
  const before = await inspectConsoleHandoff(env, run);
  if (before.listener?.provenRunning === true && typeof before.listener.url === "string") return before.listener.url;
  if (before.listener?.source !== "fresh default"
    || !["none", "not-managed"].includes(String(before.ownedTailscaleRoute?.state))) return undefined;
  if (await run({ positionals: ["start"], env, loopback: true }) !== 0) return undefined;
  const after = await inspectConsoleHandoff(env, run);
  return after.listener?.provenRunning === true && typeof after.listener.url === "string" ? after.listener.url : undefined;
}

async function openBrowser(url: string, platform: NodeJS.Platform): Promise<void> {
  const exec = promisify(execFile);
  if (platform === "darwin") await exec("open", [url], { timeout: 5000 });
  else if (platform === "win32") await exec("rundll32", ["url.dll,FileProtocolHandler", url], { timeout: 5000 });
  else await exec("xdg-open", [url], { timeout: 5000 });
}
