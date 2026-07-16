export const NO_RELEASE_AGE_POLICY_COMMENT =
  "No package release-age cooldown is currently enforced.";

export function inspectPnpmReleaseAgePolicy(workspaceSource, packageManager) {
  const minimumReleaseAge = readTopLevelNumber(workspaceSource, "minimumReleaseAge");
  const hasExclusions = hasTopLevelKey(workspaceSource, "minimumReleaseAgeExclude");
  const claimsNoPolicy = workspaceSource.includes(NO_RELEASE_AGE_POLICY_COMMENT);
  const issues = [];

  if (minimumReleaseAge instanceof Error) {
    issues.push(minimumReleaseAge.message);
  }

  const effectiveAge = typeof minimumReleaseAge === "number" ? minimumReleaseAge : undefined;
  if (hasExclusions && !(effectiveAge !== undefined && effectiveAge > 0)) {
    issues.push(
      "minimumReleaseAgeExclude requires a positive top-level minimumReleaseAge in pnpm-workspace.yaml.",
    );
  }

  if (claimsNoPolicy && effectiveAge !== undefined && effectiveAge > 0) {
    issues.push(
      `Workspace comment says "${NO_RELEASE_AGE_POLICY_COMMENT}" but minimumReleaseAge is positive.`,
    );
  }

  if (effectiveAge !== undefined && effectiveAge > 0) {
    const pinnedVersion = parsePinnedPnpmVersion(packageManager);
    const minimumSupportedVersion = hasExclusions ? [10, 19, 0] : [10, 16, 0];
    if (pinnedVersion === undefined) {
      issues.push(
        "A positive minimumReleaseAge requires an exact packageManager pnpm pin; engines.pnpm alone is not enforced.",
      );
    } else if (compareVersions(pinnedVersion, minimumSupportedVersion) < 0) {
      issues.push(
        `Configured release-age policy requires pnpm >=${minimumSupportedVersion.join(".")}.`,
      );
    }
  }

  if (
    !claimsNoPolicy
    && !(minimumReleaseAge instanceof Error)
    && (effectiveAge === undefined || effectiveAge === 0)
    && !hasExclusions
  ) {
    issues.push(
      `Workspace must state "${NO_RELEASE_AGE_POLICY_COMMENT}" while no release-age policy is configured.`,
    );
  }

  return {
    claimsNoPolicy,
    hasExclusions,
    issues,
    minimumReleaseAge: effectiveAge,
  };
}

function hasTopLevelKey(source, key) {
  return new RegExp(`^${key}:`, "mu").test(source);
}

function readTopLevelNumber(source, key) {
  const line = source.split(/\r?\n/u).find((candidate) => candidate.startsWith(`${key}:`));
  if (line === undefined) {
    return undefined;
  }
  const rawValue = line.slice(key.length + 1).split("#", 1)[0]?.trim() ?? "";
  if (!/^\d+$/u.test(rawValue)) {
    return new Error(`${key} must be a non-negative integer number of minutes.`);
  }
  return Number(rawValue);
}

function parsePinnedPnpmVersion(packageManager) {
  if (typeof packageManager !== "string") {
    return undefined;
  }
  const match = /^pnpm@(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/u.exec(packageManager);
  return match === null ? undefined : match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
