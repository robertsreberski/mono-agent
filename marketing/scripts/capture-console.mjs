// Real App/Composer/Messages with synthetic API and event data, never a live console.
// Reuse the source-owned model-marker assertions. Temporary fixtures are removed.
import {readFile, writeFile, unlink, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import sharp from 'sharp';
const marketing = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(marketing, '../packages/web/webapp');
const output = resolve(marketing, 'output/console-capture');
const fixture = resolve(web, 'src/MarketingCapture.browser.test.tsx');
const config = resolve(web, 'vitest.marketing-capture.config.ts');
let createdFixture = false, createdConfig = false;
try {
  await mkdir(output,{recursive:true});
  let source = await readFile(resolve(web,'src/ModelMarkers.browser.test.tsx'),'utf8');
  const anchor = 'beforeEach(async () => {';
  if (!source.includes(anchor)) throw Error('Source fixture changed; review capture recipe.');
  source = source.replace(anchor, `class MarketingEvents extends EventTarget {
    readyState = 1;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
    close() { this.readyState = 2; }
  }
  beforeEach(async () => {
    vi.stubGlobal('EventSource', MarketingEvents);`);
  source = source.replace('afterEach(async () => {','afterEach(async () => { vi.unstubAllGlobals();');
  // This is explicitly a designed example conversation, not a measured agent run.
  for (const [from,to] of [
    ['label: "Alpha"','label: "Mono"'],
    ['Release note for the console','Investigate the retry regression'],
    ['Draft the release note for the console.','Find why the retry test fails. Explain the cause before proposing a fix.'],
    ['Here is a first pass at the release note.','The test starts a second request before the first connection has closed. I would isolate that ordering before changing the retry logic.'],
    ['Try that again, with more care about the wording.','Review that explanation with a second model. What should we verify next?'],
    ['Reworked, with the tone tightened throughout.','Check the connection-close event, then rerun the focused case. Keep the production change separate from any test synchronization fix.'],
  ]) source = source.replaceAll(from,to);
  await writeFile(fixture,source,{flag:'wx'}); createdFixture=true;
  await writeFile(config,`import config from './vitest.browser.config';
const browser = config.test!.browser!;
browser.instances = [{ ...browser.instances![0], context: { viewport: { width:1280, height:900 }, deviceScaleFactor:1.5 } }];
export default config;\n`,{flag:'wx'}); createdConfig=true;
  const result=spawnSync('pnpm',['exec','vitest','run','--config','vitest.marketing-capture.config.ts','src/MarketingCapture.browser.test.tsx'],{cwd:web,stdio:'inherit',env:{...process.env,VITE_MODEL_MARKER_SHOTS:output}});
  if(result.error) throw result.error;
  if(result.status!==0) throw Error(`Console fixture failed (${result.status})`);
  await sharp(resolve(output,'transcript-desktop-dark-1280x900.png')).webp({lossless:true}).toFile(resolve(marketing,'public/console-desktop.webp'));
} finally {
  if(createdFixture) await unlink(fixture);
  if(createdConfig) await unlink(config);
}
