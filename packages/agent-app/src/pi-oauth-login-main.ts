#!/usr/bin/env node
import { runPiOAuthLogin } from "./pi-oauth-login.js";

const [provider, ...extra] = process.argv.slice(2);
if (provider === undefined || (provider === "openai" ? extra.length !== 1 : extra.length > 0)) {
  process.stderr.write("Usage: mono-agent-pi-oauth-login <provider> [durable-auth-path-for-openai]\n");
  process.exitCode = 2;
} else {
  runPiOAuthLogin(provider, provider === "openai" ? { deviceIdAuthPath: extra[0]! } : {}).catch((error: unknown) => {
    process.stderr.write(`Pi OAuth login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
