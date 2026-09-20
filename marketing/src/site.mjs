// Never derive a canonical from VERCEL_URL: branch/build aliases are duplicates.
// Switch PUBLIC_SITE_URL only after the custom domain is connected and verified.
export const DEFAULT_SITE_URL = 'https://mono-agent-marketing.vercel.app';
export function resolveSiteUrl(value = process.env.PUBLIC_SITE_URL || DEFAULT_SITE_URL) {
  const url = new URL(value);
  const allowed = ['mono-agent-marketing.vercel.app', 'mono-agent.dev', 'www.mono-agent.dev'];
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_SITE_URL must be an approved HTTPS production origin, without a path, port, credentials, query or fragment.');
  }
  return url.origin;
}
