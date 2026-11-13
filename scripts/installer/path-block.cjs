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
