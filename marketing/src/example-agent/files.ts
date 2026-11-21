// The public example agent, imported byte-for-byte at build time so the page
// can never drift from the validated folder. Display order and labels live in
// manifest.json; the folder itself holds exactly these ten files.
import envExample from "./payments-maintainer/.env.example?raw";
import gitignore from "./payments-maintainer/.gitignore?raw";
import identity from "./payments-maintainer/IDENTITY.md?raw";
import mcp from "./payments-maintainer/mcp.json?raw";
import config from "./payments-maintainer/mono-agent.config.json?raw";
import morningCheck from "./payments-maintainer/cron/morning-check.md?raw";
import scratchReadme from "./payments-maintainer/scratch/README.md?raw";
import flakyTests from "./payments-maintainer/skills/flaky-tests/SKILL.md?raw";
import triage from "./payments-maintainer/skills/triage/SKILL.md?raw";
import ciFailed from "./payments-maintainer/webhook/ci-failed.md?raw";
import manifestJson from "./manifest.json";

export interface ManifestEntry {
  path: string;
  /** Display name when it differs from the path's basename (private folders). */
  label?: string;
  kind: "file" | "dir" | "private";
  role: string;
  number: string;
  note: string;
}

export const ROOT_NAME = "payments-maintainer/";

export const FILES: Record<string, string> = {
  ".env.example": envExample,
  ".gitignore": gitignore,
  "IDENTITY.md": identity,
  "mcp.json": mcp,
  "mono-agent.config.json": config,
  "cron/morning-check.md": morningCheck,
  "scratch/README.md": scratchReadme,
  "skills/flaky-tests/SKILL.md": flakyTests,
  "skills/triage/SKILL.md": triage,
  "webhook/ci-failed.md": ciFailed,
};

export const MANIFEST = manifestJson as ManifestEntry[];

const listed = MANIFEST.filter((entry) => entry.kind === "file").map((entry) => entry.path).sort();
const imported = Object.keys(FILES).sort();
if (JSON.stringify(listed) !== JSON.stringify(imported)) {
  throw new Error(`example-agent manifest files ${JSON.stringify(listed)} must equal imported files ${JSON.stringify(imported)}.`);
}

/** Escape element text (quotes may stay literal outside attributes). */
export function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escape an attribute value. */
export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
