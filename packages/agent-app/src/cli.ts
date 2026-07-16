#!/usr/bin/env node
import { basename } from "node:path";

export * from "./cli-commands.js";

import { runCli } from "./cli-commands.js";

const cliEntryName = process.argv[1] === undefined ? undefined : basename(process.argv[1]);
const isDirectCliInvocation = cliEntryName === "cli.js" || cliEntryName === "mono-agent";
if (isDirectCliInvocation) void runCli(process.argv.slice(2));
