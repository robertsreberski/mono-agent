export type ConsoleView = "chats" | "board";

export type ConsoleRoute =
  | { readonly view: "chats" }
  | { readonly view: "chats"; readonly threadId: string }
  | {
      readonly view: "chats";
      readonly cron: { readonly sourceId: string; readonly jobId: string };
    }
  | { readonly view: "board" };

const decoded = (value: string): string | undefined => {
  try {
    const result = decodeURIComponent(value);
    return result.length === 0 ? undefined : result;
  } catch {
    return undefined;
  }
};

export function parseRoute(pathname: string): ConsoleRoute {
  if (pathname === "/" || pathname === "") return { view: "chats" };
  if (/^\/board\/?$/u.test(pathname)) return { view: "board" };
  const thread = /^\/threads\/([^/]+)\/?$/u.exec(pathname);
  if (thread !== null) {
    const threadId = decoded(thread[1]!);
    return threadId === undefined ? { view: "chats" } : { view: "chats", threadId };
  }
  const cron = /^\/agents\/([^/]+)\/cron\/([^/]+)\/?$/u.exec(pathname);
  if (cron !== null) {
    const sourceId = decoded(cron[1]!);
    const jobId = decoded(cron[2]!);
    if (sourceId !== undefined && jobId !== undefined) {
      return { view: "chats", cron: { sourceId, jobId } };
    }
  }
  // Memory is intentionally absent from this iteration. Stale and unknown
  // routes recover to Chats instead of exposing a half-wired destination.
  return { view: "chats" };
}

export function routePath(route: ConsoleRoute): string {
  if (route.view === "board") return "/board";
  if ("threadId" in route) return `/threads/${encodeURIComponent(route.threadId)}`;
  if ("cron" in route) {
    return `/agents/${encodeURIComponent(route.cron.sourceId)}/cron/${encodeURIComponent(route.cron.jobId)}`;
  }
  return "/";
}

export const cronChannelPath = (sourceId: string, jobId: string): string =>
  routePath({ view: "chats", cron: { sourceId, jobId } });

export const cronRouteSelection = (
  route: ConsoleRoute = parseRoute(window.location.pathname),
): { readonly sourceId: string; readonly jobId: string } | undefined =>
  route.view === "chats" && "cron" in route ? route.cron : undefined;
