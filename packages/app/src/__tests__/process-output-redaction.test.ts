import { describe, expect, it } from "vitest";
import {
  redactProcessOutput, redactProcessOutputLine, redactStructuredProcessOutput,
  StreamingProcessOutputRedactor,
} from "../process-jobs/process-output-redaction.js";

const prose = "Use digest verification, token thresholds, basic setup, and a bearer of bad news. Digest verification also works.";

describe("HTTP credential boundaries", () => {
  it("preserves ordinary prose in whole-output, line, and streaming redactors", () => {
    expect(redactProcessOutput(prose, [])).toBe(prose);
    expect(redactProcessOutputLine(prose, [])).toBe(prose);
    const stream = new StreamingProcessOutputRedactor<number>([]);
    const lines = ["digest", "verification", "token", "thresholds", "basic", "setup", "bearer", "of bad news"];
    const output = lines.flatMap((line, index) => stream.push(line, index)).concat(stream.finalize());
    expect(output.map(({ text }) => text)).toEqual(lines);
  });

  it.each([
    'Authorization: Digest username="morgan", realm="example", nonce="fictional-nonce", response="fictional-response"',
    'authorization: digest username="morgan", realm="example", nonce="fictional-nonce", response="fictional-response"',
    'Digest username="morgan", realm="example", nonce="fictional-nonce", response="fictional-response"',
    'Authorization: Digest\n username="morgan", realm="example", nonce="fictional-nonce", response="fictional-response"',
    "Authorization: Bearer fictional-bearer",
    "authorization: bearer fictional-bearer",
    "Bearer fictional-bearer",
    "Basic bW9yZ2FuOnRlc3Q=",
    "Token fictional-token",
    "password=fictional-password",
    "literal fictional-known-secret",
  ])("redacts credentials: %s", (credential) => {
    for (const redact of [redactProcessOutput, redactProcessOutputLine]) {
      const result = redact(`${credential}; retained prose`, ["fictional-known-secret"]);
      expect(result).not.toMatch(/morgan|fictional-|bW9yZ2Fu/u);
      expect(result).toContain("retained prose");
    }
  });

  it.each(["Authorization: Bearer", "authorization: bearer", "Basic", "Token", "Authorization: Digest"])(
    "redacts cross-line credentials after %s without hiding following prose", (prefix) => {
      const stream = new StreamingProcessOutputRedactor<number>([]);
      const output = [prefix, "fictional-credential", prose].flatMap((line, index) => stream.push(line, index));
      expect(output[1]?.text).toBe("[REDACTED]");
      expect(output[2]?.text).toBe(prose);
    },
  );

  it("redacts Digest parameter continuation lines and resumes ordinary output", () => {
    const stream = new StreamingProcessOutputRedactor<number>([]);
    const lines = ['Authorization: Digest username="morgan",', ' realm="example",', ' nonce="fictional-nonce", response="fictional-response"', prose];
    const output = lines.flatMap((line, index) => stream.push(line, index)).concat(stream.finalize());
    expect(output.map(({ text }) => text).join("\n")).not.toMatch(/morgan|example|fictional-/u);
    expect(output.at(-1)?.text).toBe(prose);
  });
});

it("keeps a long single-line JSON answer complete and parseable across credential redaction", () => {
  const answer = `${"Planning notes. ".repeat(1_000)}${prose} Authorization: Digest username="morgan", realm="example", nonce="fictional-nonce", response="fictional-response"; final conclusion. ${"More findings. ".repeat(1_000)}`;
  const source = { resultReference: "[full result saved to: /artifacts/child-full.txt]", answer, artifacts: ["/artifacts/child-full.txt"], token: "fictional-token" };
  const redacted = redactStructuredProcessOutput(JSON.stringify(source), []);
  const parsed = JSON.parse(redacted);
  expect(parsed.answer).toContain(prose);
  expect(parsed.answer).toContain("final conclusion.");
  expect(parsed.answer.endsWith("More findings. ".repeat(1_000))).toBe(true);
  expect(parsed.answer).not.toMatch(/morgan|fictional-/u);
  expect(parsed.token).toBe("[REDACTED]");
  expect(parsed.artifacts).toEqual(source.artifacts);
  expect(parsed.resultReference).toBe(source.resultReference);
  // Even secrets that coincide with JSON syntax cannot corrupt serialization.
  expect(() => JSON.parse(redactStructuredProcessOutput(JSON.stringify(source), ['"', "}"]))).not.toThrow();
});

it("keeps trusted artifact locations resolvable without exempting answer text or real secrets", () => {
  const path = "/home/morgan/project/artifacts/full.txt";
  const source = { resultReference: `[full result saved to: ${path}]`, artifacts: [path], answer: "/home/morgan fictional-private-token" };
  const parsed = JSON.parse(redactStructuredProcessOutput(JSON.stringify(source), ["/home/morgan", "fictional-private-token"], false, ["fictional-private-token"]));
  expect(parsed.artifacts).toEqual([path]);
  expect(parsed.resultReference).toContain(path);
  expect(parsed.answer).not.toContain("/home/morgan");
  expect(parsed.answer).not.toContain("fictional-private-token");
  const credentialPath = { artifacts: ["/artifacts/fictional-private-token/full.txt"] };
  expect(redactStructuredProcessOutput(JSON.stringify(credentialPath), ["fictional-private-token"], false, ["fictional-private-token"])).not.toContain("fictional-private-token");
});
