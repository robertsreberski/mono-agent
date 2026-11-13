// Explicit, network-using smoke. Not part of the offline test suite.
// Run with Node on macOS or a glibc Linux host as a non-root user.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, readlinkSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const script = fileURLToPath(new URL('../../marketing/public/install.sh', import.meta.url));
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'mono-installer-live-')));
const home = path.join(scratch, 'home');
const tools = path.join(scratch, 'tools');
mkdirSync(home, { mode: 0o700 }); mkdirSync(tools, { mode: 0o700 });
// Deliberately omit host Node/npm, but retain installer and native-build tools.
for (const name of ['id', 'uname', 'ls', 'awk', 'grep', 'sed', 'mkdir', 'rmdir', 'rm', 'mv', 'cat', 'chmod', 'dirname', 'readlink', 'env', 'curl', 'tar', 'gzip', 'mktemp', 'sha256sum', 'shasum', 'getconf', 'sh', 'python3', 'make', 'g++', 'cc', 'c++', 'ar', 'ld', 'git', 'head', 'tail', 'cut', 'tr', 'find', 'xargs', 'sort', 'uniq', 'wc', 'cp', 'ln', 'touch', 'date', 'basename', 'which', 'sed']) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  if (found && !existsSync(path.join(tools, name))) symlinkSync(found, path.join(tools, name));
}
for (const directory of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
  if (!existsSync(directory)) continue;
  for (const name of readdirSync(directory)) {
    if (['node', 'nodejs', 'npm', 'npx', 'corepack', 'pnpm'].includes(name)) continue;
    if (!existsSync(path.join(tools, name))) symlinkSync(path.join(directory, name), path.join(tools, name));
  }
}
const env = { ...process.env, HOME: home, PATH: tools, SHELL: '/bin/bash' };
delete env.NODE_OPTIONS; delete env.NODE_PATH;
const run = (command, args, expected = 0) => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 900000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  assert.equal(result.status, expected, `exit: ${result.status}; ${result.error?.message ?? ''}`);
  return result;
};
try {
  run('/bin/sh', [script, '--non-interactive', '--version', '0.26.0']);
  const prefix = path.join(home, '.mono-agent/cli');
  const shim = path.join(prefix, 'bin/mono-agent');
  const node = path.join(prefix, 'current/runtime/bin/node');
  run(shim, ['--version']); run(shim, ['--help']);
  const probe = path.join(scratch, 'native.cjs');
  writeFileSync(probe, `
const {createRequire}=require('node:module');
const path=require('node:path');
const from=createRequire(path.join(process.argv[2],'current/npm/lib/node_modules/create-mono-agent/package.json'));
const fs=require('node:fs');
const app=createRequire(from.resolve('@mono-agent/app/package.json'));
const owner=name=>createRequire(app.resolve.paths(name).map(base=>path.join(base,name,'package.json')).find(file=>fs.existsSync(file)));
const memory=owner('@mono-agent/memory');
const turn=owner('@mono-agent/turn');
const Database=memory('better-sqlite3'); const vec=memory('sqlite-vec');
const db=new Database(':memory:'); vec.load(db);
const row=db.prepare('select 40 + 2 as answer, vec_version() as vec').get(); db.close();
turn('sharp')({create:{width:1,height:1,channels:3,background:'#abcdef'}}).resize(2,2).png().toBuffer({resolveWithObject:true}).then(({info})=>{
 if(row.answer!==42 || info.width!==2 || info.height!==2) throw new Error('native proof mismatch');
 console.log(JSON.stringify({node:process.version,execPath:process.execPath,abi:process.versions.modules,sqlite:row,sharp:info}));
});
`);
  run(node, [probe, prefix]);
  const first = readlinkSync(path.join(prefix, 'current'));
  // An incompatible host Node must never be executed, including during npm builds.
  writeFileSync(path.join(tools, 'node'), '#!/bin/sh\necho "incompatible host Node invoked" >&2\nexit 99\n', { mode: 0o700 });
  run('/bin/sh', [script, '--non-interactive', '--version', '0.26.0']);
  const second = readlinkSync(path.join(prefix, 'current'));
  assert.notEqual(first, second); assert.ok(existsSync(path.join(prefix, first)));
  run(node, [probe, prefix]);
  run('/bin/sh', [script, '--non-interactive', '--version', '9999.0.0'], 1);
  assert.equal(readlinkSync(path.join(prefix, 'current')), second);
  run(shim, ['--version']);
  writeFileSync(path.join(home, '.mono-agent/preserve-proof'), 'fictional credentials');
  run('/bin/sh', [script, '--uninstall', '--yes', '--non-interactive']);
  assert.ok(!existsSync(prefix));
  assert.equal(readFileSync(path.join(home, '.mono-agent/preserve-proof'), 'utf8'), 'fictional credentials');
  console.log('LIVE PROOF PASSED: private ABI/native deps, masked + incompatible host Node, upgrade, failed-upgrade preservation, scoped uninstall.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
