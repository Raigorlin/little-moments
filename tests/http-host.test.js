// Feature: jenkins-cicd-deploy, Property 14: Host 檢查
// **Validates: Requirements 8.3**
import {test,expect,spyOn} from 'bun:test';
import fc from 'fast-check';
import {resolve} from 'node:path';
import {createHttpHandler,SECURITY_HEADERS} from '../server/http.js';
import {hostAllowed,normalizeHost} from '../server/config.js';

const root=resolve(import.meta.dir,'..',process.env.CAMPING_DIST||'dist');

// 主機名稱池：涵蓋 DNS 名稱、IPv4、IPv6（方括號）與預設 loopback 名稱
const HOST_POOL=['localhost','127.0.0.1','[::1]','lan.example','camp.home.arpa','10.0.0.5','192.168.1.20','[fd00::1]','[2001:db8::42]','attacker.example','lan.example.evil'];

// 隨機改變大小寫（IPv6 十六進位與主機名稱皆不分大小寫）
const randomCase=base=>fc.array(fc.boolean(),{minLength:base.length,maxLength:base.length}).map(flags=>[...base].map((c,i)=>flags[i]?c.toUpperCase():c).join(''));
const portArb=fc.option(fc.integer({min:1,max:65535}),{nil:null});

// 格式正確的 Host 標頭：已知的正規主機名稱 + 隨機大小寫 + 選用連接埠
const wellFormedArb=fc.constantFrom(...HOST_POOL).chain(base=>fc.tuple(randomCase(base),portArb).map(([h,port])=>({header:port===null?h:`${h}:${port}`,base})));
// 格式錯誤的 Host 標頭：空值、無方括號 IPv6、非法連接埠、萬用字元、空白、任意字串
const malformedArb=fc.oneof(
 fc.constantFrom('','   ',':80','::1','fd00::1','localhost:','localhost:99999','localhost:abc','localhost:80:80','[::1','[::1]x','[::1]:','*.example','lan..example','-lan.example','lan_example','999.1.1.1','1.2.3','lan.example/','user@lan.example'),
 fc.string({maxLength:20}),
).map(header=>({header,base:null}));
const hostHeaderArb=fc.oneof({weight:3,arbitrary:wellFormedArb},{weight:1,arbitrary:malformedArb});
// Allowed_Hosts 為已正規化（小寫）的池子子集合，非空
const allowedArb=fc.subarray(HOST_POOL,{minLength:1});

test('Property 14: hostAllowed 等同於 normalizeHost 後不分大小寫完全相符',()=>{
 fc.assert(fc.property(hostHeaderArb,allowedArb,({header,base},allowed)=>{
  const norm=normalizeHost(header);
  const expected=norm!==null&&allowed.some(a=>a.toLowerCase()===norm);
  expect(hostAllowed(header,allowed)).toBe(expected);
  // 格式正確的標頭：正規化結果為原始主機（小寫、去除連接埠），允許與否只取決於主機是否在清單內
  if(base!==null){expect(norm).toBe(base);expect(hostAllowed(header,allowed)).toBe(allowed.includes(base));}
  // 清單項目大小寫不影響結果
  expect(hostAllowed(header,allowed.map(a=>a.toUpperCase()))).toBe(expected);
 }),{numRuns:200});
});

const pathArb=fc.constantFrom('/','/login','/admin','/styles.css','/index.html','/api/session','/api/setup','/healthz','/data/accounts.sqlite','/%2e%2e%2fdata/x');
const methodArb=fc.constantFrom('GET','HEAD','POST','PUT','DELETE');

// 建立 Request；header 為 null 表示不帶 Host。標頭值不合法（Headers 會拒絕）時回傳 null。
const makeRequest=(header,path,method)=>{
 try{
  const headers=new Headers();
  if(header!==null)headers.set('host',header);
  const r=new Request('http://127.0.0.1:5181'+path,{method,headers});
  // Headers 會修剪前後空白；以實際送入處理器的值判定
  return {req:r,sent:r.headers.get('host')};
 }catch{return null;}
};

test('Property 14: 不允許的 Host 回應 421 與安全標頭，不呼叫 accounts.handle、不讀檔',async()=>{
 const fileSpy=spyOn(Bun,'file');
 try{
  await fc.assert(fc.asyncProperty(fc.option(hostHeaderArb,{nil:null}),allowedArb,pathArb,methodArb,async(h,allowed,path,method)=>{
   const built=makeRequest(h===null?null:h.header,path,method);
   fc.pre(built!==null);
   const {req,sent}=built;
   let calls=0;
   const handler=createHttpHandler({root,allowedHosts:allowed,health:async()=>true,accounts:{async handle(){calls++;return Response.json({ok:true});}}});
   fileSpy.mockClear();
   const res=await handler(req,{requestIP:()=>({address:'127.0.0.1'})});
   if(hostAllowed(sent,allowed)){
    expect(res.status).not.toBe(421);
    // 通過 Host 檢查後：/healthz 由處理器自行回應，其餘路徑交給 accounts
    expect(calls).toBe(path==='/healthz'?0:1);
   }else{
    expect(res.status).toBe(421);
    for(const [k,v]of Object.entries(SECURITY_HEADERS))expect(res.headers.get(k)).toBe(v);
    expect(calls).toBe(0);
    expect(fileSpy).not.toHaveBeenCalled();
   }
  }),{numRuns:200});
 }finally{fileSpy.mockRestore();}
});
