import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, readdirSync, rmSync, readlinkSync, realpathSync, chmodSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(root, 'marketing/public/install.sh');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t, options = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mono-installer-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "Morgan's home");
  const bin = path.join(dir, 'bin');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(bin);
  const executable = (name, text) => writeFileSync(path.join(bin, name), text, { mode: 0o755 });
  for (const name of ['ls', 'awk', 'grep', 'sed', 'mkdir', 'rmdir', 'rm', 'mv', 'cat', 'chmod', 'dirname', 'readlink', 'env', 'tar', 'gzip', 'mktemp', options.shasum ? 'shasum' : 'sha256sum']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    // macOS lacks sha256sum: use a fixture adapter to the real shasum.
    if (!found && name === 'sha256sum') executable(name, '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n');
    else { assert.ok(found, name); symlinkSync(found, path.join(bin, name)); }
  }
  executable('id', `#!/bin/sh\necho ${options.root ? 0 : process.getuid()}\n`);
  executable('uname', `#!/bin/sh\ncase $1 in -s) echo ${options.os ?? 'Darwin'};; -m) echo ${options.arch ?? 'arm64'};; esac\n`);
  executable('getconf', `#!/bin/sh\n${options.musl ? 'exit 1' : "echo 'glibc 2.36'"}\n`);
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify(options));
  const runtime = path.join(dir, 'runtime');
  mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  mkdirSync(path.join(runtime, 'lib/node_modules/npm/bin'), { recursive: true });
  writeFileSync(path.join(runtime, 'bin/node'), `#!/bin/sh\n${options.runtimeFail ? 'exit 1' : `if [ "$1" = --version ]; then echo v24.15.0; else exec ${quote(process.execPath)} "$@"; fi`}\n`, { mode: 0o755 });
  const cli = `const fs=require('node:fs'); const options=JSON.parse(fs.readFileSync(${JSON.stringify(config)},'utf8'));\n` + `
if(process.argv[2]==='--version') console.log('mono-agent 0.26.0');
else if(process.argv[2]==='--help') {if(options.helpFail) process.exit(1); console.log('mono-agent help');}
else if(process.argv[2]==='preflight') {
  if(!options.preflight) {console.error('Unknown command \\x60preflight\\x60. Expected init.'); process.exit(1);}
  if(options.preflight==='unexpected') {console.error('failed to execute native probe'); process.exit(1);}
  if(options.preflight==='malformed') {console.log('{bad'); process.exit(0);}
  const ok=options.preflight!=='error';
  console.log(JSON.stringify({schemaVersion:1,operation:'host-preflight',ok,checks:[{id:'runtime.node',status:ok?'ok':'error',message:'fixture check',remediations:['fixture remedy']}]})); process.exit(ok?0:1);
} else { console.log(JSON.stringify({args:process.argv.slice(2),file:__filename,path:process.env.PATH,nodeOptions:process.env.NODE_OPTIONS})); }
`;
  writeFileSync(path.join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'), `
const fs=require('node:fs'), path=require('node:path');
const options=JSON.parse(fs.readFileSync(${JSON.stringify(config)},'utf8'));
const userconfig=process.argv[process.argv.indexOf('--userconfig')+1];
const globalconfig=process.argv[process.argv.indexOf('--globalconfig')+1];
if(userconfig===globalconfig || fs.readFileSync(userconfig,'utf8')!=='' || fs.readFileSync(globalconfig,'utf8')!=='') process.exit(98);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'npm-env.json'))},JSON.stringify(process.env));
if(options.npmFail) process.exit(1);
if(options.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
fs.mkdirSync(path.join(prefix,'lib/node_modules/create-mono-agent'),{recursive:true});
fs.writeFileSync(path.join(prefix,'lib/node_modules/create-mono-agent/package.json'),JSON.stringify({version:'0.26.0'}));
fs.writeFileSync(path.join(prefix,'bin/mono-agent'),${JSON.stringify(cli)});
`);
  const tarballs = {};
  for (const [os, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64']]) {
    const top = `node-v24.15.0-${os}-${arch}`;
    const out = path.join(dir, `${top}.tar.gz`);
    symlinkSync(runtime, path.join(dir, top));
    if (options.badArchive) writeFileSync(path.join(dir, 'outside'), 'unexpected');
    assert.equal(spawnSync('tar', ['-chzf', out, '-C', dir, top, ...(options.badArchive ? ['outside'] : [])]).status, 0);
    tarballs[`${top}.tar.gz`] = out;
  }
  executable('curl', `#!${process.execPath}
const fs=require('node:fs'); const {createHash}=require('node:crypto');
const options=JSON.parse(fs.readFileSync(${JSON.stringify(config)},'utf8'));
const args=process.argv.slice(2), url=args.find(x=>x.startsWith('https://'));
const output=args[args.indexOf('-o')+1];
const archives=${JSON.stringify(tarballs)};
if(options.downloadFail) process.exit(22);
if(url==='https://nodejs.org/dist/v24.15.0/SHASUMS256.txt') {
 let lines=Object.entries(archives).map(([name,file])=>(options.corrupt?'0'.repeat(64):createHash('sha256').update(fs.readFileSync(file)).digest('hex'))+'  '+name+'\\n').join('');
 if(options.missing) lines=''; if(options.duplicate) lines+=lines;
 fs.writeFileSync(output,lines);
} else if(url?.startsWith('https://nodejs.org/dist/v24.15.0/') && archives[url.split('/').at(-1)]) fs.copyFileSync(archives[url.split('/').at(-1)],output);
else {console.error('Unrecognized fixture request: '+url);process.exit(99);}
`);
  const env = { HOME: home, PATH: bin, SHELL: '/bin/bash', ...options.env };
  const run = (args = [], extra = {}) => spawnSync('/bin/sh', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  const cliRoot = path.join(home, '.mono-agent/cli');
  return { dir, home, bin, env, run, cliRoot, config, update: value => writeFileSync(config, JSON.stringify(value)) };
}
function passed(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }
function failed(result, message) { assert.notEqual(result.status, 0); assert.match(result.stderr, message); }

test('generated artifact and checksum are fresh', () => {
  passed(spawnSync(process.execPath, ['scripts/installer/generate.mjs', '--check'], { cwd: root, encoding: 'utf8' }));
  const hash = createHash('sha256').update(readFileSync(script)).digest('hex');
  assert.equal(readFileSync(script + '.sha256', 'utf8'), `${hash}  install.sh\n`);
});
for (const options of [{}, { os: 'Linux', arch: 'x86_64' }, { os: 'Linux', arch: 'aarch64' }, { arch: 'x86_64', shasum: true }]) {
  test(`install, isolation, upgrade, argv and uninstall ${JSON.stringify(options)}`, t => {
    const f = fixture(t, options);
    const result = f.run(['--non-interactive']); passed(result);
    assert.match(result.stderr, /host preflight unavailable in this version/);
    assert.match(result.stdout, /not yet on PATH|Activate in this shell/);
    const old = readlinkSync(path.join(f.cliRoot, 'current'));
    const shim = path.join(f.cliRoot, 'bin/mono-agent');
    const output = spawnSync(shim, ['inspect', 'two words', "a'b"], { env: { ...f.env, NODE_OPTIONS: '--invalid-option' }, encoding: 'utf8' });
    passed(output); const data = JSON.parse(output.stdout);
    assert.deepEqual(data.args, ['inspect', 'two words', "a'b"]);
    assert.ok(data.path.startsWith(path.join(f.cliRoot, old, 'runtime/bin')));
    assert.equal(data.nodeOptions, undefined);
    passed(f.run());
    assert.notEqual(readlinkSync(path.join(f.cliRoot, 'current')), old);
    assert.ok(existsSync(path.join(f.cliRoot, old)));
    f.update({ npmFail: true });
    const working = readlinkSync(path.join(f.cliRoot, 'current'));
    failed(f.run(), /npm installation failed/);
    assert.equal(readlinkSync(path.join(f.cliRoot, 'current')), working);
    assert.ok(!readdirSync(f.cliRoot).some(name => name.startsWith('.stage') || name === '.install-lock'));
    const preserved = path.join(f.home, '.mono-agent/credentials'); writeFileSync(preserved, 'fictional');
    failed(f.run(['--uninstall', '--non-interactive']), /needs --yes/);
    passed(f.run(['--uninstall', '--yes']));
    assert.ok(!existsSync(f.cliRoot)); assert.equal(readFileSync(preserved, 'utf8'), 'fictional');
  });
}
for (const [options, pattern] of [
  [{ os: 'MINGW64_NT' }, /unsupported OS/], [{ arch: 'riscv64' }, /unsupported architecture/],
  [{ os: 'Linux', musl: true }, /musl\/Alpine/], [{ root: true }, /refusing root/],
  [{ corrupt: true }, /checksum mismatch/], [{ missing: true }, /missing, duplicate or malformed/],
  [{ duplicate: true }, /missing, duplicate or malformed/], [{ downloadFail: true }, /download failed/],
  [{ badArchive: true }, /unexpected paths/], [{ runtimeFail: true }, /downloaded Node/], [{ helpFail: true }, /help check failed/],
]) test(`refusal ${JSON.stringify(options)}`, t => {
  const f = fixture(t, options); failed(f.run(), pattern);
  assert.ok(!existsSync(path.join(f.cliRoot, 'current')));
  if (existsSync(f.cliRoot)) assert.ok(!readdirSync(f.cliRoot).some(name => name.startsWith('.stage') || name === '.install-lock'));
});
for (const [args, env] of [[['--bad'], {}], [['--version', '../oops'], {}], [['--yes'], {}], [['--uninstall', '--version', 'latest'], {}], [[], { MONO_AGENT_ADD_TO_PATH: 'true' }]]) {
  test(`invalid arguments ${JSON.stringify([args, env])}`, t => {
    const f = fixture(t); assert.notEqual(f.run(args, env).status, 0);
    assert.ok(!existsSync(path.join(f.home, '.mono-agent')));
  });
}
test('flags override env and npm configuration is isolated', t => {
  const f = fixture(t);
  passed(f.run(['--version', '0.26.0', '--non-interactive', '--add-to-path'], {
    MONO_AGENT_VERSION: 'bad', MONO_AGENT_NONINTERACTIVE: 'bad', MONO_AGENT_ADD_TO_PATH: 'bad',
    NODE_OPTIONS: '--invalid-option', NODE_PATH: '/untrusted', npm_config_target: '18.0.0', npm_config_ignore_scripts: 'true',
  }));
  const env = JSON.parse(readFileSync(path.join(f.dir, 'npm-env.json')));
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.npm_config_target, undefined); assert.equal(env.npm_config_ignore_scripts, undefined);
  assert.ok(env.HOME.includes('.stage.')); assert.ok(env.PATH.startsWith(path.join(f.cliRoot, '.stage.')));
});
test('PATH opt-in is idempotent and uninstall preserves unrelated bytes', t => {
  const f = fixture(t); const rc = path.join(f.home, '.bashrc'); writeFileSync(rc, Buffer.from([35, 32, 255, 32, 120]));
  passed(f.run()); assert.deepEqual(readFileSync(rc), Buffer.from([35, 32, 255, 32, 120]));
  passed(f.run(['--add-to-path'])); const once = readFileSync(rc, 'utf8');
  passed(f.run(['--add-to-path'])); assert.equal(readFileSync(rc, 'utf8'), once);
  passed(f.run(['--uninstall', '--yes'])); assert.deepEqual(readFileSync(rc), Buffer.from([35, 32, 255, 32, 120]));
});
test('modified PATH block is refused on install, preserved on uninstall', t => {
  const f = fixture(t); passed(f.run(['--add-to-path'])); const rc = path.join(f.home, '.bashrc');
  writeFileSync(rc, readFileSync(rc, 'utf8').replace('export PATH=', 'export PATH=modified'));
  failed(f.run(['--add-to-path']), /Conflicting or modified/);
  const changed = readFileSync(rc, 'utf8'); passed(f.run(['--uninstall', '--yes'])); assert.equal(readFileSync(rc, 'utf8'), changed);
});
test('unsafe paths and ownership conflicts are never followed', t => {
  const f = fixture(t); symlinkSync(f.dir, path.join(f.home, '.mono-agent')); failed(f.run(), /unsafe directory/);
  rmSync(path.join(f.home, '.mono-agent')); mkdirSync(path.join(f.home, '.mono-agent')); mkdirSync(f.cliRoot);
  failed(f.run(), /unrecognized installation ownership/);
});
test('rc symlinks are refused', t => {
  const f = fixture(t); const other = path.join(f.dir, 'other'); writeFileSync(other, 'preserve'); symlinkSync(other, path.join(f.home, '.bashrc'));
  failed(f.run(['--add-to-path']), /Unsafe shell rc target/); assert.equal(readFileSync(other, 'utf8'), 'preserve');
});
for (const mode of ['ok', 'error', 'unexpected', 'malformed']) test(`preflight ${mode}`, t => {
  const f = fixture(t, { preflight: mode }); const result = f.run();
  if (mode === 'ok') { passed(result); assert.match(result.stdout, /Host preflight:/); }
  else { failed(result, mode === 'error' ? /Host preflight found errors/ : /Unexpected host preflight protocol/); assert.ok(existsSync(path.join(f.cliRoot, 'current'))); }
  assert.doesNotMatch(result.stderr, /unavailable in this version/);
});
test('truncated function body has no side effects', t => {
  const f = fixture(t); const partial = path.join(f.dir, 'partial.sh');
  const text = readFileSync(script, 'utf8'); writeFileSync(partial, text.slice(0, text.indexOf('  stage=$(mktemp')));
  const result = spawnSync('/bin/sh', [partial], { env: f.env }); assert.notEqual(result.status, 0);
  assert.ok(!existsSync(path.join(f.home, '.mono-agent')));
});
test('exclusive lock rejects concurrent installs and first completes', async t => {
  const f = fixture(t, { delay: true });
  const child = spawn('/bin/sh', [script], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const completion = new Promise(resolve => child.on('exit', resolve));
  for (let i = 0; i < 200 && !existsSync(path.join(f.cliRoot, '.install-lock')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  failed(f.run(), /another installer is active/);
  assert.equal(await completion, 0, output);
});

test('shim binds runtime and CLI to one generation even when current changes during resolution', t => {
  const f = fixture(t); passed(f.run()); const first = readlinkSync(path.join(f.cliRoot, 'current'));
  passed(f.run()); const second = readlinkSync(path.join(f.cliRoot, 'current'));
  rmSync(path.join(f.bin, 'readlink'));
  const actual = spawnSync('/bin/sh', ['-c', 'command -v readlink'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(f.bin, 'readlink'), `#!/bin/sh\nvalue=$(${quote(actual)} "$@")\n/bin/ln -sfn ${quote(first)} ${quote(path.join(f.cliRoot, 'current'))}\nprintf '%s\\n' "$value"\n`, { mode: 0o755 });
  const result = spawnSync(path.join(f.cliRoot, 'bin/mono-agent'), ['inspect'], { env: f.env, encoding: 'utf8' });
  passed(result); const data = JSON.parse(result.stdout);
  assert.ok(data.path.startsWith(path.join(f.cliRoot, second, 'runtime/bin')));
  assert.ok(data.file.startsWith(path.join(f.cliRoot, second, 'npm/')));
  assert.equal(readlinkSync(path.join(f.cliRoot, 'current')), first);
});
test('conflicting current and world-writable paths are refused', t => {
  const f = fixture(t); passed(f.run());
  chmodSync(f.cliRoot, 0o777); failed(f.run(), /not writable by others/); chmodSync(f.cliRoot, 0o700);
  rmSync(path.join(f.cliRoot, 'current')); symlinkSync('../outside', path.join(f.cliRoot, 'current'));
  failed(f.run(), /unsafe current target/); failed(f.run(['--uninstall', '--yes']), /unsafe current target/);
});

test('failed first install can be uninstalled without a published runtime', t => {
  const f = fixture(t, { npmFail: true }); failed(f.run(), /npm installation failed/);
  passed(f.run(['--uninstall', '--yes'])); assert.ok(!existsSync(f.cliRoot));
});

for (const tool of ['curl', 'sha256sum']) test(`missing ${tool} is refused before persistent state`, t => {
  const f = fixture(t); rmSync(path.join(f.bin, tool)); failed(f.run(), /required tool missing|sha256sum or shasum is required/);
  assert.ok(!existsSync(path.join(f.home, '.mono-agent')));
});
test('Zsh opt-in and PATH precedence warning are explicit', t => {
  const f = fixture(t); writeFileSync(path.join(f.bin, 'mono-agent'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const result = f.run(['--add-to-path'], { SHELL: '/bin/zsh' }); passed(result);
  assert.match(result.stderr, /Another mono-agent takes precedence/); assert.ok(existsSync(path.join(f.home, '.zshrc')));
  passed(f.run(['--uninstall', '--yes'])); assert.equal(readFileSync(path.join(f.home, '.zshrc'), 'utf8'), '');
});
