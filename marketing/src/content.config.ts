import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Blog articles live in `src/content/blog/<slug>/index.md` with sibling
// images. The collection ships empty; the entry id is the folder name and
// doubles as the URL slug (`/blog/<slug>/`). Length and shape rules fail the
// build when violated — see BLOG.md for the authoring contract.
const blog = defineCollection({
  loader: glob({
    pattern: "*/index.md",
    base: "./src/content/blog",
    generateId: ({ entry }) => entry.replace(/\/index\.md$/, ""),
  }),
  schema: ({ image }) =>
    z
      .object({
        title: z.string().min(20).max(70),
        description: z.string().min(110).max(160),
        publishDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        tags: z
          .array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/))
          .min(1)
          .max(5),
        heroImage: image().optional(),
        heroAlt: z.string().optional(),
        heroCaption: z.string().optional(),
        draft: z.boolean().default(false),
        author: z.string().default("Mono Maintainer"),
      })
      .refine(
        (data) =>
          !data.updatedDate || data.updatedDate >= data.publishDate,
        { message: "updatedDate must be on or after publishDate" },
      )
      .refine(
        (data) =>
          !data.heroImage ||
          (typeof data.heroAlt === "string" && data.heroAlt.length > 0),
        { message: "heroAlt is required when heroImage is set" },
      ),
});

export const collections = { blog };
