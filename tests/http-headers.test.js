// Feature: jenkins-cicd-deploy, Property 15: 所有回應皆帶安全標頭
// **Validates: Requirements 10.6**
import {test,expect} from 'bun:test';
import fc from 'fast-check';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {createHttpHandler,SECURITY_HEADERS} from '../server/http.js';

const root=resolve(import.meta.dir,'..',process.env.CAMPING_DIST||'dist');
if(!existsSync(resolve(root,'index.html')))throw new Error(`靜態根目錄 ${root} 缺少 index.html，請先執行 bun run build`);

// 靜態資源（非 index.html）唯一允許的差異：Cache-Control: no-cache
const STATIC_ASSETS=['/entry.js','/styles.css','/favicon.svg','/sw.js','/assets/fonts/OFL.txt','/assets/fonts/SOURCE.txt','/assets/ocr/worker.min.js'];
const isStaticAsset=p=>STATIC_ASSETS.includes(p)||/^\/(?:app\.js|chunks\/[a-zA-Z0-9_.-]+\.js)$/.test(p);

const pathArb=fc.oneof(
 fc.constantFrom('/','/demo/','/setup','/login','/register/','/admin','/ena/home','/ena/trips/abc-123/go','/invite/'+'a'.repeat(32),'/index.html'),
 fc.constantFrom(...STATIC_ASSETS,'/chunks/missing.js','/app.js'),
 fc.constantFrom('/api/session','/api/trips','/api/login','/api/setup','/api/admin/users','/healthz'),
 fc.constantFrom('/../data/accounts.sqlite','/%2e%2e%2fdata/accounts.sqlite','/assets/..%5c..%5cdata/accounts.sqlite','/assets/%2e%2e/%2e%2e/server/accounts.js','/%zz','/%','/data/accounts.sqlite','/server/http.js','/README.md','/.env','/not-a-page'),
 fc.array(fc.stringMatching(/^[a-zA-Z0-9._%-]{0,12}$/),{minLength:1,maxLength:4}).map(s=>'/'+s.join('/'))
);
const methodArb=fc.constantFrom('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS');
// undefined 表示不帶 Host 標頭
const hostArb=fc.constantFrom('127.0.0.1:5181','localhost','LOCALHOST:8080','[::1]:5181','lan.example',undefined,'evil.example','127.0.0.1.evil.example','');
// accounts.handle 的行為：不處理、回應衝突標頭、回應錯誤狀態、拋出例外
const accountsArb=fc.constantFrom('null','conflicting','error-status','throw','throw-non-error');
const healthArb=fc.constantFrom('ok','fail','throw');

function makeAccounts(kind){
 return {async handle(req){
  if(!new URL(req.url).pathname.startsWith('/api/'))return null;
  switch(kind){
   case 'null':return null;
   case 'conflicting':return Response.json({ok:true},{headers:{'Cache-Control':'public, max-age=3600','X-Frame-Options':'ALLOWALL','Content-Security-Policy':"default-src *",'Referrer-Policy':'unsafe-url'}});
   case 'error-status':return Response.json({error:'x'},{status:409});
   case 'throw':throw new Error('boom');
   default:throw null;
  }
 }};
}
const healthFn=kind=>kind==='ok'?async()=>true:kind==='fail'?async()=>false:async()=>{throw new Error('db down');};

test('Property 15: 所有回應皆帶安全標頭',async()=>{
 const origError=console.error;console.error=()=>{};
 try{
  await fc.assert(fc.asyncProperty(pathArb,methodArb,hostArb,accountsArb,healthArb,async(path,method,host,accountsKind,healthKind)=>{
   const handler=createHttpHandler({root,allowedHosts:['127.0.0.1','localhost','[::1]','lan.example'],health:healthFn(healthKind),healthTimeoutMs:50,accounts:makeAccounts(accountsKind)});
   const headers=host===undefined?{}:{host};
   const res=await handler(new Request('http://127.0.0.1:5181'+path,{method,headers}),{requestIP:()=>({address:'127.0.0.1'})});
   let decoded;try{decoded=decodeURIComponent(new URL('http://x'+path).pathname);}catch{decoded=null;}
   for(const [k,v]of Object.entries(SECURITY_HEADERS)){
    const actual=res.headers.get(k);
    if(k==='Cache-Control'&&actual==='no-cache'){
     // 例外僅限成功回應的靜態資源
     expect(res.status).toBe(200);
     expect(decoded!==null&&isStaticAsset(decoded)).toBe(true);
    }else expect(actual).toBe(v);
   }
  }),{numRuns:300});
 }finally{console.error=origError;}
});
