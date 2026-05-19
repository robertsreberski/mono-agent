#!/usr/bin/env node
import { startDownloadsCuratorCli } from "./cli.js";

void startDownloadsCuratorCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
