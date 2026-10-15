import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderHelp, renderHelpTopic } from "../cli.js";
import { readinessProbeTimeoutDescription } from "../readiness-probe.js";

/**
 * The init wall-clock disclosure lives in the `help init` detail view (the
 * grouped `mono-agent help` summary is one scannable line per command). This is
 * the surface whose disclosure prominence the guardrail below protects.
 */
function initHelpText(): string {
  const result = renderHelpTopic("init");
  if (!result.ok) {
    throw new Error(`expected \`help init\` to resolve, got: ${result.message}`);
  }
  return result.text;
}

const PACKAGE_README = readFileSync(
  fileURLToPath(new URL("../../README.md", import.meta.url)),
  "utf8",
);
const ROOT_README = readFileSync(
  fileURLToPath(new URL("../../../../README.md", import.meta.url)),
  "utf8",
);

const HELP_DISCLOSURE_FIRST_LINE =
  "Fast scaffold-only path: flags or non-TTY input; without explicit --auth,";
const PACKAGE_DISCLOSURE_PREFIX = "Setup has two deliberate wall-clock paths:";
const ROOT_QUICKSTART_HEADING = "## Quickstart: An Agent Folder From One Config File";
const ROOT_SETUP_DETAILS_HEADING = "## Setup details";
/**
 * The root README deliberately uses plain language instead of the legacy
 * wall-clock taxonomy. This guard protects the semantic signal — authenticating,
 * real billable model requests, the scaffold-only automated path — and its
 * location as the second pre-step paragraph of the Quickstart. The exact
 * deadlines stay in the linked `## Setup details` section.
 */
const ROOT_DISCLOSURE_MARKERS: readonly RegExp[] = [
  /guided setup/i,
  /signs you in to the provider/i,
  /real model request/i,
  /scaffold only/i,
  /--auth/u,
  /counts as usage/i,
];

interface DisclosureSurfaces {
  readonly help: string;
  readonly packageReadme: string;
  readonly rootReadme: string;
}

function occurrences(source: string, needle: string): number {
  return source.replace(/\s+/gu, " ").split(needle).length - 1;
}

function paragraphs(source: string): string[] {
  return source
    .trim()
    .split(/\n[\t ]*\n/gu)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

function initHelpDescriptionLines(help: string): string[] {
  const lines = help.split("\n");
  const initStart = lines.findIndex((line) => line.startsWith("  mono-agent init [--preset"));
  if (initStart < 0) {
    return [];
  }
  const description: string[] = [];
  for (let index = initStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.startsWith("  mono-agent ")) {
      // The next command entry (only present in a multi-entry render) ends the block.
      break;
    }
    // Description lines are dim text indented by exactly six spaces; signature
    // continuation lines are indented further and are skipped.
    if (/^ {6}\S/u.test(line)) {
      description.push(line.slice(6));
    }
  }
  return description;
}

function packageOpeningParagraphs(source: string): string[] {
  const titleEnd = source.indexOf("\n");
  const categoryStart = source.indexOf("\n## Category", titleEnd);
  if (titleEnd < 0 || categoryStart <= titleEnd) {
    return [];
  }
  return paragraphs(source.slice(titleEnd + 1, categoryStart));
}

function rootQuickstartOpeningParagraphs(source: string): string[] {
  const headingStart = source.indexOf(ROOT_QUICKSTART_HEADING);
  const bodyStart = source.indexOf("\n", headingStart) + 1;
  const firstSubheading = source.indexOf("\n### ", bodyStart);
  if (headingStart < 0 || bodyStart <= headingStart || firstSubheading <= bodyStart) {
    return [];
  }
  return paragraphs(source.slice(bodyStart, firstSubheading));
}

function rootSetupDetailsSection(source: string): string {
  const start = source.indexOf(ROOT_SETUP_DETAILS_HEADING);
  return start === -1 ? "" : source.slice(start);
}

/**
 * Returns the plain-language disclosure markers that the second pre-step
 * Quickstart paragraph is missing.
 */
function missingRootDisclosureMarkers(source: string): string[] {
  const paragraph = rootQuickstartOpeningParagraphs(source)[1] ?? "";
  return ROOT_DISCLOSURE_MARKERS
    .filter((marker) => !marker.test(paragraph))
    .map((marker) => marker.source);
}

function prominenceFailures(surfaces: DisclosureSurfaces): string[] {
  const failures: string[] = [];
  const helpLines = initHelpDescriptionLines(surfaces.help);
  if (helpLines[0] !== HELP_DISCLOSURE_FIRST_LINE) {
    failures.push("init help disclosure is not the first description line");
  }

  const packageOpening = packageOpeningParagraphs(surfaces.packageReadme);
  if (
    packageOpening.length !== 2
    || !packageOpening[1]?.startsWith(PACKAGE_DISCLOSURE_PREFIX)
  ) {
    failures.push("package README disclosure is not its second opening body paragraph");
  }

  // Location guard only: the root disclosure stays one of the first two
  // pre-step paragraphs, while its wording is free to stay plain-language.
  const rootOpening = rootQuickstartOpeningParagraphs(surfaces.rootReadme);
  if (rootOpening.length < 2 || missingRootDisclosureMarkers(surfaces.rootReadme).length > 0) {
    failures.push("root README disclosure is not the plain-language second pre-section Quickstart paragraph");
  }
  return failures;
}

describe("init wall-clock disclosure", () => {
  it("keeps the guided-probe signal on the default `mono-agent help` summary line for init", () => {
    // The grouped summary is one line per command; the init line must still warn
    // that the guided path makes blocking live model calls, so the disclosure
    // cannot silently vanish from the surface most users see first.
    const summary = renderHelp();
    const initSummaryLine = summary
      .split("\n")
      .find((line) => line.includes("Scaffold a new agent")) ?? "";
    expect(initSummaryLine, "the init summary line must exist").not.toBe("");
    expect(initSummaryLine, "the init summary must keep the live-probe signal").toContain("probes");
  });

  it("pins the disclosure to the first help description and the README disclosure locations", () => {
    const help = initHelpText();
    const helpLines = initHelpDescriptionLines(help);
    const presetStart = helpLines.findIndex((line) => line.startsWith("--preset seeds"));
    const helpDisclosure = helpLines.slice(0, presetStart).join(" ");
    const packageDisclosure = packageOpeningParagraphs(PACKAGE_README)[1] ?? "";

    expect(prominenceFailures({ help, packageReadme: PACKAGE_README, rootReadme: ROOT_README }))
      .toEqual([]);
    expect(presetStart).toBeGreaterThan(0);
    expect(helpDisclosure).toContain("Fast scaffold-only path");
    expect(helpDisclosure).toContain("flags or non-TTY input");
    expect(helpDisclosure).toContain("without explicit --auth");
    expect(helpDisclosure).toContain("real no-tool model call per selected route");
    expect(helpDisclosure).toContain("before committing the scaffold");
    expect(helpDisclosure).toContain(readinessProbeTimeoutDescription());

    expect(packageDisclosure).toContain("fast scaffold-only path");
    expect(packageDisclosure).toContain("flags or non-TTY input");
    expect(packageDisclosure).toContain("unless explicit `--auth`");
    expect(packageDisclosure).toContain("real no-tool model call per selected route");
    expect(packageDisclosure).toContain("before committing the scaffold");
    expect(packageDisclosure).toContain(readinessProbeTimeoutDescription());

    // The root README keeps the semantic disclosure in the Quickstart and the
    // exact deadlines in the linked setup-details section.
    expect(missingRootDisclosureMarkers(ROOT_README)).toEqual([]);
    expect(rootSetupDetailsSection(ROOT_README)).toContain(readinessProbeTimeoutDescription());

    expect(occurrences(PACKAGE_README, readinessProbeTimeoutDescription())).toBe(2);
    expect(occurrences(ROOT_README, readinessProbeTimeoutDescription())).toBe(1);
  });

  it("fails the reviewer mutation that buries each disclosure behind 20 entries", () => {
    const help = initHelpText();
    const helpFiller = Array.from(
      { length: 20 },
      (_, index) => `      Deferred init detail ${index + 1}.`,
    ).join("\n");
    const paragraphFiller = Array.from(
      { length: 20 },
      (_, index) => `Deferred setup context paragraph ${index + 1}.`,
    ).join("\n\n");
    const mutatedHelp = help.replace(
      `      ${HELP_DISCLOSURE_FIRST_LINE}`,
      `${helpFiller}\n      ${HELP_DISCLOSURE_FIRST_LINE}`,
    );
    const mutatedPackageReadme = PACKAGE_README.replace(
      PACKAGE_DISCLOSURE_PREFIX,
      `${paragraphFiller}\n\n${PACKAGE_DISCLOSURE_PREFIX}`,
    );
    const mutatedRootReadme = ROOT_README.replace(
      "Guided setup is authentic and not instant:",
      `${paragraphFiller}\n\nGuided setup is authentic and not instant:`,
    );

    expect(mutatedHelp).not.toBe(help);
    expect(mutatedPackageReadme).not.toBe(PACKAGE_README);
    expect(mutatedRootReadme).not.toBe(ROOT_README);
    expect(prominenceFailures({
      help: mutatedHelp,
      packageReadme: mutatedPackageReadme,
      rootReadme: mutatedRootReadme,
    })).toEqual([
      "init help disclosure is not the first description line",
      "package README disclosure is not its second opening body paragraph",
      "root README disclosure is not the plain-language second pre-section Quickstart paragraph",
    ]);

    // Moving the plain-language disclosure out of the second paragraph and
    // removing its semantic signals must fail even without reordering.
    const rewrittenRoot = ROOT_README.replace(
      "Guided setup is authentic and not instant: it signs you in to the provider you choose and makes one real model request for every selected route to prove the route answers.",
      "Setup writes a config file.",
    );
    expect(rewrittenRoot).not.toBe(ROOT_README);
    expect(missingRootDisclosureMarkers(rewrittenRoot).length)
      .toBeGreaterThan(0);
  });
});
