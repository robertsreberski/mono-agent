// @ts-check
// Hound 13.2.0 robots.py origin-cache idea, adapted to fail closed and to cache
// completed decisions only. No shielded tasks, fail-open misses or bypass.
// Copyright (c) 2026 Bishesh Bhandari, MIT; see THIRD_PARTY_NOTICES.md.
import robotsParser from "robots-parser";
import { assertHoundTarget, houndRequest, HOUND_USER_AGENT } from "./network.js";
import { withWebDeadline } from "../web-request.js";

// robots-parser's legacy ambient-module declaration is ambiguous under NodeNext;
// the CJS default is callable at runtime. Pin the narrow parser contract here.
const parseRobots = /** @type {(url: string, text: string) => {isAllowed(url: string, ua: string): boolean | undefined, getCrawlDelay(ua: string): number | undefined}} */ (/** @type {unknown} */ (robotsParser));
const caches = new WeakMap();
const TTL = 3_600_000;
const LIMIT = 64;

export async function assertHoundRobots(url, options) {
  const target = assertHoundTarget(url, options);
  const userAgent = options.userAgent ?? HOUND_USER_AGENT;
  // Search state or explicit fetch owner isolates lifecycle. No in-flight
  // sharing: cancelling one call never leaves another owner's request alive.
  const owner = options.robotsOwner ?? options.searchState ?? options;
  let cache = caches.get(owner);
  if (!cache) { cache = new Map(); caches.set(owner, cache); }
  const key = JSON.stringify([target.origin, userAgent, options.policy, options.coordinator?.scope]);
  let entry = cache.get(key);
  if (entry && entry.expires <= Date.now()) { cache.delete(key); entry = undefined; }
  if (!entry) {
    entry = await withWebDeadline(options.signal, 5_000, async (signal) => {
      let robotsUrl = new URL("/robots.txt", target).href;
      for (let hop = 0; hop <= 2; hop += 1) {
        const { response, text } = await houndRequest(robotsUrl, { ...options, signal, userAgent }, {}, 64 * 1024);
        signal.throwIfAborted();
        if (response.status >= 300 && response.status < 400) {
          if (hop === 2 || !response.headers.get("location")) throw robotsError("robots_unavailable");
          robotsUrl = new URL(response.headers.get("location"), robotsUrl).href;
          continue; // houndRequest gates the computed destination before admission
        }
        if ([404, 410].includes(response.status)) return { parser: null, expires: Date.now() + TTL };
        if (!response.ok || /<(?:!doctype|html|head|body)\b/iu.test(text)) throw robotsError("robots_unavailable");
        const directives = text.split(/\r?\n/u).map((line) => line.replace(/#.*/u, "").trim()).filter(Boolean);
        if (directives.some((line) => !/^(?:user-agent|allow|disallow|sitemap|crawl-delay|host|clean-param|request-rate)\s*:/iu.test(line))) throw robotsError("robots_unavailable");
        return { parser: parseRobots(new URL("/robots.txt", target).href, text), expires: Date.now() + TTL };
      }
      throw robotsError("robots_unavailable");
    }).catch((error) => {
      if (options.signal?.aborted) throw error;
      if (["network_denied", "coordination_unavailable", "search_budget_exhausted", "access_challenge", "authentication_required", "rate_limited"].includes(error?.code)) throw error;
      throw robotsError("robots_unavailable");
    });
    options.signal?.throwIfAborted();
    cache.set(key, entry);
    while (cache.size > LIMIT) cache.delete(cache.keys().next().value);
  }
  if (!entry.parser) return;
  // The host/process coordinator has fixed spacing, not an arbitrary pacing
  // attestation. Conservatively defer all positive crawl delays, never sleep
  // around a budget or pretend that caching rules enforced pacing.
  if (entry.parser.getCrawlDelay(userAgent) > 0) throw robotsError("robots_crawl_delay");
  if (entry.parser.isAllowed(target.href, userAgent) === false) throw robotsError("robots_denied");
}

function robotsError(code) {
  return Object.assign(new Error(`Hound robots check refused (${code}).`), { code });
}
