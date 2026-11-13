import { effectiveSandboxReport, inspectEffectiveSandboxBoundary } from "../service/sandbox/effective-sandbox.js";
import type { MonoAgentConfig } from "@mono-agent/config";
import { sandboxEffectiveStateWarning } from "@mono-agent/turn/host/sandbox";
import type { ValidationSection } from "./doctor-types.js";
import type { ValidateMonoAgentFolderOptions } from "./options.js";

export async function sandboxSection(config: MonoAgentConfig, input: ValidateMonoAgentFolderOptions): Promise<ValidationSection> {
  try {
    const boundary = await inspectEffectiveSandboxBoundary(config, input);
    if (input.subprocessProbes === false && !boundary.blocked && boundary.policy?.mode === "native") {
      return { id: "sandbox", label: "Sandbox", status: "waiting", details: [
        "Native sandbox availability/enforcement is not probed here. Run mono-agent validate in the owner terminal.",
        ...(boundary.processJobsRequired ? ["ProcessJobs requires native protection; its effectiveness is not assumed by this inspection."] : []),
      ] };
    }
    const { state, detail } = await effectiveSandboxReport(config, boundary, input.sandboxEngine);
    const warning = sandboxEffectiveStateWarning(state);
    return { id: "sandbox", label: "Sandbox",
      status: warning !== undefined || state.effective === "blocked" ? "waiting"
        : state.effective === "off" ? "disabled" : "ok",
      details: [
        ...(config.sandbox === undefined ? [] : [
          `Mode: ${config.sandbox.mode}, network: ${config.sandbox.network.mode}, fallback: ${config.sandbox.fallback}.`,
        ]),
        detail, ...(warning === undefined ? [] : [warning]),
      ],
    };
  } catch {
    return { id: "sandbox", label: "Sandbox", status: "waiting",
      details: ["Sandbox boundary is unavailable; subprocess execution is blocked until private-state protection can be resolved."],
    };
  }
}
