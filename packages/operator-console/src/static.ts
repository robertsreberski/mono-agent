import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the built SPA `dist/spa` directory.
 *
 * Hosts can pass this to a static file server when embedding the operator console
 * in a larger HTTP surface; the in-box server serves it automatically.
 */
export const OPERATOR_CONSOLE_STATIC_DIR: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "spa",
);
