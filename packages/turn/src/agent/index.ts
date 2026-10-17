// Public agent-kernel barrel for runtime hosts. Everything below is
// intentionally re-exported through `@mono-agent/turn/agent`;
// agent modules not exposed by the package's exports map remain private
// implementation details.

export {
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "./compaction.js";

export { formatSkillBodyWithPathNote } from "./prompt/skill-index.js";
export { buildTranscriptTailSnapshot, renderResumeSnapshot } from "./transcript.js";

/** @typedef {import("./compaction.js").AgentCompactionPolicy} AgentCompactionPolicy */

export type { AgentCompactionPolicy } from "./compaction.js";
