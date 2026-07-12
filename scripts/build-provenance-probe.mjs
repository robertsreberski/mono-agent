#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeBuildOutputDigest,
  readBuildMarker,
} from "./lib/build-provenance.mjs";

function exactKeys(value, keys) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function runBuildProvenanceProbe(argv = process.argv.slice(2), stdout = process.stdout) {
  const [repo, ...extra] = argv;
  if (extra.length > 0 || typeof repo !== "string" || !isAbsolute(repo) || repo.includes("\0")) {
    stdout.write('{"schemaVersion":1,"status":"unsafe"}\n');
    return 1;
  }
  const initial = readBuildMarker(repo);
  if (initial.status === "ok"
    && exactKeys(initial, ["status", "marker", "fingerprint"])) {
    let outputDigest;
    try {
      outputDigest = computeBuildOutputDigest(repo);
    } catch {
      stdout.write('{"schemaVersion":1,"status":"unsafe"}\n');
      return 1;
    }
    const final = readBuildMarker(repo);
    if (final.status !== "ok"
      || !exactKeys(final, ["status", "marker", "fingerprint"])
      || final.fingerprint !== initial.fingerprint) {
      stdout.write('{"schemaVersion":1,"status":"unsafe"}\n');
      return 1;
    }
    stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      marker: initial.marker,
      fingerprint: initial.fingerprint,
      outputDigest,
    })}\n`);
    return 0;
  }
  const status = initial.status === "missing" || initial.status === "malformed" ? initial.status : "unsafe";
  stdout.write(`${JSON.stringify({ schemaVersion: 1, status })}\n`);
  return 1;
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) process.exitCode = runBuildProvenanceProbe();
