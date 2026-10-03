import { getCollection } from "astro:content";
import { assertValidSlug, compareNewestFirst } from "./blog.mjs";

// Published posts: drafts are always excluded from the index, RSS and
// sitemap. Slugs are validated so an invalid folder name fails the build.
export async function getPublishedBlogPosts() {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  for (const post of posts) assertValidSlug(post.id);
  return posts.sort(compareNewestFirst);
}

// Pages built for production exclude drafts entirely. In dev, drafts render
// at their URL for author preview but stay out of the index, RSS and sitemap.
export async function getBuildableBlogPosts() {
  const posts = await getCollection("blog", ({ data }) =>
    import.meta.env.PROD ? !data.draft : true,
  );
  for (const post of posts) assertValidSlug(post.id);
  return posts.sort(compareNewestFirst);
}
