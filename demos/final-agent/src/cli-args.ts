import { resolve } from "node:path";

export interface CliArgs {
  readonly configPath?: string;
  readonly port?: number;
  readonly help: boolean;
}

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): CliArgs {
  let configPath: string | undefined;
  let port: number | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error("--config requires a path.");
      }
      configPath = resolve(cwd, value);
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw new Error("--port requires a numeric port.");
      }
      port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be between 0 and 65535.");
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    help,
    ...(configPath === undefined ? {} : { configPath }),
    ...(port === undefined ? {} : { port }),
  };
}
