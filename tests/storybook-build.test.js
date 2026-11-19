import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHttpHandler, SECURITY_HEADERS } from '../server/http.js';

const out=resolve(import.meta.dir,'../dist');
const accountStub={async handle(){return null;}};
const handler=createHttpHandler({root:out,accounts:accountStub});
// Font files carry a content hash (scripts/subset-fonts.py), so look the names up instead of hardcoding them.
const fontPaths=()=>[
  ['assets/fonts',/^jf-openhuninn-common-[a-f0-9]{8}\.woff2$/],
  ['assets/storybook/fonts',/^PatrickHand-[a-f0-9]{8}\.woff2$/],
].map(([dir,pattern])=>{const name=readdirSync(join(out,dir)).find(n=>pattern.test(n));if(!name)throw Error(`no ${pattern} in dist/${dir}`);return `/${dir}/${name}`;});
const req=path=>new Request('http://127.0.0.1:5181'+path,{headers:{Host:'127.0.0.1:5181'}});

describe('built integrated storybook assets under production security headers',()=>{
  test('bundles local studio UI, stylesheet, vendor chunk, fonts and offline assets',()=>{
    if(!existsSync(join(out,'index.html')))throw Error('run bun --cwd=schedule-studio-integration/little-moments run build first');
    const css=readFileSync(join(out,'styles.css'),'utf8');
    const [mainFont,accentFont]=fontPaths();
    expect(css).toContain(mainFont);
    expect(css).toContain(accentFont);
    expect(existsSync(join(out,'assets/storybook/vendor/gifenc.js'))).toBe(true);
    expect(existsSync(join(out,mainFont))).toBe(true);
    expect(existsSync(join(out,accentFont))).toBe(true);
    expect(readdirSync(join(out,'chunks')).some(file=>file.endsWith('.js'))).toBe(true);
    const scripts=[readFileSync(join(out,'entry.js'),'utf8'),...readdirSync(join(out,'chunks')).filter(f=>f.endsWith('.js')).map(f=>readFileSync(join(out,'chunks',f),'utf8'))].join('\n');
    expect(scripts).toContain('Storybook Trip Studio');
    expect(scripts).toContain('下載 PNG');
    expect(scripts).not.toMatch(/new Worker\(\s*URL\.createObjectURL/);
    const sw=readFileSync(join(out,'sw.js'),'utf8');
    const gifChunk=readdirSync(join(out,'chunks')).find(file=>/^gifenc-.*\.js$/.test(file));
    expect(gifChunk).toBeDefined();
    expect(sw).toContain('/chunks/'+gifChunk);
  });

  test('production handler serves required fonts and GIF library on same origin under strict CSP',async()=>{
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("script-src 'self'");
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("worker-src 'self'");
    for(const path of [...fontPaths(),'/assets/storybook/vendor/gifenc.js']){
      const response=await handler(req(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(SECURITY_HEADERS['Content-Security-Policy']);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
  });
});
