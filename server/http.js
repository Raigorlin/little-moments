import {resolve,sep} from 'node:path';
import {DEFAULT_ALLOWED_HOSTS,hostAllowed,resolveClient} from './config.js';
import {logRequestError} from './safe-log.js';
// security-harden：瀏覽器端 OCR 已移除，script-src 不再需要 'wasm-unsafe-eval'；禁止 object 與任何框架嵌入，
// 並加上 COOP／CORP（Req 10.6：所有回應，包含 421 與 500，都帶這些標頭）。
export const SECURITY_HEADERS={
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Frame-Options':'DENY',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin'
};
export const HEALTH_TIMEOUT_MS=2000;
const HEALTH_OK={status:'ok',database:'ok'},HEALTH_FAIL={status:'error',database:'unavailable'};
// 以 2 秒逾時呼叫 health()；回傳 false、拋出例外或逾時皆視為失敗（Req 11.6）。
async function checkHealth(health,timeoutMs){
 if(typeof health!=='function')return false;
 let timer;
 try{
  const timeout=new Promise(res=>{timer=setTimeout(()=>res(false),timeoutMs);});
  const result=await Promise.race([Promise.resolve().then(()=>health()),timeout]);
  return result!==false;
 }catch{return false;}
 finally{clearTimeout(timer);}
}
/**
 * @param {{root:string, accounts:{handle:Function}, allowedHosts?:string[], health?:()=>any, trustedProxies?:object[], healthTimeoutMs?:number}} options
 * 處理順序：Host 檢查（421）→ GET /healthz → resolveClient 重建有效請求網址 → API → 靜態路由。
 * /healthz 同樣須通過 Host 檢查（設計 Components §2）。
 * accounts.handle 收到的 info：{ip（有效用戶端 IP）, tcpIp, viaProxy, url（有效請求網址，Origin 比對與 Cookie Secure 依此決定）}。
 */
export function createHttpHandler({root,accounts,allowedHosts=DEFAULT_ALLOWED_HOSTS,health,trustedProxies=[],healthTimeoutMs=HEALTH_TIMEOUT_MS}){
 root=resolve(root);
 const hosts=[...allowedHosts];
 return async (req,server)=>{
  try{
   // Host 檢查：不通過時不呼叫 accounts.handle、不讀檔（Req 8.3）
   if(!hostAllowed(req.headers.get('host'),hosts))return new Response('Misdirected request',{status:421,headers:SECURITY_HEADERS});
   const url=new URL(req.url);
   if(url.pathname==='/healthz'){
    if(req.method!=='GET')return new Response('Method not allowed',{status:405,headers:{...SECURITY_HEADERS,Allow:'GET'}});
    const ok=await checkHealth(health,healthTimeoutMs);
    return Response.json(ok?HEALTH_OK:HEALTH_FAIL,{status:ok?200:503,headers:SECURITY_HEADERS});
   }
   // 有效請求網址與用戶端（Req 9.12）：僅 Trusted_Proxies 來源的 X-Forwarded-* 會被採信
   const tcpIp=server?.requestIP?.(req)?.address;
   const client=resolveClient(tcpIp,req.headers,url,trustedProxies);
   // security-harden 的較嚴格規則：Trusted_Proxies 送來的 X-Forwarded-For 選中的項目不是有效 IP 時拒絕，
   // 不以代理 IP 充當用戶端（否則所有用戶端共用同一個限速鍵）。
   if(client.forwardedForInvalid)return new Response('Bad forwarding header',{status:400,headers:SECURITY_HEADERS});
   const api=await accounts.handle(req,{ip:tcpIp===undefined?undefined:client.clientIp,tcpIp,viaProxy:client.viaProxy,url:client.url});
   if(api){for(const [k,v]of Object.entries(SECURITY_HEADERS))api.headers.set(k,v);return api;}
   if(!['GET','HEAD'].includes(req.method))return new Response('Method not allowed',{status:405,headers:SECURITY_HEADERS});
   let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400,headers:SECURITY_HEADERS});}
   const route=/^\/(?:$|demo\/?$|setup\/?$|login\/?$|register\/?$|admin\/?$|invite\/[a-f0-9]{32,128}\/?$|[a-z][a-z0-9-]{2,31}\/(?:home|trips\/[a-zA-Z0-9-]+(?:\/go)?)\/?$)/.test(pathname);
   const asset=/^\/(?:index\.html|entry\.js|app\.js|styles\.css|favicon\.svg|sw\.js|chunks\/[a-zA-Z0-9_.-]+\.js|assets\/[a-zA-Z0-9_./-]+)$/.test(pathname);
   if(!route&&!asset)return new Response('Not found',{status:404,headers:SECURITY_HEADERS});
   const path=resolve(root,route?'index.html':'.'+pathname);
   if(!path.startsWith(root+sep))return new Response('Forbidden',{status:403,headers:SECURITY_HEADERS});
   const file=Bun.file(path);if(!await file.exists())return new Response('Not found',{status:404,headers:SECURITY_HEADERS});
   return new Response(req.method==='HEAD'?null:file,{headers:{...SECURITY_HEADERS,'Content-Type':file.type,...(asset&&pathname!='/index.html'?{'Cache-Control':'no-cache'}:{})}});
  }catch(err){
   // 錯誤日誌只含時間、方法、不含查詢字串的路徑與錯誤名稱（server/safe-log.js），不含錯誤訊息或請求內容。
   logRequestError({method:req.method,url:req.url,error:err});
   return Response.json({error:'伺服器暫時無法完成要求。'},{status:500,headers:SECURITY_HEADERS});
  }
 };
}
