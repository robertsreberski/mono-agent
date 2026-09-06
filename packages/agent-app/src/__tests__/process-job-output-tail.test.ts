import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessJobOutputTail } from "../process-job-output-tail.js";
import { StreamingProcessOutputRedactor } from "../process-output-redaction.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StreamingProcessOutputRedactor", () => {
  it("withholds and redacts known literals split across physical lines", () => {
    const redactor = new StreamingProcessOutputRedactor<number>(["alpha-bravo"]);
    expect(redactor.push("before alpha-", 1)).toEqual([]);
    expect(redactor.push("bravo after", 2)).toEqual([
      { text: "[REDACTED]", value: 1 },
      { text: "[REDACTED]", value: 2 },
    ]);
  });

  it("keeps PEM bodies redacted through the matching footer", () => {
    const redactor = new StreamingProcessOutputRedactor<number>([]);
    const privateKeyHeader = ["-----BEGIN", " PRIVATE KEY-----"].join("");
    const privateKeyFooter = ["-----END", " PRIVATE KEY-----"].join("");
    expect(redactor.push(privateKeyHeader, 1)).toEqual([
      { text: "[REDACTED]", value: 1 },
    ]);
    expect(redactor.push("short body", 2)).toEqual([{ text: "[REDACTED]", value: 2 }]);
    expect(redactor.push(privateKeyFooter, 3)).toEqual([
      { text: "[REDACTED]", value: 3 },
    ]);
    expect(redactor.push("safe", 4)).toEqual([{ text: "safe", value: 4 }]);
  });

  it("releases an incomplete literal only when clean settlement proves it cannot grow", () => {
    const settled = new StreamingProcessOutputRedactor<number>(["split-secret"]);
    expect(settled.push("safe split-", 1)).toEqual([]);
    expect(settled.finalize(false)).toEqual([{ text: "safe split-", value: 1 }]);

    const truncated = new StreamingProcessOutputRedactor<number>(["split-secret"]);
    expect(truncated.push("safe split-", 1)).toEqual([]);
    expect(truncated.finalize()).toEqual([{ text: "[REDACTED]", value: 1 }]);
  });

  it.each([
    "token=",
    "deploy --password",
    "Authorization: Bearer",
  ])("redacts a credential value continued after %s", (prefix) => {
    const redactor = new StreamingProcessOutputRedactor<number>([]);
    const prefixOutput = redactor.push(prefix, 1);
    expect(prefixOutput).toHaveLength(1);
    expect(redactor.pendingCount).toBe(0);
    expect(redactor.push("not-in-env", 2)).toEqual([
      { text: "[REDACTED]", value: 2 },
    ]);
    expect(redactor.push("safe", 3)).toEqual([{ text: "safe", value: 3 }]);
  });

  it("redacts every non-empty line in a quoted credential continuation", () => {
    const redactor = new StreamingProcessOutputRedactor<number>([]);
    expect(redactor.push('client_secret="', 1)).toEqual([
      { text: "client_secret=[REDACTED]", value: 1 },
    ]);
    expect(redactor.push("not-in-env", 2)).toEqual([
      { text: "[REDACTED]", value: 2 },
    ]);
    expect(redactor.push("still-sensitive\"", 3)).toEqual([
      { text: "[REDACTED]", value: 3 },
    ]);
    expect(redactor.push("safe", 4)).toEqual([{ text: "safe", value: 4 }]);
  });
});

describe("ProcessJobOutputTail", () => {
  it("publishes an interleaved stdout/stderr tail on the bounded throttle", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [],
      publishIntervalMs: 250,
    });

    tail.writeStdout(Buffer.from("one\n"));
    tail.writeStderr(Buffer.from("two\n"));
    tail.writeStdout(Buffer.from("three\n"));
    expect(tail.snapshot()).toMatchObject({ preview: "", stdoutBytes: 0, stderrBytes: 0 });
    vi.advanceTimersByTime(249);
    expect(tail.snapshot()?.preview).toBe("");
    vi.advanceTimersByTime(1);
    expect(tail.snapshot()).toEqual({
      stdoutBytes: 10,
      stderrBytes: 4,
      truncated: false,
      preview: "STDOUT:\none\nSTDERR:\ntwo\nSTDOUT:\nthree",
    });
  });

  it("preserves first-fragment order when another stream completes first", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [],
      publishIntervalMs: 250,
    });

    tail.writeStdout(Buffer.from("first"));
    tail.writeStderr(Buffer.from("second\n"));
    tail.writeStdout(Buffer.from(" completes\nthird\n"));
    vi.advanceTimersByTime(250);

    expect(tail.snapshot()?.preview).toBe(
      "STDOUT:\nfirst completes\nSTDERR:\nsecond\nSTDOUT:\nthird",
    );
  });

  it("never publishes a credential value split from its label", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [],
      publishIntervalMs: 250,
    });

    tail.writeStdout(Buffer.from("token=\n"));
    tail.writeStdout(Buffer.from("not-in-env\n"));
    vi.advanceTimersByTime(250);

    expect(tail.snapshot()?.preview).toBe("STDOUT:\ntoken=\n[REDACTED]");
    expect(tail.snapshot()?.preview).not.toContain("not-in-env");
  });

  it("redacts a cross-line flag value when finalizing an unterminated line", () => {
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [],
    });

    tail.writeStderr(Buffer.from("deploy --password=\nnot-in-env"));
    const final = tail.finalize();

    expect(final?.preview).toBe("STDERR:\ndeploy --password=\n[REDACTED]");
    expect(final?.preview).not.toContain("not-in-env");
  });

  it("never publishes known secrets split across chunks, lines, or UTF-8 boundaries", () => {
    vi.useFakeTimers();
    const secret = "sécret-value";
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [secret],
      publishIntervalMs: 25,
    });
    const bytes = Buffer.from(`visible ${secret}\n`, "utf8");
    const split = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
    tail.writeStdout(bytes.subarray(0, split));
    vi.advanceTimersByTime(25);
    expect(tail.snapshot()?.preview).not.toContain("visible s");

    tail.writeStdout(bytes.subarray(split, bytes.length - 6));
    vi.advanceTimersByTime(25);
    expect(tail.snapshot()?.preview).not.toContain("sécret");
    tail.writeStdout(bytes.subarray(bytes.length - 6));
    vi.advanceTimersByTime(25);
    const preview = tail.snapshot()?.preview ?? "";
    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain(secret);
  });

  it("withholds even a one-character known-secret prefix across physical lines", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: ["xyz-secret"],
    });
    tail.writeStdout(Buffer.from("x\n"));
    vi.advanceTimersByTime(250);
    expect(tail.snapshot()?.preview).toBe("STDOUT:\n[REDACTED]");
    tail.writeStdout(Buffer.from("yz-secret\n"));
    vi.advanceTimersByTime(250);
    const preview = tail.snapshot()?.preview ?? "";
    expect(preview).not.toContain("xyz-secret");
    expect(preview.match(/\[REDACTED\]/gu)).toHaveLength(2);
  });

  it("keeps only the newest logical lines and marks an omitted prefix", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 8_000,
      maxOutputBytes: 100_000,
      maxLines: 100,
      secrets: [],
    });
    tail.writeStdout(Buffer.from(`${Array.from({ length: 105 }, (_, index) => `line-${String(index + 1)}`).join("\n")}\n`));
    vi.advanceTimersByTime(250);
    const preview = tail.snapshot()?.preview ?? "";
    expect(preview).toContain("… [earlier output omitted]");
    expect(preview).not.toContain("line-5\n");
    expect(preview).toContain("line-6\n");
    expect(preview).toContain("line-105");
  });

  it("enforces the shared byte budget without splitting a surrogate in the character tail", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 20,
      maxOutputBytes: 10,
      secrets: [],
    });
    tail.writeStdout(Buffer.from("😀😀abcdefghi", "utf8"));
    vi.advanceTimersByTime(250);
    const snapshot = tail.snapshot()!;
    expect(snapshot.stdoutBytes).toBe(10);
    expect(snapshot.stderrBytes).toBe(0);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.preview.length).toBeLessThanOrEqual(20);
    expect(snapshot.preview).not.toMatch(/^[\uDC00-\uDFFF]/u);
  });

  it("flushes a safe partial line immediately at finalization", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: ["unfinished-secret"],
    });
    tail.writeStderr(Buffer.from("token=unfinished-sec"));
    const final = tail.finalize();
    expect(final?.preview).toBe("STDERR:\ntoken=[REDACTED]");
    vi.advanceTimersByTime(1_000);
    expect(tail.snapshot()).toEqual(final);
  });

  it("withholds an unterminated credential shape until it can be redacted safely", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [],
    });
    tail.writeStdout(Buffer.from("sk-proj-1234567890"));
    vi.advanceTimersByTime(250);
    expect(tail.snapshot()?.preview).toBe("");
    tail.writeStdout(Buffer.from("abcdef\n"));
    vi.advanceTimersByTime(250);
    expect(tail.snapshot()?.preview).toBe("STDOUT:\n[REDACTED]");
  });

  it("redacts a recognizable credential shape split across physical lines", () => {
    vi.useFakeTimers();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [],
    });
    tail.writeStderr(Buffer.from("sk-proj-12345678\n"));
    vi.advanceTimersByTime(250);
    expect(tail.snapshot()?.preview).toBe("STDERR:\n[REDACTED]");
    tail.writeStderr(Buffer.from("90abcdef\n"));
    vi.advanceTimersByTime(250);
    expect(tail.snapshot()?.preview).toBe("STDERR:\n[REDACTED]\n[REDACTED]");
  });

  it("fails closed and warns once when accumulator work throws", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const tail = new ProcessJobOutputTail({
      previewChars: 2_000,
      maxOutputBytes: 1_024,
      secrets: [],
      onFailure: warn,
    });
    const decoder = (tail as any).streams.stdout.decoder;
    vi.spyOn(decoder, "write").mockImplementation(() => { throw new Error("raw private text"); });
    tail.writeStdout(Buffer.from("do not publish"));
    tail.writeStdout(Buffer.from("still private"));
    expect(tail.snapshot()).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([[]]);
  });
});
