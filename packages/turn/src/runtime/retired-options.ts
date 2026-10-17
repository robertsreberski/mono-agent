// Repository-owned fixed text is safe to surface across resolver boundaries.
export class RetiredRunOptionError extends TypeError {
  constructor() {
    super("piToolParallelismMode was renamed to piToolExecutionMode; use sequential instead of one-at-a-time, or safe-parallel instead of all");
    this.name = "RetiredRunOptionError";
  }
}

// Direct turn callers cannot depend on config's host-level diagnostics.
/** @param {object} options */
export function assertNoRetiredRunOptions(options: any): void {
  if (Object.hasOwn(options, "piToolParallelismMode")) {
    throw new RetiredRunOptionError();
  }
}
