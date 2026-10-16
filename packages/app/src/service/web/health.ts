
export async function webHealthcheck(url: string): Promise<boolean> {
  return (await webHealthStatus(url)) !== "unavailable";
}

export async function webHealthStatus(url: string): Promise<"ok" | "degraded" | "unavailable"> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return "unavailable";
    }
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.version !== 1) return "unavailable";
    if (hasExactKeys(body, ["status", "version", "push"])) {
      return body.status === "ok" && (body.push === "ok" || body.push === "degraded")
        ? body.push
        : "unavailable";
    }
    // Accept the pre-push health contract so a newer CLI can still manage an
    // older installed web service during upgrades.
    return hasExactKeys(body, ["status", "version"])
      && (body.status === "ok" || body.status === "degraded")
      ? body.status
      : "unavailable";
  } catch {
    return "unavailable";
  }
}



function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}


function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}