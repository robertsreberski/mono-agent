// @ts-check

/** A wrapped exit alone (including 127/ENOENT) is not evidence of a denial.
 * @param {boolean | undefined} sandboxed
 * @param {string} diagnostic
 */
export function sandboxFailureDiagnostic(sandboxed, diagnostic) {
  if (!sandboxed) return undefined;
  const denied = /blocked by sandbox|sandbox(?:[- ](?:exec|denial))?[^\n]*\b(?:deny|denied|violation)\b/i.test(diagnostic);
  return {
    code: denied ? "sandbox_denied" : undefined,
    prefix: denied ? "Error: Sandbox denied subprocess execution. "
      : /operation not permitted|\bEPERM\b/i.test(diagnostic)
        ? "Command ran sandboxed. Permission error is commonly a sandbox denial, but may be an OS permission error. "
        : "Command ran sandboxed. ",
  };
}
