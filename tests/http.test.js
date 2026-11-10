import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {createHttpHandler,SECURITY_HEADERS} from '../server/http.js';
import {cookieHeader} from '../server/accounts.js';
const root=resolve(import.meta.dir,'..',process.env.CAMPING_DIST||'dist');
const handler=createHttpHandler({root,accounts:{async handle(req){return new URL(req.url).pathname.startsWith('/api/')?Response.json({error:'請先登入'},{status:401}):null;}}});
// Bun.serve 一定帶 Host 標頭；手動建構的 Request 不會自動帶，因此測試以 URL 的 host 補上。
const req=(url,init={})=>new Request(url,{...init,headers:{host:new URL(url).host,...(init.headers||{})}});
const hasSecurityHeaders=res=>{for(const [k,v]of Object.entries(SECURITY_HEADERS))expect(res.headers.get(k)).toBe(v);};
test('clean account routes serve only the shell with no-store and security headers',async()=>{
 for(const path of ['/','/setup','/login','/ena/home','/ena/trips/abc-123','/ena/trips/abc-123/go','/admin','/demo/']){
  const res=await handler(req('http://127.0.0.1:5181'+path));expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('no-store');expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");expect(await res.text()).toContain('id="app"');
 }
});
test('database, source, backups and encoded traversal are never served',async()=>{
 for(const path of ['/data/accounts.sqlite','/server/accounts.js','/README.md','/camping-replica-source.zip','/%2e%2e%2fdata/accounts.sqlite','/assets/..%5c..%5cdata/accounts.sqlite','/not-a-page'])expect((await handler(req('http://127.0.0.1:5181'+path))).status).toBeGreaterThanOrEqual(400);
});
// Req 8.3：Host 不在 Allowed_Hosts 內一律 421（原本由 accounts 層回應 403，現改於 HTTP 層提早拒絕）
test('unexpected hostname rejected even if DNS points to localhost',async()=>{const res=await handler(req('http://attacker.example/api/session'));expect(res.status).toBe(421);hasSecurityHeaders(res);});
test('missing or disallowed Host never reaches accounts or the file system',async()=>{
 let calls=0;const h=createHttpHandler({root,accounts:{async handle(){calls++;return null;}}});
 for(const r of [new Request('http://127.0.0.1:5181/'),req('http://evil.example/'),req('http://127.0.0.1:5181/api/session',{headers:{host:'lan.example:5181'}})]){const res=await h(r);expect(res.status).toBe(421);hasSecurityHeaders(res);}
 expect(calls).toBe(0);
 const lan=createHttpHandler({root,allowedHosts:['lan.example'],accounts:{async handle(){calls++;return null;}}});
 expect((await lan(req('http://LAN.example:8080/'))).status).toBe(200);expect(calls).toBe(1);
});
test('protected API response never falls back to shell or cache',async()=>{const res=await handler(req('http://127.0.0.1:5181/api/trips'));expect(res.status).toBe(401);expect(res.headers.get('cache-control')).toBe('no-store');expect(await res.json()).toEqual({error:'請先登入'});});
test('static files reject writes and malformed paths',async()=>{expect((await handler(req('http://127.0.0.1:5181/styles.css',{method:'POST'}))).status).toBe(405);expect((await handler(req('http://127.0.0.1:5181/%zz'))).status).toBe(400);});
test('/healthz reports database state with a 2 second timeout and security headers',async()=>{
 const make=health=>createHttpHandler({root,health,healthTimeoutMs:50,accounts:{async handle(){throw new Error('not reached');}}});
 let res=await make(async()=>true)(req('http://127.0.0.1:5181/healthz'));expect(res.status).toBe(200);expect(await res.json()).toEqual({status:'ok',database:'ok'});hasSecurityHeaders(res);
 for(const health of [async()=>{throw new Error('down');},async()=>false,()=>new Promise(()=>{}),undefined]){res=await make(health)(req('http://127.0.0.1:5181/healthz'));expect(res.status).toBe(503);expect(await res.json()).toEqual({status:'error',database:'unavailable'});hasSecurityHeaders(res);}
 expect((await make(async()=>true)(req('http://attacker.example/healthz'))).status).toBe(421);
 expect((await make(async()=>true)(req('http://127.0.0.1:5181/healthz',{method:'POST'}))).status).toBe(405);
});
test('forwarded headers are trusted only from Trusted_Proxies',async()=>{
 let seen;const h=trustedProxies=>createHttpHandler({root,trustedProxies,accounts:{async handle(_r,info){seen=info;return Response.json({});}}});
 const server={requestIP:()=>({address:'10.0.0.5'})};
 const forwarded=req('http://127.0.0.1:5181/api/session',{headers:{'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1, 192.168.1.20'}});
 await h([])(forwarded,server);expect(seen).toMatchObject({ip:'10.0.0.5',tcpIp:'10.0.0.5',viaProxy:false});expect(seen.url.protocol).toBe('http:');
 await h([{family:4,network:'10.0.0.5',prefix:32}])(forwarded,server);expect(seen).toMatchObject({ip:'192.168.1.20',tcpIp:'10.0.0.5',viaProxy:true});expect(seen.url.protocol).toBe('https:');
});
test('cookieHeader sets hardened attributes and Secure only for https',()=>{
 expect(cookieHeader(new URL('http://127.0.0.1/'),'tok',604800)).toBe('ggc_session=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800');
 expect(cookieHeader(new URL('https://lan.example/'),'',0)).toBe('ggc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
});
