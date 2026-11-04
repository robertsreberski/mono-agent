#!/usr/bin/env node
import { writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, sep, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
export function overlapsInput(out, input, sidecar) {
  out = resolve(out); input = resolve(input);
  const prefix = input.endsWith(sep) ? input : input + sep;
  return out === input || out.startsWith(prefix)
    || input === sidecar && ['-wal', '-shm', '-journal'].some(suffix => out === input + suffix);
}
export async function main(args) {
  try {
    const options = {}, names = { '--sidecar': 'sidecar', '--routes': 'routes', '--agent-config': 'agentConfig',
      '--app-allowlist': 'appAllowlist', '--retrieval-rate': 'retrievalRate', '--qualification': 'qualification', '--out': 'out' };
    for (let i = 0; i < args.length;) {
      const flag = args[i++];
      if (flag === '--journals') {
        if (options.journals) throw new Error('INPUT');
        options.journals = [];
        while (i < args.length && !args[i].startsWith('--')) options.journals.push(args[i++]);
        if (!options.journals.length) throw new Error('INPUT');
      } else {
        const name = names[flag];
        if (!name || options[name] !== undefined || !args[i] || args[i].startsWith('--')) throw new Error('INPUT');
        options[name] = args[i++];
      }
    }
    if (options.out) {
      const out = resolve(realpathSync(dirname(resolve(options.out))), basename(options.out));
      // Reject symlink destinations and output overlapping any supplied input root.
      try { if (lstatSync(out).isSymbolicLink()) throw new Error('INPUT'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const sidecar = options.sidecar ? realpathSync(options.sidecar) : null;
      for (const input of [...(options.journals ?? []), options.sidecar, options.routes, options.agentConfig, options.appAllowlist, options.qualification].filter(Boolean)) {
        const path = realpathSync(input);
        if (overlapsInput(out, path, sidecar)) throw new Error('INPUT');
      }
    }
    const { analyze } = await import('./lib/tool-result-clearing-analysis.mjs');
    const report = analyze(options);
    const text = JSON.stringify(report, null, 2) + '\n';
    if (options.out) writeFileSync(options.out, text, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(text);
    return report.status === 'complete' ? 0 : 2;
  } catch {
    process.stdout.write('{"status":"incomplete","codes":["INPUT_INVALID"],"verdict":"DEFER"}\n');
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
