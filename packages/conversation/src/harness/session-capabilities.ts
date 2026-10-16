/** Turn-scoped capabilities the block explains, each gated by the host. */
export interface SessionContextCapabilities {
  /** Host-verified local peer source; never read directly from request metadata. */
  readonly peerCaller?: string;
  readonly backgroundSubagents?: boolean;
  readonly subagentInstances?: readonly { id: string; name: string; route?: string; status: string; turns: number; ageMs: number; jobId?: string; recoveryBlocked?: boolean; pendingQuestion?: { question: string; options?: string[] } }[];
  /** The host persists memory itself; the model must not edit its state. */
  readonly hostManagedMemory?: boolean;
  /** Inject only when host-disabled automatic capture meets an enabled Remember tool. */
  readonly manualMemoryCapture?: boolean;
  /** The provisioned Remember tool supports BuJo detail arguments. */
  readonly rememberDetails?: boolean;
  /**
   * `Exec`/`Bash` carry the `background` field on this turn. Must come from the
   * same predicate that injects the schema — guidance for a capability the
   * model cannot see is worse than none.
   */
  readonly backgroundProcessJobs?: boolean;
}

