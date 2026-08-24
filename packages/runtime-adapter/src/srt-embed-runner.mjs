#!/usr/bin/env node
/**
 * Embed launcher for SRT's unrestricted-network mode.
 *
 * The pinned SRT CLI requires a `network` block in its settings schema and
 * always starts domain filtering when one is present, so "filesystem
 * enforcement with open networking" is only reachable through the library
 * API: initializing with an empty network object keeps every filesystem rule
 * while SRT skips its proxy and domain filter entirely (its restriction
 * trigger is a defined `network.allowedDomains`). This runner is spawned with
 * the same verified Node executable as the CLI launch and imports the library
 * entry from the identity-checked SRT tree it is given.
 *
 * Invocation: srt-embed-runner.mjs <srt-index.js> --settings <settings.json> -- <command> [args...]
 *
 * The spawn/exit contract mirrors the SRT CLI: the wrapped command string is
 * run through the shell, SIGINT/SIGTERM/SIGHUP forward to the child, bwrap
 * mount artifacts are cleaned up after the command, and the child's exit code
 * is this process's exit code. Forwarding escalates to SIGKILL after a short
 * grace — see CHILD_KILL_GRACE_MS.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function fail(message, code = 78) {
  console.error(`srt-embed-runner: ${message}`);
  process.exit(code);
}

if (process.platform === "win32") {
  fail("the embed launch supports POSIX platforms only");
}

const argv = process.argv.slice(2);
const entryPath = argv[0];
if (entryPath === undefined || argv[1] !== "--settings" || argv[2] === undefined || argv[3] !== "--") {
  fail("usage: srt-embed-runner <srt-index.js> --settings <settings.json> -- <command> [args...]");
}
const settingsPath = argv[2];
const command = argv.slice(4);
if (command.length === 0) {
  fail("no command specified");
}

let settings;
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch (error) {
  fail(`settings file is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (settings === null || typeof settings !== "object" || typeof settings.filesystem !== "object" || settings.filesystem === null) {
  fail("settings must carry a filesystem policy");
}
if (settings.network !== undefined) {
  fail("settings with a network block belong to the SRT CLI launch; refusing to run them without domain filtering");
}

let SandboxManager;
try {
  ({ SandboxManager } = await import(pathToFileURL(entryPath).href));
} catch (error) {
  fail(`SRT library entry could not be imported: ${error instanceof Error ? error.message : String(error)}`);
}
if (SandboxManager === undefined) {
  fail("SRT library entry does not export SandboxManager");
}

try {
  await SandboxManager.initialize({ network: {}, filesystem: settings.filesystem });
} catch (error) {
  fail(`SRT initialization failed: ${error instanceof Error ? error.message : String(error)}`);
}

// argv entries may contain any bytes; single-quote each one so the shell
// re-parse inside SRT's `bash -c` wrapper preserves them verbatim.
const quoted = command.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
let wrapped = await SandboxManager.wrapWithSandbox(quoted);

// macOS system DNS is a local service, not plain sockets: getaddrinfo talks
// to mDNSResponder over an AF_UNIX socket reached through the /var symlink,
// and resolver-config readers open /etc/resolv.conf through the /etc and
// /var symlinks. The unrestricted-network profile allows `network*` but none
// of that, so name resolution fails with ENOTFOUND while raw IP egress
// works. Reopen exactly those paths — the resolv.conf file targets travel in
// the settings' allowRead (SRT's read section; profile-level file allows are
// overridden by its later deny-read block). The pinned SRT version emits the
// literal `(allow network*)` marker in this mode; if it is absent the
// profile is not the one this augmentation was reviewed against, so refuse
// to run rather than start a sandbox whose network posture silently differs
// from the declared policy.
if (process.platform === "darwin") {
  const marker = "(allow network*)";
  if (!wrapped.includes(marker)) {
    fail("SRT did not emit the unrestricted-network profile marker; refusing to launch with an unreviewed profile", 79);
  }
  const resolverRules = [
    marker,
    "(allow system-socket (socket-domain AF_UNIX))",
    '(allow file-read-metadata (literal "/etc") (literal "/var"))',
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(allow network-outbound (remote unix-socket (path-literal "/var/run/mDNSResponder")))',
  ].join("\n");
  wrapped = wrapped.replace(marker, resolverRules);
}
// `detached` makes the child a process-group leader so the whole tree can be
// signalled at once. `shell: true` puts a shell between this process and the
// command, and SRT's own wrapper adds `sandbox-exec`/`bwrap` on top, so
// signalling the direct child alone can leave the real command running.
const child = spawn(wrapped, { shell: true, stdio: "inherit", detached: true });

// How long a forwarded signal has before this process escalates to SIGKILL.
//
// The bound comes from the MCP stdio client, which is the caller that tears
// these down: `StdioClientTransport.close()` ends the child's stdin, waits 2s,
// sends SIGTERM, waits another 2s, then sends SIGKILL — to THIS process, not to
// the sandboxed command underneath it. A SIGKILL here runs no handlers, so a
// child that has not died by then is orphaned to init permanently. Escalating
// inside that 2s window is what stops it. Keep this comfortably under 2000; if
// a future SDK changes those timings, this constant has to move with them.
//
// mono-agent#669: five stdio MCP servers survived their runs this way in one
// day, each parked in libuv's poll and deaf to SIGTERM, reaped only by SIGKILL.
const CHILD_KILL_GRACE_MS = 1_000;

// How long to let a SIGKILL land before leaving. The kill itself is immediate;
// this only covers the kernel reaping the group.
const KILL_SETTLE_MS = 50;

let escalation;
let requestedSignal;
let finished = false;

// Signal the child's whole process group, falling back to the child alone when
// the group cannot be addressed. Never throws: this runs from signal handlers
// and from a timer, where an exception would be fatal.
function signalChildTree(signal) {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone, or unaddressable. Nothing further to do.
  }
}

// Whether anything is still running in the child's process group. A dead group
// leader does not mean an empty group — the shell exits on SIGTERM while the
// command it forked carries on, which is precisely how a wedged MCP server used
// to be left behind.
function childTreeAlive() {
  if (child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function finish(code, signal) {
  if (finished) {
    return;
  }
  finished = true;
  if (escalation !== undefined) {
    clearTimeout(escalation);
    escalation = undefined;
  }
  SandboxManager.cleanupAfterCommand();
  if (requestedSignal !== undefined) {
    // Teardown we were asked to perform: the command's own exit status is not
    // meaningful, and the SRT CLI contract reports a clean stop.
    process.exit(requestedSignal === "SIGKILL" ? 1 : 0);
  }
  if (signal !== null && signal !== undefined) {
    process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  }
  process.exit(code ?? 0);
}

function terminateChildTree(signal) {
  requestedSignal = signal;
  signalChildTree(signal);
  if (escalation !== undefined) {
    return;
  }
  // Deliberately NOT unref'd. Once the direct child exits its handle stops
  // holding the loop open, and an unref'd timer would let this process leave
  // before the escalation ever ran — which is the orphaning bug wearing a
  // different hat: the shell dies on SIGTERM in milliseconds while the command
  // it forked carries on. This timer is the only thing keeping us here to
  // finish the job, so it has to count.
  escalation = setTimeout(() => {
    signalChildTree("SIGKILL");
    escalation = setTimeout(() => finish(0, null), KILL_SETTLE_MS);
  }, CHILD_KILL_GRACE_MS);
}

child.on("exit", (code, signal) => {
  // While tearing down, the direct child exiting is not the end: it is usually
  // the shell, and the real command shares its process group. Leaving now is
  // what orphaned the command — wait for the group to empty, or for the
  // escalation above to empty it.
  if (requestedSignal !== undefined && childTreeAlive()) {
    return;
  }
  finish(code, signal);
});
child.on("error", (error) => {
  console.error(`srt-embed-runner: failed to execute command: ${error.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => terminateChildTree(signal));
}
