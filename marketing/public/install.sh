#!/bin/sh
# Generated from scripts/installer/install.sh.in. Inspect before running.
# All work is deferred until the complete script has been received.
mono_agent_install() (
  set -eu
  umask 077
  node_version='24.15.0'
  version=${MONO_AGENT_VERSION-latest}
  noninteractive=${MONO_AGENT_NONINTERACTIVE-0}
  add_path=${MONO_AGENT_ADD_TO_PATH-0}
  uninstall=0 yes=0 version_flag=0
  die() { printf 'mono-agent installer: %s\n' "$*" >&2; exit 1; }
  usage() {
    cat <<'HELP'
Usage: install.sh [--version latest|X.Y.Z] [--non-interactive] [--add-to-path]
       install.sh --uninstall [--yes] [--non-interactive]
Installs official private Node and published create-mono-agent in ~/.mono-agent/cli.
Re-run to upgrade. No sudo, service changes, or shell edits by default.
Environment: MONO_AGENT_VERSION, MONO_AGENT_NONINTERACTIVE=0|1,
MONO_AGENT_ADD_TO_PATH=0|1. Flags override their corresponding environment values.
HELP
  }
  while [ "$#" -gt 0 ]; do
    case $1 in
      --help|-h) usage; exit 0 ;;
      --version) [ "$#" -ge 2 ] || die '--version needs a value'; version=$2; version_flag=1; shift ;;
      --non-interactive) noninteractive=1 ;;
      --add-to-path) add_path=1 ;;
      --uninstall) uninstall=1 ;;
      --yes) yes=1 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  case $noninteractive:$add_path in 0:0|0:1|1:0|1:1) ;; *) die 'boolean environment values must be 0 or 1' ;; esac
  case $version in latest) ;; *)
    printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$' || die 'version must be latest or an exact version' ;;
  esac
  [ "$uninstall:$yes" != '0:1' ] || die '--yes is only valid with --uninstall'
  if [ "$uninstall" = 1 ]; then
    [ "$version_flag:$add_path" = '0:0' ] && [ "${MONO_AGENT_VERSION+x}" != x ] || die '--uninstall cannot select a version or add PATH'
  fi
  [ -n "${HOME-}" ] && [ -d "$HOME" ] || die 'HOME must be an existing absolute directory'
  case $HOME in /*) ;; *) die 'HOME must be absolute' ;; esac
  case $HOME in *'
'*) die 'HOME must not contain newlines' ;; esac
  for tool in id uname ls awk grep sed mkdir rmdir rm mv cat chmod dirname readlink env; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool"
  done
  uid=$(id -u)
  [ "$uid" != 0 ] || die 'refusing root; run as your normal user without sudo'
  # Accept owner-owned directories with no group/other writes; never follow a
  # conflicting managed symlink. HOME itself may use a platform canonical alias.
  safe_dir() {
    [ -d "$1" ] && [ ! -L "$1" ] || die "unsafe directory: $1"
    # Numeric metadata only; filenames are not parsed (HOME newlines rejected).
    # shellcheck disable=SC2012
    ls -nd "$1" | awk -v uid="$uid" 'NR==1 {exit !($3==uid && substr($1,6,1)!="w" && substr($1,9,1)!="w")}' || die "directory must be owned by you and not writable by others: $1"
  }
  home=$(CDPATH='' cd -P "$HOME" && pwd -P)
  case $home in *:*) die 'HOME must not contain colons (PATH cannot represent this directory)' ;; esac
  safe_dir "$home"
  parent=$home/.mono-agent
  root=$parent/cli
  marker='mono-agent-cli-installer-v1'
  [ ! -e "$parent" ] && [ ! -L "$parent" ] || safe_dir "$parent"
  if [ -e "$root" ] || [ -L "$root" ]; then
    safe_dir "$root"
    [ -f "$root/.installer-owned" ] && [ ! -L "$root/.installer-owned" ] && [ "$(cat "$root/.installer-owned")" = "$marker" ] || die 'unrecognized installation ownership; refusing to modify it'
    # shellcheck disable=SC2012
    ls -nd "$root" | awk 'NR==1 {exit !(substr($1,5,6)=="------")}' || die 'CLI directory must be owner-private; inspect it before chmod 700'
    for dir in bin releases cache; do safe_dir "$root/$dir"; done
    [ ! -e "$root/bin/mono-agent" ] || [ ! -L "$root/bin/mono-agent" ] || die 'unsafe shim symlink'
    if [ -e "$root/current" ] || [ -L "$root/current" ]; then
      [ -L "$root/current" ] || die 'current must be an installer generation symlink'
      target=$(readlink "$root/current")
      case $target in releases/gen-*) ;; *) die 'unsafe current target' ;; esac
      case $target in *..*|releases/*/*) die 'unsafe current target' ;; esac
      safe_dir "$root/$target"
    fi
  elif [ "$uninstall" = 1 ]; then
    printf 'No installer-owned CLI found. Nothing removed.\n'; exit 0
  fi
  if [ "$uninstall" = 1 ] && [ "$yes" != 1 ]; then
    [ "$noninteractive" != 1 ] && [ -t 0 ] || die 'uninstall needs --yes in non-interactive mode'
    printf 'Remove only %s? [y/N] ' "$root"
    read -r answer
    case $answer in y|Y|yes) ;; *) die 'uninstall cancelled' ;; esac
  fi
  if [ "$uninstall" != 1 ]; then
    for tool in curl tar gzip mktemp; do command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool"; done
    if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
    elif command -v shasum >/dev/null 2>&1; then checksum=shasum
    else die 'sha256sum or shasum is required'; fi
    platform=$(uname -s)
    case $platform in
      Darwin) platform=darwin ;;
      Linux)
        platform=linux
        # Both missing getconf and a failed libc query must refuse the host.
        # shellcheck disable=SC2015
        command -v getconf >/dev/null 2>&1 && libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || die 'Linux requires glibc; musl/Alpine is unsupported. Use a compatible host or manage Node/npm yourself.'
        printf '%s\n' "$libc" | awk '$1=="glibc" {split($2,v,"."); ok=(v[1]>2 || (v[1]==2 && v[2]>=28))} END {exit !ok}' || die 'official Node requires glibc >=2.28' ;;
      *) die "unsupported OS: $platform; manage a supported Node/npm installation manually (Windows: use npm)" ;;
    esac
    arch=$(uname -m)
    case $arch in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported architecture: $arch; manage Node/npm manually" ;; esac
  fi
  mkdir -p "$parent"
  if [ ! -e "$root" ]; then
    mkdir "$root"
    printf '%s\n' "$marker" > "$root/.installer-owned"
    mkdir "$root/bin" "$root/releases" "$root/cache"
  fi
  lock=$root/.install-lock
  mkdir "$lock" 2>/dev/null || die 'another installer is active (or a stale .install-lock needs manual inspection)'
  stage=''
  # Invoked by the exit trap.
  # shellcheck disable=SC2329
  cleanup() { [ -z "$stage" ] || rm -rf "$stage"; rmdir "$lock"; }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
  if [ "$uninstall" = 1 ]; then
    if [ -L "$root/current" ]; then
      target=$(readlink "$root/current")
      "$root/$target/runtime/bin/node" --input-type=commonjs - "$root" <<'UNINSTALL'
// Shared by the generated finish/uninstall programs; no host Node required.
const fs = require('node:fs');
const path = require('node:path');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const begin = '# >>> mono-agent CLI installer >>>';
const end = '# <<< mono-agent CLI installer <<<';
function pathBlock(root) {
  return `${begin}\nexport PATH=${quote(path.join(root, 'bin'))}:"$PATH"\n${end}\n`;
}
function editRc(root, shell, remove = false) {
  const name = { bash: '.bashrc', zsh: '.zshrc' }[path.basename(shell)];
  if (!name) {
    if (!remove) console.warn('Shell not supported for automatic PATH editing; use the printed export.');
    return;
  }
  const file = path.join(path.dirname(path.dirname(root)), name);
  let text = '';
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
      throw new Error(`Unsafe shell rc target: ${file}`);
    }
    text = fs.readFileSync(file).toString('latin1');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (remove) return;
  }
  const block = Buffer.from(pathBlock(root), 'utf8').toString('latin1');
  const count = value => text.split(value).length - 1;
  if (count(begin) || count(end)) {
    if (count(begin) !== 1 || count(end) !== 1 || !text.includes(block)) {
      if (remove) {
        console.warn(`Preserved modified PATH block in ${file}; remove it manually.`);
        return;
      }
      throw new Error(`Conflicting or modified PATH block in ${file}; resolve it manually.`);
    }
    if (!remove) return;
    text = text.replace(block, '');
  } else if (remove) return;
  else text = block + text;
  // Preserve existing mode; exclusive temporary file avoids following symlinks.
  const temporary = `${file}.mono-agent-${process.pid}`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  try {
    fs.writeFileSync(temporary, Buffer.from(text, 'latin1'), { flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log(`${remove ? 'Removed unchanged' : 'Added'} PATH block in ${file}.`);
}

const [root] = process.argv.slice(2);
for (const shell of ['bash', 'zsh']) editRc(root, shell, true);
UNINSTALL
    else
      printf 'No published generation; any shell PATH blocks are preserved for manual inspection.\n'
    fi
    rmdir "$lock"
    trap - EXIT
    # rm does not follow directory symlinks; validated root is fixed under HOME.
    rm -rf "$root"
    printf 'Removed installer-owned CLI only. Projects, credentials, runtimes and services were not changed.\n'
    exit 0
  fi
  stage=$(mktemp -d "$root/.stage.XXXXXXXX")
  archive=node-v$node_version-$platform-$arch.tar.gz
  base=https://nodejs.org/dist/v$node_version
  fetch() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fSL --retry 2 --connect-timeout 20 --max-time 300 "$1" -o "$2"; }
  printf 'Downloading official Node %s (%s/%s)...\n' "$node_version" "$platform" "$arch"
  fetch "$base/SHASUMS256.txt" "$stage/SHASUMS256.txt" || die 'Node checksums download failed'
  fetch "$base/$archive" "$stage/$archive" || die 'Node download failed'
  digest=$(awk -v file="$archive" '$2==file {n++; hash=$1} END {if(n!=1 || length(hash)!=64 || hash ~ /[^0-9a-f]/) exit 1; print hash}' "$stage/SHASUMS256.txt") || die 'missing, duplicate or malformed Node checksum'
  if [ "$checksum" = sha256sum ]; then actual=$(sha256sum "$stage/$archive"); else actual=$(shasum -a 256 "$stage/$archive"); fi
  actual=${actual%% *}
  [ "$actual" = "$digest" ] || die 'Node archive checksum mismatch'
  top=node-v$node_version-$platform-$arch
  tar -tzf "$stage/$archive" > "$stage/entries" || die 'invalid Node archive'
  awk -v top="$top" 'index($0,top "/")!=1 || $0 ~ /(^|\/)\.\.(\/|$)/ {bad=1} END {exit bad}' "$stage/entries" || die 'unexpected paths in Node archive'
  # Official digest authenticates archive contents within the nodejs.org TLS
  # boundary. Only extract after checksum and member-path validation.
  mkdir "$stage/release"
  tar -xzf "$stage/$archive" -C "$stage/release" || die 'Node extraction failed'
  mv "$stage/release/$top" "$stage/release/runtime"
  runtime=$stage/release/runtime
  unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
  [ "$("$runtime/bin/node" --version)" = "v$node_version" ] || die 'downloaded Node could not execute; check host libraries and OS support'
  mkdir "$stage/npm-home" "$stage/work"
  : > "$stage/user.npmrc"
  : > "$stage/global.npmrc"
  printf 'Installing create-mono-agent@%s using private Node...\n' "$version"
  (
    cd "$stage/work"
    env -i HOME="$stage/npm-home" PATH="$runtime/bin:$PATH" \
      HTTPS_PROXY="${HTTPS_PROXY-${https_proxy-}}" HTTP_PROXY="${HTTP_PROXY-${http_proxy-}}" \
      ALL_PROXY="${ALL_PROXY-${all_proxy-}}" NO_PROXY="${NO_PROXY-${no_proxy-}}" \
      SSL_CERT_FILE="${SSL_CERT_FILE-}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS-}" \
      "$runtime/bin/node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" install --global \
      --prefix "$stage/release/npm" --cache "$root/cache" --userconfig "$stage/user.npmrc" --globalconfig "$stage/global.npmrc" \
      --registry https://registry.npmjs.org --ignore-scripts=false --audit=false --fund=false --update-notifier=false \
      "create-mono-agent@$version" < /dev/null
  ) || die 'npm installation failed; existing generation preserved. Native builds may need a compiler/system libraries; no system packages were installed.'
  cli=$stage/release/npm/bin/mono-agent
  "$runtime/bin/node" "$cli" --version || die 'staged CLI version check failed'
  "$runtime/bin/node" "$cli" --help > "$stage/help.txt" || die 'staged CLI help check failed'
  "$runtime/bin/node" --input-type=commonjs - "$root" "$stage/release" "$node_version" "$platform" "$arch" "$digest" "$add_path" "${SHELL-}" <<'FINISH'
// Shared by the generated finish/uninstall programs; no host Node required.
const fs = require('node:fs');
const path = require('node:path');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const begin = '# >>> mono-agent CLI installer >>>';
const end = '# <<< mono-agent CLI installer <<<';
function pathBlock(root) {
  return `${begin}\nexport PATH=${quote(path.join(root, 'bin'))}:"$PATH"\n${end}\n`;
}
function editRc(root, shell, remove = false) {
  const name = { bash: '.bashrc', zsh: '.zshrc' }[path.basename(shell)];
  if (!name) {
    if (!remove) console.warn('Shell not supported for automatic PATH editing; use the printed export.');
    return;
  }
  const file = path.join(path.dirname(path.dirname(root)), name);
  let text = '';
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
      throw new Error(`Unsafe shell rc target: ${file}`);
    }
    text = fs.readFileSync(file).toString('latin1');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (remove) return;
  }
  const block = Buffer.from(pathBlock(root), 'utf8').toString('latin1');
  const count = value => text.split(value).length - 1;
  if (count(begin) || count(end)) {
    if (count(begin) !== 1 || count(end) !== 1 || !text.includes(block)) {
      if (remove) {
        console.warn(`Preserved modified PATH block in ${file}; remove it manually.`);
        return;
      }
      throw new Error(`Conflicting or modified PATH block in ${file}; resolve it manually.`);
    }
    if (!remove) return;
    text = text.replace(block, '');
  } else if (remove) return;
  else text = block + text;
  // Preserve existing mode; exclusive temporary file avoids following symlinks.
  const temporary = `${file}.mono-agent-${process.pid}`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  try {
    fs.writeFileSync(temporary, Buffer.from(text, 'latin1'), { flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log(`${remove ? 'Removed unchanged' : 'Added'} PATH block in ${file}.`);
}

const { spawnSync } = require('node:child_process');
const [root, staged, nodeVersion, platform, arch, archiveSha256, addPath, shell] = process.argv.slice(2);
try {
  // Check opt-in rc safety before publishing; no generation is switched on error.
  if (addPath === '1') editRc(root, shell);
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
root=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd -P)
generation=$(readlink "$root/current")
case $generation in releases/gen-*) ;; *) echo 'Invalid mono-agent generation' >&2; exit 1 ;; esac
case $generation in *..*|releases/*/*) echo 'Unsafe mono-agent generation' >&2; exit 1 ;; esac
runtime=$root/$generation/runtime
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
PATH="$runtime/bin:$PATH"
export PATH
exec "$runtime/bin/node" "$root/$generation/npm/bin/mono-agent" "$@"
`;
  const shimTemp = path.join(root, 'bin', `.mono-agent-${process.pid}`);
  fs.writeFileSync(shimTemp, shim, { flag: 'wx', mode: 0o700 });
  fs.renameSync(shimTemp, path.join(root, 'bin', 'mono-agent'));
  const link = path.join(root, `.current-${process.pid}`);
  fs.symlinkSync(`releases/${generation}`, link);
  fs.renameSync(link, path.join(root, 'current'));
  console.log(`Installed mono-agent ${pkg.version} with private Node ${nodeVersion} (ABI ${process.versions.modules}).`);
  console.log(`CLI: ${quote(path.join(root, 'bin/mono-agent'))}`);
  console.log(`Activate in this shell: export PATH=${quote(path.join(root, 'bin'))}:"$PATH"`);
  console.log('Existing shells are unchanged. Re-run this installer to upgrade; old generations are retained.');
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
FINISH
)

# Keep this as the last statement: truncated function bodies perform no work.
mono_agent_install "$@"
