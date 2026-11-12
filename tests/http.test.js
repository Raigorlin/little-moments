import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {createHttpHandler,SECURITY_HEADERS} from '../server/http.js';
import {cookieHeader} from '../server/accounts.js';
import {parseCidrList} from '../server/config.js';
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
// 原 security-config.test.js 對 nginx 的「點開頭路徑一律 404」檢查：main 的 Caddy 不讀檔，全部轉給 App，由靜態白名單拒絕。
test('dot-prefixed paths are 404 with the security headers',async()=>{
 for(const path of ['/.env','/.git/config','/.secrets/openai_api_key','/.kiro/','/assets/.env','/.well-known/security.txt']){const res=await handler(req('http://127.0.0.1:5181'+path));expect(res.status).toBe(404);hasSecurityHeaders(res);}
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
// security-harden 的 Local_Mode 接受任何 IP 字面值 Host；main 只接受 Allowed_Hosts 內的項目。
test('an IP literal Host such as a LAN address is accepted only when listed in Allowed_Hosts',async()=>{
 expect((await handler(req('http://192.168.1.10:5182/'))).status).toBe(421);
 const lan=createHttpHandler({root,allowedHosts:['192.168.1.10'],accounts:{async handle(){return null;}}});
 const res=await lan(req('http://192.168.1.10:5182/'));expect(res.status).toBe(200);expect(await res.text()).toContain('id="app"');
});
// 原 security-harden「apex hostname is rejected in Published_Mode」：只列出 www 主機名時，apex 不得到達帳號服務。
test('a hostname outside Allowed_Hosts (apex of the listed name) is rejected before the account service',async()=>{
 const calls=[];const site=createHttpHandler({root,allowedHosts:['www.our-littlemoments.com'],accounts:{async handle(r){calls.push(r.url);return null;}}});
 for(const url of ['https://our-littlemoments.com/','https://our-littlemoments.com/api/session','https://evil.example/api/session']){const res=await site(req(url));expect(res.status).toBe(421);expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");}
 // Host 與網址不同時以 Host 標頭為準
 expect((await site(req('https://www.our-littlemoments.com/api/session',{headers:{host:'our-littlemoments.com'}}))).status).toBe(421);
 expect(calls).toEqual([]);
 expect((await site(req('https://www.our-littlemoments.com/'))).status).toBe(200);expect(calls.length).toBe(1);
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
// 原 deploy-config.test.js「untrusted peer with spoofed forwarding headers keeps the peer address」與 Property 5：
// Origin 比對與 Cookie Secure 依 info.url 決定；非代理來源的轉送標頭、以及 X-Forwarded-Host 都不能改變它。
test('spoofed forwarding headers never change the client address or the origin accounts compares against',async()=>{
 let seen;const h=createHttpHandler({root,allowedHosts:['lan.example'],trustedProxies:parseCidrList('172.18.0.2'),accounts:{async handle(_r,info){seen=info;return Response.json({});}}});
 const spoof={'x-forwarded-for':'10.0.0.1','x-forwarded-host':'evil.example','x-forwarded-proto':'https','x-real-ip':'127.0.0.1',forwarded:'for=127.0.0.1;proto=https;host=evil.example'};
 await h(req('http://lan.example:5173/api/login',{method:'POST',headers:spoof}),{requestIP:()=>({address:'198.51.100.7'})});
 expect(seen).toMatchObject({ip:'198.51.100.7',tcpIp:'198.51.100.7',viaProxy:false});expect(seen.url.origin).toBe('http://lan.example:5173');
 await h(req('http://lan.example:5173/api/login',{method:'POST',headers:{...spoof,'x-forwarded-for':'203.0.113.5'}}),{requestIP:()=>({address:'172.18.0.2'})});
 expect(seen).toMatchObject({ip:'203.0.113.5',viaProxy:true});expect(seen.url.origin).toBe('https://lan.example:5173');
});
// security-harden 的較嚴格規則：代理送來無法解析的用戶端位址時回應 400，不呼叫帳號服務。
test('an invalid X-Forwarded-For entry from a trusted proxy is rejected with 400',async()=>{
 let calls=0;const h=createHttpHandler({root,trustedProxies:parseCidrList('127.0.0.1'),accounts:{async handle(){calls++;return Response.json({});}}});
 const proxy={requestIP:()=>({address:'127.0.0.1'})};
 for(const xff of ['not-an-ip','203.0.113.5, not-an-ip','','unknown, 127.0.0.1']){const res=await h(req('http://127.0.0.1:5181/api/session',{headers:{'x-forwarded-for':xff}}),proxy);expect(res.status).toBe(400);hasSecurityHeaders(res);}
 expect(calls).toBe(0);
 // 選中項目之左側的無效值不影響結果；非代理來源的無效值被忽略
 expect((await h(req('http://127.0.0.1:5181/api/session',{headers:{'x-forwarded-for':'not-an-ip, 203.0.113.5'}}),proxy)).status).toBe(200);
 expect((await h(req('http://127.0.0.1:5181/api/session',{headers:{'x-forwarded-for':'not-an-ip'}}),{requestIP:()=>({address:'10.0.0.9'})})).status).toBe(200);
 expect(calls).toBe(2);
});
test('a thrown error answers 500 with a generic body and logs no message, query string or headers',async()=>{
 const lines=[];const original=console.error;console.error=(...a)=>lines.push(a.join(' '));
 try{
  const h=createHttpHandler({root,accounts:{async handle(){throw new Error('boom /etc/secret SELECT * FROM users');}}});
  const res=await h(req('http://127.0.0.1:5181/api/session?token=abc123',{headers:{cookie:'ggc_session=s3cr3t'}}));
  expect(res.status).toBe(500);hasSecurityHeaders(res);
  const text=await res.text();expect(text).not.toMatch(/boom|etc|SELECT/);
 }finally{console.error=original;}
 expect(lines.length).toBe(1);
 expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z GET \/api\/session Error$/);
});
test('cookieHeader sets hardened attributes and Secure only for https',()=>{
 expect(cookieHeader(new URL('http://127.0.0.1/'),'tok',604800)).toBe('ggc_session=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800');
 expect(cookieHeader(new URL('https://lan.example/'),'',0)).toBe('ggc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
});
