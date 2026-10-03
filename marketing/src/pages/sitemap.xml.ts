import type { APIRoute } from 'astro';
import { getPublishedBlogPosts } from '../blog-content';
import { POSTS_PER_PAGE, toISODate } from '../blog.mjs';

export const GET: APIRoute = async ({ site }) => {
  const posts = await getPublishedBlogPosts();
  const urls: Array<{ loc: string; lastmod?: string }> = [
    { loc: new URL('/', site).href },
    { loc: new URL('/privacy/', site).href },
  ];
  // Blog index plus one entry per pagination page. lastmod tracks the newest
  // post on that page so empty indexes carry no fabricated dates.
  const pageCount = Math.max(1, Math.ceil(posts.length / POSTS_PER_PAGE));
  for (let page = 1; page <= pageCount; page++) {
    const pagePosts = posts.slice((page - 1) * POSTS_PER_PAGE, page * POSTS_PER_PAGE);
    const newest = pagePosts[0];
    urls.push({
      loc: new URL(page === 1 ? '/blog/' : `/blog/${page}/`, site).href,
      ...(newest
        ? { lastmod: toISODate(newest.data.updatedDate ?? newest.data.publishDate) }
        : {}),
    });
  }
  for (const post of posts) {
    urls.push({
      loc: new URL(`/blog/${post.id}/`, site).href,
      lastmod: toISODate(post.data.updatedDate ?? post.data.publishDate),
    });
  }
  const body = urls
    .map(({ loc, lastmod }) =>
      lastmod
        ? `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`
        : `  <url><loc>${loc}</loc></url>`,
    )
    .join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
};
