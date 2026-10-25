// Subprocess regression guard: explicit ownership must precede configured app
// acquisition. Fail before touching the real account home, not after a leak.
import { registerHooks } from "node:module";
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/app/dist/host/account-home.js")) {
    return { format: "module", shortCircuit: true,
      source: 'export function accountHomeDirectory() { throw new Error("Test subprocess attempted to use the real account home"); }' };
  }
  return nextLoad(url, context);
} });
