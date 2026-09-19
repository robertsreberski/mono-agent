// Rebuild committed derivatives from one transparent source sculpture.
// Local sources are gitignored; production builds consume committed assets only.
// Place sculpture.png in marketing/assets-source/, then pnpm run assets.
import {mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(root,'assets-source/sculpture.png');
const out=join(root,'public');
await mkdir(out,{recursive:true});
for(const width of [640,960,1440]) {
  await sharp(source).resize({width}).webp({quality:80,alphaQuality:100}).toFile(join(out,`hero-${width}.webp`));
}
// Mobile crop removes empty side margins, not the subject. The sculpture is
// entirely inside this centered 1024px square in the 1536x1024 source.
for(const width of [320,640]) {
  await sharp(source).extract({left:256,top:0,width:1024,height:1024})
    .resize({width}).webp({quality:76,alphaQuality:100}).toFile(join(out,`hero-mobile-${width}.webp`));
}
const sculpture=await sharp(source).resize({width:840}).toBuffer();
const text=Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
<text x="68" y="210" font-family="Verdana,sans-serif" font-size="18" fill="#d2f390">INDEPENDENT BY DESIGN</text>
<text x="62" y="310" font-family="Georgia,serif" font-size="80" fill="#eceee5">mono-agent</text>
<text x="66" y="386" font-family="Verdana,sans-serif" font-size="24" fill="#d2f390">Local-first AI workspace</text>
<text x="66" y="430" font-family="Verdana,sans-serif" font-size="24" fill="#afb5a9">for coding and research</text>
</svg>`);
await sharp({create:{width:1200,height:630,channels:3,background:'#101211'}})
  .composite([{input:sculpture,left:355,top:35},{input:text,left:0,top:0}])
  .jpeg({quality:84,mozjpeg:true}).toFile(join(out,'og-1200x630.jpg'));
console.log('Generated alpha-preserving responsive hero assets and the social card.');
