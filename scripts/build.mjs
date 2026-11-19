import {mkdir,copyFile,readFile,writeFile,readdir,cp} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {brotliCompressSync,gzipSync,constants as zlib} from 'node:zlib';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,process.env.CAMPING_DIST||'dist');
await mkdir(out,{recursive:true});
const build=await Bun.build({entrypoints:[resolve(root,'src/entry.js')],outdir:out,minify:true,target:'browser',splitting:true,naming:{entry:'entry.js',chunk:'chunks/[name]-[hash].[ext]'}});
if(!build.success){console.error(build.logs);process.exit(1);}
// expenses.css is not here: src/expenses-ui.js carries it and adopts it when the expenses tab first opens.
const css=await Promise.all(['styles.css','accounts.css','scene-motion.css','storybook-host.css'].map(file=>readFile(resolve(root,'src',file),'utf8'))).then(parts=>parts.join('\n'));
await writeFile(resolve(out,'styles.css'),css);
let html=await readFile(resolve(root,'index.html'),'utf8');
html=html.replace('./src/app.js','/entry.js').replace('./src/styles.css','/styles.css').replace('./favicon.svg','/favicon.svg');
// Resource hints. The module graph is entry.js -> shared chunks -> accounts-ui -> app, so without hints the browser
// discovers each level only after downloading the previous one: four round trips before the page can render. The
// hints let it fetch them all at once. The app chunk is hinted too: every page but login/home needs it, and the
// trip page is where people spend their time. The storybook's Latin font is hinted because the studio waits for it.
// Hinted set: the accounts-ui and app chunks plus every chunk they or entry.js import statically. Chunks used only
// by lazily loaded features (expenses, receipt AI, GIF export) are left out.
const outputText=new Map(await Promise.all(build.outputs.map(async x=>[relative(out,x.path).replaceAll('\\','/'),await readFile(x.path,'utf8')])));
const staticImports=file=>[...(outputText.get(file)||'').matchAll(/(?:^|[;\s}])import\s*(?:[^'"()]*?from\s*)?["'](\.\/[^"']+)["']/g)].map(m=>('chunks/'+m[1].replace(/^\.\//,'').replace(/^chunks\//,'')));
const roots=[...outputText.keys()].filter(p=>/^chunks\/(accounts-ui|app)-[a-z0-9]{8}\.js$/.test(p));
const preloadChunks=[];const seen=new Set();
const visit=file=>{for(const dep of staticImports(file))if(!seen.has(dep)&&outputText.has(dep)){seen.add(dep);preloadChunks.push('/'+dep);visit(dep);}};
visit('entry.js');for(const r of roots){if(!seen.has(r)){seen.add(r);preloadChunks.push('/'+r);}visit(r);}
// Fonts: the "ui" slice of the site font (every page's Latin and interface text) and the storybook's Latin font. Without
// hints the ui slice is requested only once the stylesheet has arrived and text needs it, and the page's first full
// layout then runs with the system CJK fallback font, whose first use is slow; the storybook waits for both fonts.
const uiFont=(await readdir(resolve(root,'assets/fonts'))).find(n=>/^jf-openhuninn-ui-[a-f0-9]{8}\.woff2$/.test(n));
const accentFont=(await readdir(resolve(root,'assets/storybook/fonts'))).find(n=>/^PatrickHand-[a-f0-9]{8}\.woff2$/.test(n));
const fontHint=path=>`<link rel="preload" href="${path}" as="font" type="font/woff2" crossorigin />`;
const hints=[...preloadChunks.map(p=>`<link rel="modulepreload" href="${p}" />`),...(uiFont?[fontHint('/assets/fonts/'+uiFont)]:[]),...(accentFont?[fontHint('/assets/storybook/fonts/'+accentFont)]:[])].map(h=>'    '+h).join('\n');
html=html.replace('    <link rel="stylesheet" href="/styles.css" />',`    <link rel="stylesheet" href="/styles.css" />\n${hints}`);
if(!html.includes('modulepreload'))throw new Error('build: resource hints were not inserted into index.html');
await writeFile(resolve(out,'index.html'),html);
await copyFile(resolve(root,'favicon.svg'),resolve(out,'favicon.svg'));
await cp(resolve(root,'assets'),resolve(out,'assets'),{recursive:true});
const assetPaths=[];
async function collect(dir,prefix='assets'){for(const entry of await readdir(dir,{withFileTypes:true})){const rel=prefix+'/'+entry.name;if(entry.isDirectory())await collect(resolve(dir,entry.name),rel);else assetPaths.push(rel);}}
await collect(resolve(root,'assets'));
const outputs=build.outputs.map(x=>relative(out,x.path).replaceAll('\\','/'));
const files=['index.html','styles.css','favicon.svg',...outputs,...assetPaths];
const digest=createHash('sha256');let total=0;
for(const file of files){const bytes=await readFile(resolve(out,file));digest.update(file).update(bytes);total+=bytes.length;console.log(`${file}: ${(bytes.length/1024).toFixed(1)} KB`);}
const hash=digest.digest('hex').slice(0,12);
// Precompressed copies for server/http.js, which serves them by Accept-Encoding. They live outside every
// servable path (the server's asset allowlist never matches precompressed/), so they cannot be fetched directly.
const COMPRESSIBLE=/\.(?:js|css|html|svg|ttf|otf|txt|json)$/i;
let packed=0;
for(const file of files){
 if(!COMPRESSIBLE.test(file))continue;
 const bytes=await readFile(resolve(out,file));if(bytes.length<1024)continue;
 const target=resolve(out,'precompressed',file);await mkdir(dirname(target),{recursive:true});
 // Large fonts use a lower Brotli level so the build stays fast; the ratio difference is a few percent.
 const br=brotliCompressSync(bytes,{params:{[zlib.BROTLI_PARAM_QUALITY]:bytes.length>1024*1024?7:11,[zlib.BROTLI_PARAM_SIZE_HINT]:bytes.length}});
 const gz=gzipSync(bytes,{level:9});
 await writeFile(target+'.br',br);await writeFile(target+'.gz',gz);packed+=br.length;
}
console.log(`Precompressed: ${(packed/1024).toFixed(1)} KB brotli.`);
const urls=paths=>paths.map(p=>new URL(p,'http://localhost/').pathname);
// server/http.js serves this file unchanged; there is no deployment-mode flag.
await writeFile(resolve(out,'sw.js'),`const CACHE='ggc-accounts-${hash}';
const STATIC=${JSON.stringify(urls(['index.html','styles.css','favicon.svg',...outputs]))};
const OPTIONAL=${JSON.stringify(urls(assetPaths))};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(async cache=>{await cache.addAll(STATIC);await Promise.all(OPTIONAL.map(url=>cache.add(url).catch(()=>{})));}).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>(key.startsWith('ggc-replica-')||key.startsWith('ggc-accounts-'))&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/'))return;const isStatic=[...STATIC,...OPTIONAL].includes(url.pathname);if(!isStatic&&event.request.mode!=='navigate')return;event.respondWith(fetch(event.request).catch(async()=>isStatic?await caches.match(url.pathname)||Response.error():await caches.match('/index.html')||Response.error()));});
`);
console.log(`Build passed. ${(total/1024).toFixed(1)} KB. Authenticated API responses are never cached.`);
