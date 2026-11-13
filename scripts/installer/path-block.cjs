// Shared by the generated finish/uninstall programs; no host Node required.
const fs = require('node:fs');
const path = require('node:path');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const begin = '# >>> mono-agent CLI installer >>>';
const end = '# <<< mono-agent CLI installer <<<';
function pathBlock(root, created = false) {
  return `${begin}\n${created ? '# shell file created by mono-agent CLI installer\n' : ''}export PATH=${quote(path.join(root, 'bin'))}:"$PATH"\n${end}\n`;
}
function editRc(root, shell, platform) {
  const name = { bash: platform === 'darwin' ? '.bash_profile' : '.bashrc', zsh: '.zshrc' }[path.basename(shell)];
  if (!name) {
    console.warn('Shell not supported for automatic PATH editing; use the printed export.');
    return;
  }
  editRcFile(root, name);
}
function editRcFile(root, name, remove = false) {
  const file = path.join(path.dirname(path.dirname(root)), name);
  let text = '', created = false, mode = 0o600;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
      throw new Error(`Unsafe shell rc target: ${file}`);
    }
    mode = stat.mode & 0o777;
    text = fs.readFileSync(file).toString('latin1');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (!remove) throw error;
      console.warn(`Preserved unsafe/unreadable shell rc ${file}: ${error.message}`);
      return;
    }
    if (remove) return;
    created = true;
  }
  const blocks = [false, true].map(value => Buffer.from(pathBlock(root, value), 'utf8').toString('latin1'));
  let block = blocks[created ? 1 : 0];
  const count = value => text.split(value).length - 1;
  if (count(begin) || count(end)) {
    const existing = blocks.find(value => text.includes(value));
    if (count(begin) !== 1 || count(end) !== 1 || !existing) {
      if (remove) {
        console.warn(`Preserved modified PATH block in ${file}; remove it manually.`);
        return;
      }
      throw new Error(`Conflicting or modified PATH block in ${file}; resolve it manually.`);
    }
    if (!remove) return;
    block = existing;
    text = text.replace(block, '');
    if (block === blocks[1] && text === '') {
      fs.unlinkSync(file);
      console.log(`Removed empty installer-created shell file ${file}.`);
      return;
    }
  } else if (remove) return;
  else text = block + text;
  // Exclusive temporary file avoids following symlinks. chmod restores the
  // existing mode explicitly, independent of the installer's private umask.
  // Atomic replacement preserves bytes/mode, not hard-link identity or xattrs.
  const temporary = `${file}.mono-agent-${process.pid}`;
  try {
    fs.writeFileSync(temporary, Buffer.from(text, 'latin1'), { flag: 'wx', mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log(`${remove ? 'Removed unchanged' : 'Added'} PATH block in ${file}.`);
}
