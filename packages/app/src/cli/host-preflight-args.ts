import { DEFAULT_WEB_PORT } from "../service/web/web-service-definition.js";

export const HOST_PREFLIGHT_HELP = `mono-agent preflight [--json] [--port <n>]
Check this host without loading config, .env, credentials, or providers.
Optional capabilities are warnings/info, not required installation steps.
Exit codes: 0 no errors; 1 host/probe failure; 2 invalid arguments.
`;
export interface HostPreflightArgs { readonly json: boolean; readonly port: number; readonly help: boolean }
export function parseHostPreflightArgs(argv: readonly string[]): HostPreflightArgs {
  let json = false;
  let port = DEFAULT_WEB_PORT;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") json = true;
    else if (token === "--help" || token === "-h") help = true;
    else if (token === "--port") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error("--port requires an integer from 1 to 65535.");
      }
      port = Number(value);
    } else throw new Error(`Unsupported preflight argument: ${token ?? ""}`);
  }
  return { json, port, help };
}
