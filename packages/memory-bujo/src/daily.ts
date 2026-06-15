import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { serializeBullet } from "./grammar.js";
import type { Bullet } from "./types.js";

export function dailyFilePath(root: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(root, "daily", `${day}.md`);
}

/** Append a bullet to today's daily file (creating it with a heading if absent). Returns the bullet. */
export function appendBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const path = dailyFilePath(root, when);
  mkdirSync(dirname(path), { recursive: true });
  let header = "";
  try {
    readFileSync(path, "utf8");
  } catch {
    header = `# ${when.toISOString().slice(0, 10)}\n\n`;
  }
  appendFileSync(path, `${header}${serializeBullet(bullet)}\n`, "utf8");
  return bullet;
}
