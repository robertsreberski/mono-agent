import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the built SPA `dist/spa` directory.
 *
 * Hosts can pass this to a static file server when embedding the config UI
 * in a larger HTTP surface; the in-box bridge serves it automatically.
 */
export const CONFIG_UI_STATIC_DIR: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "spa",
);
