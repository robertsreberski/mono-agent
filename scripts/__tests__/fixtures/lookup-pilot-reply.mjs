// exit can precede buffered IPC delivery. Only channel/stdio close proves that
// no reply is still in flight; a missing reply is always an explicit failure.
export function fixtureDriverReply(child, input, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false, sent = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); finish(reject, new Error("fixture_deadline"));
    }, timeoutMs);
    child.on("message", message => {
      if (settled) return;
      if (message.ready) {
        if (sent) return; sent = true;
        try { child.send(input, error => { if (error) finish(reject, error); }); }
        catch (error) { finish(reject, error); }
      } else finish(resolve, message);
    });
    child.once("close", (code, signal) => finish(reject, Object.assign(new Error(`fixture_reply_missing: exit=${code}, signal=${signal}`), {code: "fixture_reply_missing"})));
    child.once("error", error => finish(reject, error));
  });
}

// Stop every owned driver before its final witness is read: it may record one
// last probe while shutdown is in flight. Probe cleanup still checks identities.
export async function stopFixtureDrivers(records) {
  for (const {child, exit} of records) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  }
}
