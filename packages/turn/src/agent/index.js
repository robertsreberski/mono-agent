// Public agent-kernel barrel for runtime hosts. Everything below is
// intentionally re-exported through `@mono-agent/turn/agent`;
// agent modules not exposed by the package's exports map remain private
// implementation details.

export {
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "./compaction.js";
