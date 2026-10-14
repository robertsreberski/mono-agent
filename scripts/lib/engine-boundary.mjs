import { dirname, relative, resolve } from "node:path";

const oldPackage = `@mono-agent/${"harness"}`;
const oldDirectory = `packages/${"harness"}`;
const fixtures = "packages/engine/src/__tests__/fixtures/";

// Exact archived-source lines only, never whole active files.
export function activeStaleReferenceLines(file, text, reference) {
  return text.split("\n").flatMap((line, index) => {
    if (!line.includes(reference)) return [];
    const historical = file === `${fixtures}NATIVE-V2-BASE.md`
      && line === `closure of \`${oldDirectory}/src/session-store.js\` at public P2b revision`
      && text.includes("`10f501d4f1dc102db9951fcebb09a96001910452`")
      || file === `${fixtures}projection-parity-worker.mjs`
      && line === `const historicPackage = "${oldPackage}"; // Archived P2b imports only.`
      || file === `${fixtures}regenerate-projection-goldens.mjs`
      && text.includes('const base = "10f501d4f1dc102db9951fcebb09a96001910452";')
      && (line === `  const archive = execFileSync("git", ["archive", base, "${oldDirectory}/src", "packages/agent-runtime/src"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });`
        || line === `      join(scratch, "${oldDirectory}/src"), join(scratch, "packages/agent-runtime/src"), storage, legacy], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });`);
    return historical ? [] : [index + 1];
  });
}

export function engineRuntimeImports(root, file, text) {
  const runtime = resolve(root, "packages/agent-runtime");
  const imports = [...text.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/gu)].map((match) => match[1]);
  return imports.filter((specifier) => {
    if (/^@mono-agent\/agent-runtime(?:\/|$)/u.test(specifier)) return true;
    if (!specifier.startsWith(".")) return false;
    const target = resolve(dirname(file), specifier);
    const path = relative(runtime, target);
    return path === "" || !path.startsWith("..") && !path.startsWith("/");
  });
}
