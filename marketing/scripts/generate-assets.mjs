// One-off asset pipeline for the marketing site.
//
// Derives the committed, optimized web assets in marketing/public/ from the
// parent-supplied brand source (1536x1024 PNG: charcoal monolith on the
// right, lime filament, dark negative space on the left, no text or UI).
//
// The source itself is intentionally NOT committed: keep it at
// marketing/assets-source/brand-source.png (gitignored, local only), or leave
// the original loose copy at the worktree root. Only the derivatives below
// ship in git. The production build never runs this script; it consumes the
// committed files directly, so CI needs no source image.
//
//   pnpm run assets   (from marketing/)
//
// Outputs (all scripted for the pinned sharp 0.35.4):
//   public/hero-1440.{jpg,webp}   hero artwork, desktop widths
//   public/hero-960.{jpg,webp}    hero artwork, tablet widths
//   public/hero-640.{jpg,webp}    hero artwork, mobile widths
//   public/og-1200x630.jpg        Open Graph / Twitter card (1200x630)
//
// The social card composites deterministic SVG typography onto the cropped
// artwork: the brand name plus a one-line category descriptor, set in the
// platform sans (Verdana locally, DejaVu Sans on Ubuntu CI) on the dark
// left side the attention crop preserves. The card is generated once and
// committed — CI serves and tests the file, never re-renders it.
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const marketingRoot = resolve(here, "..");
const publicDir = join(marketingRoot, "public");

const SOURCE_CANDIDATES = [
  join(marketingRoot, "assets-source", "brand-source.png"),
  join(marketingRoot, "..", "mono-agent-brand-source.png"),
];

async function findSource() {
  for (const candidate of SOURCE_CANDIDATES) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `Brand source not found. Place the supplied PNG at ${SOURCE_CANDIDATES[0]} (gitignored).`,
  );
}

const HERO_WIDTHS = [1440, 960, 640];

async function main() {
  const source = await findSource();
  console.log(`assets: source ${source}`);
  await mkdir(publicDir, { recursive: true });

  for (const width of HERO_WIDTHS) {
    const base = sharp(source).resize({ width, withoutEnlargement: true });
    await base.clone().jpeg({ quality: 80, mozjpeg: true }).toFile(join(publicDir, `hero-${width}.jpg`));
    await base.clone().webp({ quality: 80 }).toFile(join(publicDir, `hero-${width}.webp`));
    console.log(`assets: hero-${width}.jpg + hero-${width}.webp`);
  }

  // Social card: exact 1200x630. The `attention` crop keeps the bright
  // filament/monolith (right side) and trims the dark negative space first;
  // brand typography is then composited onto the dark left side.
  const cardBase = sharp(source).resize(1200, 630, {
    fit: "cover",
    position: sharp.strategy.attention,
  });
  const cardType = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <text x="80" y="296" font-family="Verdana, 'DejaVu Sans', sans-serif" font-size="88" font-weight="700" fill="#f2f3ec">mono-agent</text>
  <rect x="84" y="326" width="72" height="7" fill="#cbf078"/>
  <text x="80" y="402" font-family="Verdana, 'DejaVu Sans', sans-serif" font-size="40" font-weight="700" fill="#cbf078">Local-first AI workspace</text>
  <text x="80" y="456" font-family="Verdana, 'DejaVu Sans', sans-serif" font-size="40" fill="#bcc1b3">for coding and research</text>
</svg>`);
  await cardBase
    .composite([{ input: cardType, left: 0, top: 0 }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(join(publicDir, "og-1200x630.jpg"));
  console.log("assets: og-1200x630.jpg");
}

await main();
