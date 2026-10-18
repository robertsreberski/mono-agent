import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkCommittedWhitespace, whitespaceBase } from "../check-committed-whitespace.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const sha = "a".repeat(40);
const eventEnv = (name) => ({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: "event.json" });
const eventReader = (event) => () => JSON.stringify(event);

function fixture() {
  const parent = resolve(root, ".worklab-tmp");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(resolve(parent, "committed-whitespace-"));
  directories.push(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  writeFileSync(resolve(cwd, "fixture.txt"), "initial\n");
  git("add", "fixture.txt");
  git("commit", "-m", "Initial fixture");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  const commit = (text) => {
    writeFileSync(resolve(cwd, "fixture.txt"), text);
    git("add", "fixture.txt");
    git("commit", "-m", "Change fixture");
  };
  return { cwd, git, base, commit };
}

function check(f, env = {}) {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  return checkCommittedWhitespace({ cwd: f.cwd, env });
}

describe("committed whitespace base policy", () => {
  it("uses the pull_request base SHA, not an override or the PR head", () => {
    expect(whitespaceBase({ ...eventEnv("pull_request"), WHITESPACE_BASE_REF: "HEAD" }, eventReader({ pull_request: { base: { sha }, head: { sha: "b".repeat(40) } } }))).toBe(sha);
  });

  it("uses event.before for a push to main", () => {
    expect(whitespaceBase(eventEnv("push"), eventReader({ ref: "refs/heads/main", before: sha, after: "b".repeat(40) }))).toBe(sha);
  });

  it.each(["workflow_dispatch", "pull_request_target", "schedule", undefined])("rejects unsupported or missing event %s", (name) => {
    expect(() => whitespaceBase(eventEnv(name), eventReader({}))).toThrow(/Unsupported committed-whitespace event/);
  });

  it("rejects a push to another ref", () => {
    expect(() => whitespaceBase(eventEnv("push"), eventReader({ ref: "refs/heads/feature", before: sha }))).toThrow(/only supports refs\/heads\/main/);
  });

  it.each(["pull_request", "push"])("rejects missing, zero or malformed %s bases", (name) => {
    for (const base of [undefined, "0".repeat(40), "HEAD", "-bad", ""]) {
      const event = { ref: "refs/heads/main", before: base, pull_request: { base: { sha: base } } };
      expect(() => whitespaceBase(eventEnv(name), eventReader(event))).toThrow(/nonzero commit SHA/);
    }
  });

  it("refuses missing or unreadable event data without falling back to local mode", () => {
    expect(() => whitespaceBase({ GITHUB_EVENT_NAME: "pull_request" })).toThrow(/requires GITHUB_EVENT_PATH/);
    expect(() => whitespaceBase(eventEnv("push"), () => "not JSON")).toThrow(/Cannot read/);
    expect(() => whitespaceBase(eventEnv("push"), () => { throw new Error("missing"); })).toThrow(/Cannot read/);
  });

  it("defaults locally to origin/main and supports a nonempty explicit base", () => {
    expect(whitespaceBase({})).toBe("origin/main");
    expect(whitespaceBase({ WHITESPACE_BASE_REF: "fixture-base" })).toBe("fixture-base");
    for (const base of ["", " ", "0".repeat(40)]) expect(() => whitespaceBase({ WHITESPACE_BASE_REF: base })).toThrow(/nonempty, nonzero/);
  });
});

describe("committed whitespace Git range", () => {
  it("detects committed whitespace even when the working tree is clean", () => {
    const f = fixture();
    f.commit("initial\nadded trailing space \n");
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.git("diff", "--check")).toBe("");
    expect(check(f)).not.toBe(0);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("trailing whitespace"));
  });

  it.each(["pull_request", "push"])("checks the actual %s event range through the executable", (name) => {
    const f = fixture();
    f.commit("initial\nadded trailing space \n");
    const path = resolve(f.cwd, "event.json");
    writeFileSync(path, JSON.stringify({ ref: "refs/heads/main", before: f.base, pull_request: { base: { sha: f.base } } }));
    const result = spawnSync(process.execPath, [resolve(root, "scripts/check-committed-whitespace.mjs")], {
      cwd: f.cwd, encoding: "utf8", env: { ...process.env, ...eventEnv(name), GITHUB_EVENT_PATH: path, WHITESPACE_BASE_REF: "HEAD" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("trailing whitespace");
    expect(result.stdout).toContain(`${f.base}..HEAD`);
  });

  it.each(["pull_request", "push"])("rejects an unreachable %s event base", (name) => {
    const f = fixture();
    const path = resolve(f.cwd, "event.json");
    writeFileSync(path, JSON.stringify({ ref: "refs/heads/main", before: sha, pull_request: { base: { sha } } }));
    expect(() => check(f, { ...eventEnv(name), GITHUB_EVENT_PATH: path })).toThrow(/base is unreachable/);
  });

  it("checks only the committed range in CI even with an unstaged error", () => {
    const f = fixture();
    f.commit("initial\nclean addition\n");
    writeFileSync(resolve(f.cwd, "fixture.txt"), "unstaged trailing space \n");
    const event = resolve(f.cwd, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: f.base } } }));
    expect(check(f, { ...eventEnv("pull_request"), GITHUB_EVENT_PATH: event })).toBe(0);
  });

  it("detects local unstaged whitespace against the merge base", () => {
    const f = fixture();
    f.commit("initial\nclean addition\n");
    writeFileSync(resolve(f.cwd, "fixture.txt"), "unstaged trailing space \n");
    expect(check(f)).not.toBe(0);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("trailing whitespace"));
  });

  it("uses the divergence merge-base rather than HEAD's parent", () => {
    const f = fixture();
    f.git("checkout", "-b", "candidate");
    f.commit("initial\ncommitted trailing space \n");
    f.git("commit", "--allow-empty", "-m", "Later fixture");
    f.git("checkout", "main");
    writeFileSync(resolve(f.cwd, "other.txt"), "base advance\n");
    f.git("add", "other.txt");
    f.git("commit", "-m", "Advance base");
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    f.git("checkout", "candidate");
    expect(check(f)).not.toBe(0);
    expect(console.log).toHaveBeenCalledWith(`Whitespace: ${f.base} (working tree)`);
  });

  it("fails on unreachable or unrelated history rather than using HEAD", () => {
    const f = fixture();
    expect(() => check(f, { WHITESPACE_BASE_REF: sha })).toThrow(/base is unreachable/);
    f.git("checkout", "--orphan", "unrelated");
    f.git("commit", "-m", "Unrelated fixture");
    expect(() => check(f, { WHITESPACE_BASE_REF: f.base })).toThrow(/No committed-whitespace merge-base/);
  });

  it("does not swallow Git startup or diff failures", () => {
    const f = fixture();
    const execute = vi.fn(() => ({ status: 0, stdout: sha, stderr: "" }));
    execute.mockReturnValueOnce({ error: new Error("cannot start git") });
    expect(() => checkCommittedWhitespace({ cwd: f.cwd, env: {}, execute })).toThrow(/cannot start git/);
    execute.mockReturnValueOnce({ status: 0, stdout: sha }).mockReturnValueOnce({ status: 0, stdout: sha }).mockReturnValueOnce({ status: 128, stdout: "", stderr: "bad diff" });
    expect(() => checkCommittedWhitespace({ cwd: f.cwd, env: {}, execute })).toThrow(/diff failed.*bad diff/);
  });
});
