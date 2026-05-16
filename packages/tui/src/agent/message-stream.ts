import type { AgentMessageStreamLike } from "./responder.js";

/**
 * State snapshot produced by TuiInkMessageStream after every flush.
 * The Chat pane re-renders the in-flight assistant block from this.
 */
export interface TuiStreamState {
  readonly statusText: string;
  readonly text: string;
  readonly finished: boolean;
  readonly hasOutput: boolean;
}

export interface TuiInkMessageStreamOptions {
  readonly initialStatusText?: string;
  readonly streamDebounceMs?: number;
  readonly onState: (state: TuiStreamState) => void;
  readonly now?: () => number;
  readonly setTimer?: (handler: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";
const DEFAULT_DEBOUNCE_MS = 30;

/**
 * AgentMessageStreamLike implementation that buffers incoming deltas and
 * emits a single state snapshot per debounce window. This keeps the React
 * reconciler from churning when a responder calls `append` in a tight
 * loop (typical of token-by-token streaming).
 */
export class TuiInkMessageStream implements AgentMessageStreamLike {
  private readonly emit: (state: TuiStreamState) => void;
  private readonly debounceMs: number;
  private readonly setTimerImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimerImpl: (handle: unknown) => void;

  private statusText: string;
  private currentText = "";
  private finished = false;
  private hasOutput = false;
  private pendingTimer: unknown;
  private dirty = false;

  constructor(options: TuiInkMessageStreamOptions) {
    this.emit = options.onState;
    this.debounceMs = options.streamDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new RangeError("streamDebounceMs must be a non-negative number.");
    }
    this.statusText = options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT;
    this.setTimerImpl =
      options.setTimer ??
      ((handler, ms) => setTimeout(handler, ms) as unknown);
    this.clearTimerImpl =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    this.statusText = text;
    this.scheduleEmit();
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    if (delta.length === 0) {
      return;
    }
    this.currentText += delta;
    this.hasOutput = true;
    this.scheduleEmit();
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
    this.hasOutput = text.length > 0;
    this.scheduleEmit();
  }

  async finish(finalText?: string): Promise<void> {
    this.assertOpen();
    if (finalText !== undefined) {
      this.currentText = finalText;
      this.hasOutput = finalText.length > 0;
    }
    this.finished = true;
    this.flushNow();
  }

  /**
   * Flushes any pending state immediately. Useful when the host wants to
   * cancel mid-stream and render the partial result before unmounting.
   */
  flushPending(): void {
    if (this.dirty || this.pendingTimer !== undefined) {
      this.flushNow();
    }
  }

  snapshot(): TuiStreamState {
    return {
      statusText: this.statusText,
      text: this.currentText,
      finished: this.finished,
      hasOutput: this.hasOutput,
    };
  }

  private scheduleEmit(): void {
    this.dirty = true;
    if (this.debounceMs === 0) {
      this.flushNow();
      return;
    }
    if (this.pendingTimer !== undefined) {
      return;
    }
    this.pendingTimer = this.setTimerImpl(() => {
      this.pendingTimer = undefined;
      this.flushNow();
    }, this.debounceMs);
  }

  private flushNow(): void {
    if (this.pendingTimer !== undefined) {
      this.clearTimerImpl(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.dirty = false;
    this.emit(this.snapshot());
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("TuiInkMessageStream has already been finished.");
    }
  }
}
