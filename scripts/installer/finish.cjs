const { spawnSync } = require('node:child_process');
const [root, staged, nodeVersion, platform, arch, archiveSha256, addPath, shell] = process.argv.slice(2);
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(staged, 'npm/lib/node_modules/create-mono-agent/package.json'), 'utf8'));
  const generation = `gen-${Date.now()}-${process.pid}`;
  const release = path.join(root, 'releases', generation);
  fs.writeFileSync(path.join(staged, 'install.json'), JSON.stringify({
    schemaVersion: 1, installer: 'mono-agent-cli-installer-v1',
    cliVersion: pkg.version, nodeVersion, nodeAbi: process.versions.modules,
    platform, arch, archiveSha256,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(staged, release);
  const shim = `#!/bin/sh
set -eu
root=${quote(root)}
if ! generation=$(readlink "$root/current"); then echo 'No mono-agent generation found' >&2; exit 1; fi
case $generation in releases/gen-*) ;; *) echo 'Invalid mono-agent generation' >&2; exit 1 ;; esac
case $generation in *..*|releases/*/*) echo 'Unsafe mono-agent generation' >&2; exit 1 ;; esac
runtime=$root/$generation/runtime
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
exec "$runtime/bin/node" "$root/$generation/npm/bin/mono-agent" "$@"
`;
  const shimTemp = path.join(root, 'bin', `.mono-agent-${process.pid}`);
  fs.writeFileSync(shimTemp, shim, { flag: 'wx', mode: 0o700 });
  fs.renameSync(shimTemp, path.join(root, 'bin', 'mono-agent'));
  const link = path.join(root, `.current-${process.pid}`);
  fs.symlinkSync(`releases/${generation}`, link);
  const current = path.join(root, 'current');
  const previous = fs.existsSync(current) ? fs.readlinkSync(current) : undefined;
  fs.renameSync(link, current);
  // Do not leave an activation block pointing at an unpublished first install.
  if (addPath === '1') editRc(root, shell, platform);
  // Only successful publications prune. A failed scan preserves everything;
  // references and current are rechecked before each deletion.
  try {
    const files = fs.readFileSync(path.join(root, '.install-lock/service-references'), 'utf8').split('\n').filter(Boolean);
    for (const entry of fs.readdirSync(path.join(root, 'releases'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^gen-\d+-\d+$/.test(entry.name)) continue;
      const relative = `releases/${entry.name}`;
      const absolute = path.join(root, relative);
      if (relative === previous || relative === fs.readlinkSync(current)
        || files.some(file => fs.readFileSync(file, 'utf8').includes(absolute))) continue;
      // Do not follow symlinks, including a replaced generation directory.
      if (fs.lstatSync(absolute).isSymbolicLink() || relative === fs.readlinkSync(current)) continue;
      fs.rmSync(absolute, { recursive: true });
    }
  } catch (error) {
    console.warn(`Old generation pruning skipped/incomplete: ${error.message}`);
  }
  console.log(`Installed mono-agent ${pkg.version} with private Node ${nodeVersion} (ABI ${process.versions.modules}).`);
  console.log(`CLI: ${quote(path.join(root, 'bin/mono-agent'))}`);
  console.log(`Activate in this shell: export PATH=${quote(path.join(root, 'bin'))}:"$PATH"`);
  console.log('Existing shells are unchanged. Re-run this installer to upgrade; current + previous generations are retained, plus service-referenced generations.');
  const lookup = spawnSync('/bin/sh', ['-c', 'command -v mono-agent'], { encoding: 'utf8', timeout: 3000 });
  const expected = path.join(root, 'bin/mono-agent');
  if (lookup.stdout?.trim() !== expected) {
    console.warn(lookup.stdout?.trim()
      ? `Another mono-agent takes precedence: ${lookup.stdout.trim()}. Use the absolute CLI path or activate PATH above.`
      : 'mono-agent is installed but not yet on PATH.');
  }
  console.log(`Next: ${quote(expected)} init`);
  const probe = spawnSync(expected, ['preflight', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 256 * 1024,
  });
  if (probe.error || probe.signal) throw new Error(`Host preflight execution failed: ${probe.error?.message ?? probe.signal}`);
  let result;
  try { result = JSON.parse(probe.stdout); } catch { /* legacy errors are text */ }
  if (result?.operation === 'host-preflight' && result.schemaVersion === 1) {
    if (typeof result.ok !== 'boolean' || !Array.isArray(result.checks)
      || !result.checks.every(check => typeof check.id === 'string'
        && ['ok', 'info', 'warning', 'error'].includes(check.status) && typeof check.message === 'string')
      || probe.status !== (result.ok ? 0 : 1)
      || result.ok !== !result.checks.some(check => check.status === 'error')) {
      throw new Error('Invalid host preflight response or exit status');
    }
    console.log('Host preflight:');
    for (const check of result.checks.slice(0, 30)) {
      console.log(`  ${check.status}: ${check.id}: ${check.message.slice(0, 500)}`);
      if (Array.isArray(check.remediations)) {
        for (const item of check.remediations.slice(0, 3)) console.log(`    ${String(item).slice(0, 500)}`);
      }
    }
    if (!result.ok) throw new Error('Host preflight found errors. Resolve the checks above and run mono-agent preflight again.');
  } else if (probe.status !== 0 && /Unknown command [`'"]?preflight[`'"]?[.\s]/i.test(`${probe.stdout}\n${probe.stderr}`)) {
    console.warn('Warning: host preflight unavailable in this version. CLI installation verified; host readiness is not established.');
  } else {
    throw new Error(`Unexpected host preflight protocol (exit ${probe.status}): ${`${probe.stderr}\n${probe.stdout}`.trim().slice(0, 1200)}`);
  }
} catch (error) {
  console.error(`mono-agent installer: ${error.message}. If published, the CLI remains installed; no services were started.`);
  process.exitCode = 1;
}
