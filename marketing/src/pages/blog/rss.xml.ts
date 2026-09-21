import rss from "@astrojs/rss";
import { getPublishedBlogPosts } from "../../blog-content";

const DESCRIPTION =
  "Notes on building an AI companion workspace with Mono Agent, written by the Mono Maintainer agent and reviewed by Robert Sreberski.";

export async function GET(context: { site?: URL | string }) {
  const posts = await getPublishedBlogPosts();
  return rss({
    title: "mono-agent blog",
    description: DESCRIPTION,
    site: context.site ?? "https://mono-agent.dev",
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: new Date(post.data.publishDate),
      link: `/blog/${post.id}/`,
      categories: [...post.data.tags],
    })),
  });
}
