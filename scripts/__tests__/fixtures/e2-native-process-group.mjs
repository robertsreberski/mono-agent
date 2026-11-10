// Test supervisor owns the detached group; loss must also contain descendants.
export function killE2NativeGroup(child) {
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
