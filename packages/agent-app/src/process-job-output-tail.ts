import { StringDecoder } from "node:string_decoder";

import { StreamingProcessOutputRedactor } from "./process-output-redaction.js";

const EARLIER_OUTPUT_OMITTED = "… [earlier output omitted]";

type ProcessOutputStream = "stdout" | "stderr";

interface TailLine {
  readonly sequence: number;
  readonly stream: ProcessOutputStream;
  readonly text: string;
}

interface StreamState {
  readonly decoder: StringDecoder;
  carry: string;
  partialSequence: number;
}

export interface ProcessJobOutputTailSnapshot {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly preview: string;
}

export interface ProcessJobOutputTailOptions {
  readonly previewChars: number;
  readonly maxOutputBytes: number;
  readonly secrets: readonly string[];
  readonly maxLines?: number;
  readonly publishIntervalMs?: number;
  /** One generic notification for an internal accumulator failure; never receives process output. */
  readonly onFailure?: () => void;
}

/**
 * Memory-only, redacted tail for one active process job.
 *
 * This mirrors the runner's shared stdout/stderr byte admission without
 * controlling it. Published state is throttled; finalization is immediate.
 */
export class ProcessJobOutputTail {
  private readonly maxLines: number;
  private readonly publishIntervalMs: number;
  private readonly redactors: Record<ProcessOutputStream, StreamingProcessOutputRedactor<TailLine>>;
  private readonly streams: Record<ProcessOutputStream, StreamState> = {
    stdout: { decoder: new StringDecoder("utf8"), carry: "", partialSequence: 0 },
    stderr: { decoder: new StringDecoder("utf8"), carry: "", partialSequence: 0 },
  };
  private readonly lines: TailLine[] = [];
  private sequence = 0;
  private omittedLines = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private truncated = false;
  private failed = false;
  private finished = false;
  private warned = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private published: ProcessJobOutputTailSnapshot = {
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    preview: "",
  };

  constructor(private readonly options: ProcessJobOutputTailOptions) {
    this.maxLines = Math.max(1, Math.floor(options.maxLines ?? 100));
    this.publishIntervalMs = Math.max(0, Math.floor(options.publishIntervalMs ?? 250));
    this.redactors = {
      stdout: new StreamingProcessOutputRedactor(options.secrets, 1, true),
      stderr: new StreamingProcessOutputRedactor(options.secrets, 1, true),
    };
  }

  writeStdout(chunk: Buffer): void {
    this.write("stdout", chunk);
  }

  writeStderr(chunk: Buffer): void {
    this.write("stderr", chunk);
  }

  snapshot(): ProcessJobOutputTailSnapshot | undefined {
    return this.failed ? undefined : this.published;
  }

  finalize(): ProcessJobOutputTailSnapshot | undefined {
    if (this.finished) return this.failed ? undefined : this.published;
    this.finished = true;
    this.clearTimer();
    if (this.failed) return undefined;
    try {
      const partials: TailLine[] = [];
      for (const stream of ["stdout", "stderr"] as const) {
        const state = this.streams[stream];
        state.carry += state.decoder.end();
        if (state.carry.length > 0) {
          partials.push({
            sequence: state.partialSequence || ++this.sequence,
            stream,
            text: state.carry,
          });
          state.carry = "";
        }
      }
      const ready: Array<{ readonly text: string; readonly value: TailLine }> = [];
      for (const line of partials.sort(bySequence)) {
        ready.push(...this.redactors[line.stream].push(line.text, line, this.truncated));
      }
      ready.push(
        ...this.redactors.stdout.finalize(this.truncated),
        ...this.redactors.stderr.finalize(this.truncated),
      );
      this.appendReady(ready);
      this.published = this.render();
      return this.published;
    } catch {
      this.failClosed();
      return undefined;
    }
  }

  discard(): void {
    this.finished = true;
    this.clearTimer();
    this.lines.length = 0;
    this.streams.stdout.carry = "";
    this.streams.stderr.carry = "";
    this.redactors.stdout.clear();
    this.redactors.stderr.clear();
  }

  private write(stream: ProcessOutputStream, chunk: Buffer): void {
    if (this.finished || this.failed) return;
    try {
      const remaining = Math.max(
        0,
        this.options.maxOutputBytes - this.stdoutBytes - this.stderrBytes,
      );
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (stream === "stdout") this.stdoutBytes += accepted.length;
      else this.stderrBytes += accepted.length;
      if (chunk.length > remaining) this.truncated = true;
      if (accepted.length > 0) this.acceptDecoded(stream, this.streams[stream].decoder.write(accepted));
      this.armPublication();
    } catch {
      this.failClosed();
    }
  }

  private acceptDecoded(stream: ProcessOutputStream, decoded: string): void {
    const state = this.streams[stream];
    state.carry += decoded;
    let newline = state.carry.indexOf("\n");
    while (newline >= 0) {
      const text = state.carry.slice(0, newline).replace(/\r$/u, "");
      state.carry = state.carry.slice(newline + 1);
      const line: TailLine = { sequence: ++this.sequence, stream, text };
      this.appendReady(this.redactors[stream].push(text, line));
      newline = state.carry.indexOf("\n");
    }
    if (state.carry.length > 0) state.partialSequence = ++this.sequence;
  }

  private appendReady(entries: readonly { readonly text: string; readonly value: TailLine }[]): void {
    for (const entry of entries) {
      this.lines.push({ ...entry.value, text: entry.text });
    }
    this.lines.sort(bySequence);
    while (this.lines.length > this.maxLines) {
      this.lines.shift();
      this.omittedLines += 1;
    }
  }

  private armPublication(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.finished || this.failed) return;
      try {
        this.published = this.render();
      } catch {
        this.failClosed();
      }
    }, this.publishIntervalMs);
    this.timer.unref?.();
  }

  private render(): ProcessJobOutputTailSnapshot {
    const view = [...this.lines];
    // Unterminated lines remain private until settlement: credential-shaped
    // values do not have enough context for safe incremental publication. A
    // clone may still safely finalize completed lines withheld as secret suffixes.
    for (const stream of ["stdout", "stderr"] as const) {
      const redactor = this.redactors[stream].clone();
      for (const entry of redactor.finalize()) {
        view.push({ ...entry.value, text: entry.text });
      }
    }
    view.sort(bySequence);
    const overflow = Math.max(0, view.length - this.maxLines);
    const bounded = overflow === 0 ? view : view.slice(-this.maxLines);
    return {
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      truncated: this.truncated,
      preview: renderPreview(
        bounded,
        this.options.previewChars,
        this.omittedLines > 0 || overflow > 0,
      ),
    };
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private failClosed(): void {
    this.failed = true;
    this.clearTimer();
    this.lines.length = 0;
    this.streams.stdout.carry = "";
    this.streams.stderr.carry = "";
    this.redactors.stdout.clear();
    this.redactors.stderr.clear();
    this.published = { stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "" };
    if (!this.warned) {
      this.warned = true;
      try { this.options.onFailure?.(); } catch { /* output observers remain non-throwing */ }
    }
  }
}

const bySequence = (left: TailLine, right: TailLine): number => left.sequence - right.sequence;

function renderPreview(
  input: readonly TailLine[],
  maxChars: number,
  hadOmission: boolean,
): string {
  if (input.length === 0) return "";
  let lines = [...input];
  let omitted = hadOmission;
  let rendered = formatLines(lines, omitted);
  while (rendered.length > maxChars && lines.length > 1) {
    lines = lines.slice(1);
    omitted = true;
    rendered = formatLines(lines, omitted);
  }
  if (rendered.length <= maxChars) return rendered;

  const last = lines.at(-1)!;
  const prefix = `${omitted ? `${EARLIER_OUTPUT_OMITTED}\n` : ""}${streamHeading(last.stream)}\n`;
  if (prefix.length >= maxChars) return prefix.slice(0, maxChars);
  return `${prefix}${safeTailSlice(last.text, maxChars - prefix.length)}`;
}

function formatLines(lines: readonly TailLine[], omitted: boolean): string {
  const parts: string[] = [];
  if (omitted) parts.push(EARLIER_OUTPUT_OMITTED);
  let stream: ProcessOutputStream | undefined;
  for (const line of lines) {
    if (line.stream !== stream) {
      stream = line.stream;
      parts.push(streamHeading(stream));
    }
    parts.push(line.text);
  }
  return parts.join("\n");
}

function streamHeading(stream: ProcessOutputStream): string {
  return stream === "stdout" ? "STDOUT:" : "STDERR:";
}

function safeTailSlice(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let sliced = value.slice(-Math.max(0, maxChars));
  if (/^[\uDC00-\uDFFF]/u.test(sliced)) sliced = sliced.slice(1);
  return sliced;
}
