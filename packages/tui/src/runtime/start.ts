import React from "react";
import { render } from "ink";

import { TuiApp, type TuiAppProps } from "../components/TuiApp.js";

export interface StartMonoAgentTuiOptions extends TuiAppProps {
  readonly stdout?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly debug?: boolean;
  /**
   * Forwarded to ink's `render({ patchConsole })`. Defaults to `false` so the
   * TUI does not silently swallow host `console.*` output; set it to `true`
   * to let Ink intercept and redraw console writes above the app.
   */
  readonly patchConsole?: boolean;
}

export interface StartMonoAgentTuiHandle {
  /** Resolves once the Ink app unmounts (user quit or programmatic stop). */
  waitUntilExit(): Promise<void>;
  /** Unmount the app and restore the TTY. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Mount the TUI against the live TTY (or the provided stdin/stdout pair).
 *
 * Hosts that already manage Ink should embed `<TuiApp />` directly; this
 * convenience function wires `ink.render` for the common case.
 */
export function startMonoAgentTui(
  options: StartMonoAgentTuiOptions,
): StartMonoAgentTuiHandle {
  const {
    stdout,
    stdin,
    stderr,
    debug,
    patchConsole = false,
    ...appProps
  } = options;

  const stdinTarget = stdin ?? (process.stdin as NodeJS.ReadStream);
  if (
    stdin === undefined &&
    typeof stdinTarget.isTTY === "boolean" &&
    stdinTarget.isTTY === false
  ) {
    throw new Error(
      "startMonoAgentTui requires a TTY stdin. Pipe a stdin manually for non-TTY use.",
    );
  }

  const instance = render(React.createElement(TuiApp, appProps), {
    stdout: stdout ?? process.stdout,
    stdin: stdinTarget,
    stderr: stderr ?? process.stderr,
    debug: debug ?? false,
    patchConsole,
    exitOnCtrlC: appProps.exitOnCtrlC ?? true,
  });

  let stopped = false;
  return {
    async waitUntilExit(): Promise<void> {
      await instance.waitUntilExit();
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      instance.unmount();
      try {
        await instance.waitUntilExit();
      } catch {
        // ignore
      }
    },
  };
}
