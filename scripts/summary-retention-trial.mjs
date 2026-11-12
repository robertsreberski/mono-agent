#!/usr/bin/env node
// No network or credential reads in --dry-run. Paid mode is explicit, one shot.
import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { open, rename, writeFile } from "node:fs/promises";
import { runTrial, resolveTrialModels } from "./lib/summary-retention-trial.mjs";

const { values } = parseArgs({ options: {
  "dry-run": { type: "boolean", default: false }, confirm: { type: "boolean", default: false },
  models: { type: "string" }, model: { type: "string" }, effort: { type: "string", default: "low" },
  "spend-cap-usd": { type: "string" }, output: { type: "string" }, "credential-file": { type: "string" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("Usage: node scripts/summary-retention-trial.mjs --dry-run [--models sol,luna] [--effort low] [--output new-report.json]\nPaid: --confirm --spend-cap-usd 12 --output NEW-report.json [--credential-file AUTH.json]. No retries/resume. Codex does NOT enforce the requested output ceiling.");
} else {
  let handle;
  try {
    if (values.model && values.models) throw Error("Choose --model or --models");
    const models = values.models ?? values.model ?? "sol";
    resolveTrialModels(models);
    const capUsd = Number(values["spend-cap-usd"]);
    if (!values["dry-run"] && (!values.confirm || !Number.isFinite(capUsd) || capUsd <= 0 || !values.output)) throw Error("Paid mode requires --confirm, positive --spend-cap-usd and a NEW --output");
    if (values["dry-run"] && values["credential-file"]) throw Error("Dry run does not accept credentials");
    if (values.output) { handle = await open(values.output, "wx", 0o600); await handle.close(); handle = null; }
    const publish = async report => {
      if (!values.output) return;
      const path = `${values.output}.tmp`;
      await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      const pending = await open(path, "r"); try { await pending.sync(); } finally { await pending.close(); }
      await rename(path, values.output);
      const directory = await open(dirname(values.output), "r"); try { await directory.sync(); } finally { await directory.close(); }
    };
    let complete;
    if (!values["dry-run"]) {
      // Load auth only after explicit admission. Refreshes stay in this process's
      // in-memory credential store; the trial never writes the supplied auth file.
      const pi = await import("../packages/turn/node_modules/@earendil-works/pi-ai/dist/index.js");
      const { builtinModels } = await import("../packages/turn/node_modules/@earendil-works/pi-ai/dist/providers/all.js");
      const credentials = new pi.InMemoryCredentialStore();
      if (values["credential-file"]) {
        const { createPiOAuthApiKeyResolver } = await import("@mono-agent/turn");
        const resolver = createPiOAuthApiKeyResolver({ path: values["credential-file"] });
        for (const reference of resolveTrialModels(models)) {
          const provider = reference.split(":")[0];
          const credential = await resolver.readCredential(provider);
          if (!credential) throw Error("Credential unavailable");
          await credentials.modify(provider, async () => credential);
        }
      }
      const collection = builtinModels({ credentials });
      complete = (model, context, options) => collection.completeSimple(model, context, options);
    }
    const report = await runTrial({ dryRun: values["dry-run"], confirm: values.confirm, capUsd, models, effort: values.effort, complete, publish });
    console.log(JSON.stringify({ status: report.status, identity: report.identity, models: report.models, total: report.total,
      maximumMatrixUsd: report.maximumMatrixUsd, spendingDisclosure: report.spendingDisclosure, qualificationLimit: report.qualificationLimit }, null, 2));
    if (report.status === "fail") process.exitCode = 1;
  } catch {
    // Provider exceptions may contain credentials; never echo them.
    console.error("Trial refused or stopped. Check arguments, builds and the output's last reservation/checkpoint. No retry was attempted.");
    process.exitCode = 1;
  } finally { await handle?.close(); }
}
