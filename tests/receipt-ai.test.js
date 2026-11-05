import {test,expect} from 'bun:test';
import {createAccountService} from '../server/accounts.js';
import {createReceiptAi,normalizeAiReceipt,validateAiImage,readLimitedBytes,AI_IMAGE_LIMIT} from '../server/receipt-ai.js';
import {EXPENSE_CATEGORIES,suggestExpenseCategory} from '../src/expense-categories.js';
import {seed} from '../src/model.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/pkAAAAASUVORK5CYII=','base64');
const model=()=>({currency:'TWD',store:'測試商店',date:'2026-11-04',total:'150',items:[{title:'鮮奶',quantity:'2',unitPrice:'50',amount:'100',category:'食材／蛋奶',uncertain:false,warning:''},{title:'木炭',quantity:'1',unitPrice:'50',amount:'50',category:'露營耗材',uncertain:false,warning:''}],warnings:[]});
const envelope=data=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]});
const env={CAMPING_OPENAI_MODEL_ID:'gpt-6-luna',CAMPING_OPENAI_API_KEY:'sk-test-only-not-a-real-openai-api-key'};
const base='http://localhost:5181';

test('expanded categories preserve old values and local suggestions distinguish fuel and food',()=>{
 for(const c of ['食材','交通','住宿','其他'])expect(EXPENSE_CATEGORIES).toContain(c);
 expect(new Set(EXPENSE_CATEGORIES).size).toBe(EXPENSE_CATEGORIES.length);
 for(const [name,c] of [['高麗菜','食材／蔬菜'],['鮮奶','食材／蛋奶'],['木炭','露營耗材'],['帳篷','露營裝備'],['衛生紙','日用品'],['停車費','交通'],['營位費','住宿'],['???','其他']])expect(suggestExpenseCategory(name)).toBe(c);
});
test('normalizer uses only extracted exact amounts and allowed categories; sums independently',()=>{
 const out=normalizeAiReceipt(model());expect(out.totalCents).toBe(15000);expect(out.items.map(i=>i.amount)).toEqual(['100','50']);expect(out.items.map(i=>i.category)).toEqual(['食材／蛋奶','露營耗材']);expect(out.warnings).toEqual([]);
 const data=model();Object.assign(data.items[0],{amount:'1O0',category:'<script>',title:'\u0000鮮奶'});data.date='2026-02-30';const r=normalizeAiReceipt(data);expect(r.items[0].amount).toBe('');expect(r.items[0].category).toBe('其他');expect(r.items[0].title).toBe('鮮奶');expect(r.date).toBe('');expect(r.warnings.join('')).toContain('不符');
});
test('uncertain or total rows never become ready amounts; no numeric guessing',()=>{
 const d=model();d.items.push({...d.items[0],title:'TOTAL',amount:'150'});d.items[0].uncertain=true;d.items[1].amount=50;
 const r=normalizeAiReceipt(d);expect(r.items.every(x=>x.amount==='')).toBe(true);
 for(const malformed of [null,[],{}, {...model(),items:[null]}, {...model(),items:Array(151).fill({})}])expect(()=>normalizeAiReceipt(malformed)).toThrow();
 expect(()=>normalizeAiReceipt({...model(),currency:'USD'})).toThrow('新台幣');
});
test('quantity discrepancies require review and do not replace printed line amount',()=>{
 const d=model();d.items[0].quantity='3';const r=normalizeAiReceipt(d);expect(r.items[0].amount).toBe('100');expect(r.items[0].warning).toContain('數量');
});
test('server image validation bounds size, type, dimensions and truncation',()=>{
 expect(validateAiImage(png,'image/png').width).toBe(1);
 for(const [b,t] of [[Buffer.from('html'),'image/png'],[png,'image/jpeg'],[png.subarray(0,40),'image/png'],[new Uint8Array(AI_IMAGE_LIMIT+1),'image/png']])expect(()=>validateAiImage(b,t)).toThrow();
 const huge=Buffer.from(png);huge.writeUInt32BE(8001,16);expect(()=>validateAiImage(huge,'image/png')).toThrow();
});
test('limited streams reject undeclared oversize payload and cancel',async()=>{
 await expect(readLimitedBytes(new Response('12345'),4)).rejects.toThrow();
 const c=new AbortController();c.abort();await expect(readLimitedBytes(new Response('ok'),4,c.signal)).rejects.toThrow();
});
test('unconfigured or invalid OpenAI credentials never invoke provider or leak key',async()=>{
 let calls=0;const fetchImpl=()=>{calls++;throw Error('must not fetch');};
 for(const config of [{CAMPING_OPENAI_API_KEY:'not-an-api-key'},{...env,CAMPING_OPENAI_API_KEY:'not-an-api-key'},{...env,CAMPING_OPENAI_MODEL_ID:'../model'}]){
 const p=createReceiptAi({env:config,fetchImpl});expect(p.status.enabled).toBe(false);expect(JSON.stringify(p.status)).not.toContain(env.CAMPING_OPENAI_API_KEY);await expect(p.recognize(png,'image/png')).rejects.toThrow('尚未設定');
 }expect(calls).toBe(0);
});
test('default OpenAI model is GPT-6 Luna',()=>{
 const p=createReceiptAi({env:{CAMPING_OPENAI_API_KEY:env.CAMPING_OPENAI_API_KEY},fetchImpl:async()=>Response.json(envelope(model()))});
 expect(p.status.modelId).toBe('gpt-6-luna');
});
test('OpenAI contract sends bounded image JSON to the fixed API with no tools or retries',async()=>{
 let calls=0;const p=createReceiptAi({env,fetchImpl:async(url,init)=>{
  calls++;expect(url).toBe('https://api.openai.com/v1/chat/completions');expect(init.redirect).toBe('error');expect(init.headers.Authorization).toBe('Bearer '+env.CAMPING_OPENAI_API_KEY);
  const b=JSON.parse(init.body);expect(b.model).toBe('gpt-6-luna');expect(b.messages[1].content[1].image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`);expect(b.tools).toBeUndefined();expect(b.messages[0].content).toContain('untrusted');expect(b.response_format).toEqual({type:'json_object'});expect(b.max_completion_tokens).toBe(6000);expect(b.max_tokens).toBeUndefined();expect(b.temperature).toBeUndefined();
  return Response.json(envelope(model()));
 }});expect((await p.recognize(png,'image/png')).items).toHaveLength(2);expect(calls).toBe(1);
});
test('provider failures, refusals, truncation, huge output and invalid JSON cannot leak body or credentials',async()=>{
 for(const response of [new Response('SECRET',{status:403}),new Response('bad'),Response.json({choices:[{finish_reason:'length',message:{content:'{}'}}]}),Response.json({choices:[{finish_reason:'stop',message:{refusal:'no',content:'{}'}}]}),new Response('x'.repeat(270000))]){
 let calls=0;const p=createReceiptAi({env,fetchImpl:async()=>{calls++;return response;}});let error;try{await p.recognize(png,'image/png');}catch(e){error=e;}expect(error).toBeTruthy();expect(error.message).not.toContain('SECRET');expect(error.message).not.toContain(env.CAMPING_OPENAI_API_KEY);expect(calls).toBe(1);
 }
});
test('provider cancellation/timeout aborts network, does not retry or return late candidates',async()=>{
 let aborted=false;const p=createReceiptAi({env,timeoutMs:5,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('stop','AbortError'));},{once:true});})});
 await expect(p.recognize(png,'image/png')).rejects.toThrow('無法撤回');expect(aborted).toBe(true);
});

async function fixture(receiptAi){
 const service=createAccountService({dbPath:':memory:',receiptAi});
 const call=(path,{method='GET',cookie='',body,headers={},signal}={})=>service.handle(new Request(base+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{Origin:base}:{}),...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),signal}));
 const setup=await call('/api/setup',{method:'POST',body:{username:'test-admin',displayName:'測試',password:'Only-Test-Password-2026'}});expect(setup.status).toBe(200);const cookie=setup.headers.get('set-cookie').split(';')[0],{user}=await setup.json();
 const tr=await call('/api/trips',{method:'POST',cookie,body:{legacyState:seed()}});expect(tr.status).toBe(201);const {trip}=await tr.json(),path=`/api/trips/${trip.id}/receipt-ai`;
 const headers={'Content-Type':'image/png','x-camping-user-id':user.id,'x-receipt-consent':'openai-v1'};
 const send=extra=>call(path,{method:'POST',cookie,body:png,headers,...extra});return {service,call,cookie,user,trip,path,headers,send};
}
const provider=(recognize=async()=>normalizeAiReceipt(model()))=>({status:{enabled:true,provider:'OpenAI',modelId:'gpt-6-luna',maxImageBytes:AI_IMAGE_LIMIT},recognize});
test('receipt API requires auth, matching session, membership, Origin and explicit per-photo consent',async()=>{
 let n=0;const w=await fixture(provider(async()=>{n++;return normalizeAiReceipt(model());}));try{
  for(const [extra,status] of [[{cookie:''},401],[{headers:{...w.headers,Origin:'http://evil.test'}},403],[{headers:{...w.headers,'x-camping-user-id':'other'}},409],[{headers:{...w.headers,'x-receipt-consent':''}},400],[{headers:{...w.headers,'x-camping-user-id':''}},400],[{headers:{...w.headers,'Content-Type':'text/html'}},415],[{body:Buffer.from('bad')},415],[{headers:{...w.headers,'Content-Length':String(AI_IMAGE_LIMIT+1)}},413]])expect((await w.send(extra)).status).toBe(status);
  expect((await w.call('/api/trips/missing/receipt-ai',{cookie:w.cookie})).status).toBe(404);expect(n).toBe(0);
  const reg=await w.call('/api/register',{method:'POST',body:{username:'other-user',displayName:'其他人',password:'Only-Test-Password-2026'}});const otherCookie=reg.headers.get('set-cookie').split(';')[0],other=(await reg.json()).user;
  expect((await w.send({cookie:otherCookie,headers:{...w.headers,'x-camping-user-id':other.id}})).status).toBe(404);expect(n).toBe(0);
 }finally{w.service.close();}
});
test('successful AI recognition writes no trip/ledger; status never exposes credentials; unconfigured fails closed',async()=>{
 for(const active of [true,false]){
 const w=await fixture(active?provider():null);try{
  const before=await (await w.call(`/api/trips/${w.trip.id}`,{cookie:w.cookie})).json(),ledger=await (await w.call(`/api/trips/${w.trip.id}/ledger`,{cookie:w.cookie})).json();
  const status=await w.call(w.path,{cookie:w.cookie});expect((await status.json()).enabled).toBe(active);expect(status.headers.get('cache-control')).toBe('no-store');
  const res=await w.send();expect(res.status).toBe(active?200:503);if(active)expect((await res.json()).items).toHaveLength(2);
  expect(await (await w.call(`/api/trips/${w.trip.id}`,{cookie:w.cookie})).json()).toEqual(before);expect(await (await w.call(`/api/trips/${w.trip.id}/ledger`,{cookie:w.cookie})).json()).toEqual(ledger);
 }finally{w.service.close();}
 }
});
test('per-user quota and in-flight lock prevent excess provider calls',async()=>{
 let calls=0;const w=await fixture(provider(async()=>{calls++;return normalizeAiReceipt(model());}));try{for(let i=0;i<10;i++)expect((await w.send()).status).toBe(200);expect((await w.send()).status).toBe(429);expect(calls).toBe(10);}finally{w.service.close();}
 let done,entered;const ready=new Promise(r=>entered=r),held=new Promise(r=>done=r);const v=await fixture(provider(async()=>{entered();await held;return normalizeAiReceipt(model());}));try{const pending=v.send();await ready;expect((await v.send()).status).toBe(429);done();expect((await pending).status).toBe(200);}finally{done();v.service.close();}
});
test('logout during provider processing blocks releasing recognition result',async()=>{
 let done,entered;const ready=new Promise(r=>entered=r),held=new Promise(r=>done=r);const w=await fixture(provider(async()=>{entered();await held;return normalizeAiReceipt(model());}));try{
 const pending=w.send();await ready;await w.call('/api/logout',{method:'POST',cookie:w.cookie,body:{}});done();expect((await pending).status).toBe(401);
 }finally{done();w.service.close();}
});

test('mixed new and original category values persist without extra ledger fields or trip changes',async()=>{
 const w=await fixture(provider());try{
 const before=await (await w.call(`/api/trips/${w.trip.id}`,{cookie:w.cookie})).json(),person=before.state.currentUser;
 const expenses=EXPENSE_CATEGORIES.map((category,i)=>({id:`test-${i}`,date:'2026-11-04',title:`品項 ${i}`,amountCents:100,payerId:person,participantIds:[person],category,note:'',shoppingId:'',source:'manual',receiptId:'',receiptLine:''}));
 const res=await w.call(`/api/trips/${w.trip.id}/ledger`,{method:'PUT',cookie:w.cookie,body:{expectedUserId:w.user.id,revision:0,requestId:'category-test',expenses,settlements:[]}});expect(res.status).toBe(200);expect((await res.json()).ledger.expenses).toEqual(expenses);
 const after=await (await w.call(`/api/trips/${w.trip.id}/ledger`,{cookie:w.cookie})).json();expect(after.ledger.expenses).toEqual(expenses);expect(await (await w.call(`/api/trips/${w.trip.id}`,{cookie:w.cookie})).json()).toEqual(before);
 }finally{w.service.close();}
});

test('joined collaborators can recognize but an unrelated administrator cannot',async()=>{
 let calls=0;const w=await fixture(provider(async()=>{calls++;return normalizeAiReceipt(model());}));try{
  const reg=await w.call('/api/register',{method:'POST',body:{username:'receipt-owner',displayName:'主揪',password:'Only-Test-Password-2026'}});const ownerCookie=reg.headers.get('set-cookie').split(';')[0],owner=(await reg.json()).user;
  const created=await w.call('/api/trips',{method:'POST',cookie:ownerCookie,body:{legacyState:seed()}}),{trip}=await created.json(),path=`/api/trips/${trip.id}/receipt-ai`;
  expect((await w.call(path,{cookie:w.cookie})).status).toBe(404);
  const invited=await w.call(`/api/trips/${trip.id}/invites`,{method:'POST',cookie:ownerCookie,body:{expectedUserId:owner.id}}),invite=await invited.json();
  const guestR=await w.call('/api/register',{method:'POST',body:{username:'receipt-guest',displayName:'旅伴',password:'Only-Test-Password-2026'}}),guestCookie=guestR.headers.get('set-cookie').split(';')[0],guest=(await guestR.json()).user;
  const token=invite.urlPath.split('/').at(-1);const joined=await w.call(`/api/invites/${token}/join`,{method:'POST',cookie:guestCookie,body:{name:'辨識旅伴',role:'採買',expectedUserId:guest.id}});expect(joined.status).toBe(200);
  const r=await w.call(path,{method:'POST',cookie:guestCookie,body:png,headers:{...w.headers,'x-camping-user-id':guest.id}});expect(r.status).toBe(200);expect(calls).toBe(1);
 }finally{w.service.close();}
});
