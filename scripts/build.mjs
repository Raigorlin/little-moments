import {mkdir,copyFile,readFile,writeFile,readdir,cp} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,process.env.CAMPING_DIST||'dist');
await mkdir(out,{recursive:true});
const build=await Bun.build({entrypoints:[resolve(root,'src/entry.js')],outdir:out,minify:true,target:'browser',splitting:true,naming:{entry:'entry.js',chunk:'chunks/[name]-[hash].[ext]'}});
if(!build.success){console.error(build.logs);process.exit(1);}
const css=await Promise.all(['styles.css','accounts.css','scene-motion.css','expenses.css'].map(file=>readFile(resolve(root,'src',file),'utf8'))).then(parts=>parts.join('\n'));
await writeFile(resolve(out,'styles.css'),css);
let html=await readFile(resolve(root,'index.html'),'utf8');
html=html.replace('./src/app.js','/entry.js').replace('./src/styles.css','/styles.css').replace('./favicon.svg','/favicon.svg');
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
const urls=paths=>paths.map(p=>new URL(p,'http://localhost/').pathname);
// server/http.js swResponse rewrites this exact literal to `const PUBLISHED=true;` in Published_Mode.
await writeFile(resolve(out,'sw.js'),`const PUBLISHED=false;
const CACHE='ggc-accounts-${hash}'+(PUBLISHED?'-p':'');
const STATIC=${JSON.stringify(urls(['index.html','styles.css','favicon.svg',...outputs]))};
const OPTIONAL=${JSON.stringify(urls(assetPaths))};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(async cache=>{await cache.addAll(STATIC);await Promise.all(OPTIONAL.map(url=>cache.add(url).catch(()=>{})));}).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>(key.startsWith('ggc-replica-')||key.startsWith('ggc-accounts-'))&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/'))return;const isStatic=[...STATIC,...OPTIONAL].includes(url.pathname);if(!isStatic&&event.request.mode!=='navigate')return;if(PUBLISHED&&event.request.mode==='navigate'&&/^\\/demo(?:\\/|$)/.test(url.pathname))return;event.respondWith(fetch(event.request).catch(async()=>isStatic?await caches.match(url.pathname)||Response.error():await caches.match('/index.html')||Response.error()));});
`);
console.log(`Build passed. ${(total/1024).toFixed(1)} KB. Authenticated API responses are never cached.`);
