import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {createHttpHandler} from '../server/http.js';
const handler=createHttpHandler({root:resolve(import.meta.dir,'..',process.env.CAMPING_DIST||'dist'),accounts:{async handle(req){return new URL(req.url).pathname.startsWith('/api/')?Response.json({error:'請先登入'},{status:401}):null;}}});
test('clean account routes serve only the shell with no-store and security headers',async()=>{
 for(const path of ['/','/setup','/login','/ena/home','/ena/trips/abc-123','/ena/trips/abc-123/go','/admin','/demo/']){
  const res=await handler(new Request('http://127.0.0.1:5181'+path));expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('no-store');expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");expect(await res.text()).toContain('id="app"');
 }
});
test('database, source, backups and encoded traversal are never served',async()=>{
 for(const path of ['/data/accounts.sqlite','/server/accounts.js','/README.md','/camping-replica-source.zip','/%2e%2e%2fdata/accounts.sqlite','/assets/..%5c..%5cdata/accounts.sqlite','/not-a-page'])expect((await handler(new Request('http://127.0.0.1:5181'+path))).status).toBeGreaterThanOrEqual(400);
});
test('unexpected hostname rejected even if DNS points to localhost',async()=>expect((await handler(new Request('http://attacker.example/api/session'))).status).toBe(403));
test('protected API response never falls back to shell or cache',async()=>{const res=await handler(new Request('http://127.0.0.1:5181/api/trips'));expect(res.status).toBe(401);expect(res.headers.get('cache-control')).toBe('no-store');expect(await res.json()).toEqual({error:'請先登入'});});
test('static files reject writes and malformed paths',async()=>{expect((await handler(new Request('http://127.0.0.1:5181/styles.css',{method:'POST'}))).status).toBe(405);expect((await handler(new Request('http://127.0.0.1:5181/%zz'))).status).toBe(400);});
