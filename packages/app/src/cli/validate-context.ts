import { resolve } from "node:path";
import type { ParsedCliArgs } from "../cli-args.js";
interface ValidateContext {
  readonly cwd: string;
  readonly configPath: string;
  readonly envFilePath: string;
  readonly allowFilesystemWrites: boolean;
}

export function resolveValidateContext(args: ParsedCliArgs, invocationCwd: string): ValidateContext {
  const cwd = resolve(invocationCwd, args.consumerPath ?? ".");
  return {
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
    envFilePath: resolve(cwd, args.envFile ?? ".env"),
    allowFilesystemWrites: args.consumerPath === undefined,
  };
}
