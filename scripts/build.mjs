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
const modules=resolve(root,'node_modules'),ocrOut=resolve(out,'assets/ocr');
const pinned={'tesseract.js':'7.0.0','tesseract.js-core':'7.0.0','@tesseract.js-data/chi_tra':'1.0.0','@tesseract.js-data/eng':'1.0.0'};
for(const [name,version] of Object.entries(pinned)){const actual=JSON.parse(await readFile(resolve(modules,name,'package.json'),'utf8')).version;if(actual!==version){console.error(`OCR dependency ${name} is ${actual}, expected ${version}.`);process.exit(1);}}
const ocrCopies=[
 ['tesseract.js/dist/worker.min.js','worker.min.js'],
 ...['lstm','simd-lstm','relaxedsimd-lstm'].map(v=>[`tesseract.js-core/tesseract-core-${v}.wasm.js`,`core/tesseract-core-${v}.wasm.js`]),
 ...['chi_tra','eng'].map(l=>[`@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`,`lang/${l}.traineddata.gz`]),
 ['tesseract.js/LICENSE.md','licenses/tesseract.js-LICENSE.md'],
 ['tesseract.js/dist/worker.min.js.LICENSE.txt','licenses/tesseract.js-worker-bundled-LICENSES.txt'],
 ['tesseract.js-core/LICENSE','licenses/tesseract.js-core-LICENSE'],
 ['wasm-feature-detect/LICENSE','licenses/wasm-feature-detect-LICENSE'],
 ['@tesseract.js-data/chi_tra/package.json','licenses/tesseract.js-data-chi_tra-package.json'],
 ['@tesseract.js-data/eng/package.json','licenses/tesseract.js-data-eng-package.json'],
];
await mkdir(ocrOut,{recursive:true});
const ocrPaths=[];
for(const [from,to] of ocrCopies){await mkdir(dirname(resolve(ocrOut,to)),{recursive:true});await copyFile(resolve(modules,from),resolve(ocrOut,to));ocrPaths.push('assets/ocr/'+to);}
await writeFile(resolve(ocrOut,'licenses/NOTICE.txt'),`Receipt OCR runs entirely in the browser from these same-origin files.
tesseract.js ${pinned['tesseract.js']} (Apache-2.0) - worker.min.js
tesseract.js-core ${pinned['tesseract.js-core']} (Apache-2.0; Tesseract OCR, Apache-2.0) - core/*.wasm.js (LSTM-only builds with embedded WebAssembly)
@tesseract.js-data/chi_tra and @tesseract.js-data/eng ${pinned['@tesseract.js-data/eng']} (package license MIT; data from tesseract-ocr tessdata_best integerized models, Apache-2.0) - lang/*.traineddata.gz
wasm-feature-detect (Apache-2.0) and other components bundled in worker.min.js are listed in tesseract.js-worker-bundled-LICENSES.txt
`);
ocrPaths.push('assets/ocr/licenses/NOTICE.txt');
let ocrTotal=0;for(const file of ocrPaths){const size=(await readFile(resolve(out,file))).length;ocrTotal+=size;console.log(`${file}: ${(size/1024).toFixed(1)} KB (runtime only, not precached)`);}
console.log(`OCR assets: ${(ocrTotal/1024/1024).toFixed(2)} MB, fetched on demand; one core variant (~3.8 MB) plus both languages (~4.4 MB) per recognition.`);
const outputs=build.outputs.map(x=>relative(out,x.path).replaceAll('\\','/'));
const files=['index.html','styles.css','favicon.svg',...outputs,...assetPaths];
const digest=createHash('sha256');let total=0;
for(const file of files){const bytes=await readFile(resolve(out,file));digest.update(file).update(bytes);total+=bytes.length;console.log(`${file}: ${(bytes.length/1024).toFixed(1)} KB`);}
const hash=digest.digest('hex').slice(0,12);
const urls=paths=>paths.map(p=>new URL(p,'http://localhost/').pathname);
await writeFile(resolve(out,'sw.js'),`const CACHE='ggc-accounts-${hash}';
const STATIC=${JSON.stringify(urls(['index.html','styles.css','favicon.svg',...outputs]))};
const OPTIONAL=${JSON.stringify(urls(assetPaths))};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(async cache=>{await cache.addAll(STATIC);await Promise.all(OPTIONAL.map(url=>cache.add(url).catch(()=>{})));}).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>(key.startsWith('ggc-replica-')||key.startsWith('ggc-accounts-'))&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/'))return;const isStatic=[...STATIC,...OPTIONAL].includes(url.pathname);if(!isStatic&&event.request.mode!=='navigate')return;event.respondWith(fetch(event.request).catch(async()=>isStatic?await caches.match(url.pathname)||Response.error():await caches.match('/index.html')||Response.error()));});
`);
console.log(`Build passed. ${(total/1024).toFixed(1)} KB. Authenticated API responses are never cached.`);
