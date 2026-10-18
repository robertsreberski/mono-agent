import process from "node:process";

import { attachScopedKeypress } from "../cli/cli-cancellation.js";

export async function withScopedPreflightCancellation<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: { readonly keypress?: boolean } = {},
): Promise<T> {
  const controller = new AbortController();
  let interruptCount = 0;
  const interrupt = (): void => {
    interruptCount += 1;
    controller.abort();
    if (interruptCount > 1) process.exitCode = 130;
  };
  const onKeypress = (_value: string, key: { readonly name?: string; readonly ctrl?: boolean } | undefined): void => {
    if (key?.name === "escape" || (key?.ctrl === true && key.name === "c")) interrupt();
  };
  process.on("SIGINT", interrupt);
  const restoreKeypress = options.keypress === false
    ? () => undefined
    : attachScopedKeypress(onKeypress);
  try {
    return await task(controller.signal);
  } finally {
    process.off("SIGINT", interrupt);
    restoreKeypress();
  }
}
