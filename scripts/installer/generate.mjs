import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MINIMUM_NODE_VERSION, SUPPORTED_NODE_ENGINE } from '../node-version.mjs';

const root = new URL('../../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const pin = (await read('.nvmrc')).trim();
const pkg = JSON.parse(await read('package.json'));
if (!/^\d+\.\d+\.\d+$/.test(pin) || pin !== MINIMUM_NODE_VERSION || pkg.engines.node !== SUPPORTED_NODE_ENGINE) {
  throw new Error('.nvmrc, root engines.node and scripts/node-version.mjs must agree');
}
const common = await read('scripts/installer/path-block.cjs');
const finish = common + '\n' + await read('scripts/installer/finish.cjs');
const uninstall = common + `\nconst [root] = process.argv.slice(2);\nfor (const name of ['.bashrc', '.bash_profile', '.zshrc']) { try { editRcFile(root, name, true); } catch (error) { console.warn('PATH cleanup preserved ' + name + ': ' + error.message); } }\n`;
const script = (await read('scripts/installer/install.sh.in'))
  .replace('@@NODE_VERSION@@', pin)
  .replace('@@FINISH_JS@@', () => finish.trimEnd())
  .replace('@@UNINSTALL_JS@@', () => uninstall.trimEnd());
if (/@@[A-Z_]+@@/.test(script)) throw new Error('Unexpanded installer token');
const digest = createHash('sha256').update(script).digest('hex');
for (const [name, content] of [
  ['marketing/public/install.sh', script],
  ['marketing/public/install.sh.sha256', `${digest}  install.sh\n`],
]) {
  const url = new URL(name, root);
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== content) throw new Error(`Stale generated artifact: ${name}`);
  } else await writeFile(url, content);
  console.log(`${process.argv.includes('--check') ? 'Checked' : 'Generated'} ${fileURLToPath(url).slice(fileURLToPath(root).length)}`);
}
