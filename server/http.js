import {resolve,sep} from 'node:path';
import {LOCAL_DEFAULTS,resolveRequestContext} from './deploy-config.js';
import {logRequestError} from './safe-log.js';
export const SECURITY_HEADERS={
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Frame-Options':'DENY',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin'
};
const DEPLOYMENT_META='<meta name="camping-deployment" content="published">';
const notFound=()=>new Response('Not found',{status:404,headers:SECURITY_HEADERS});
// Published_Mode shell: same index.html with the deployment meta tag right after <head ...>.
async function shellResponse(file,method){
 const html=await file.text();
 const body=/<head\b[^>]*>/i.test(html)?html.replace(/<head\b[^>]*>/i,m=>m+DEPLOYMENT_META):DEPLOYMENT_META+html;
 return new Response(method==='HEAD'?null:body,{headers:{...SECURITY_HEADERS,'Content-Type':file.type}});
}
// Published_Mode service worker: flip the build-time PUBLISHED flag; no-op when the flag is absent.
async function swResponse(file,method){
 const body=(await file.text()).replace('const PUBLISHED=false;','const PUBLISHED=true;');
 return new Response(method==='HEAD'?null:body,{headers:{...SECURITY_HEADERS,'Content-Type':file.type,'Cache-Control':'no-cache'}});
}
export function createHttpHandler({root,accounts,config=LOCAL_DEFAULTS}){
 root=resolve(root);
 return async (req,server)=>{
  const url=new URL(req.url);
  try{
   const context=resolveRequestContext({url,headers:req.headers,peer:server?.requestIP?.(req)?.address,config});
   if(!context.ok)return new Response(context.message,{status:context.status,headers:SECURITY_HEADERS});
   const api=await accounts.handle(req,context.ctx);
   if(api){for(const [k,v]of Object.entries(SECURITY_HEADERS))api.headers.set(k,v);return api;}
   if(!['GET','HEAD'].includes(req.method))return new Response('Method not allowed',{status:405,headers:SECURITY_HEADERS});
   let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400,headers:SECURITY_HEADERS});}
   if(config.published&&/^\/(?:demo|setup)\/?$/.test(pathname))return notFound();
   const route=/^\/(?:$|demo\/?$|setup\/?$|login\/?$|register\/?$|admin\/?$|invite\/[a-f0-9]{32,128}\/?$|[a-z][a-z0-9-]{2,31}\/(?:home|trips\/[a-zA-Z0-9-]+(?:\/go)?)\/?$)/.test(pathname);
   const asset=/^\/(?:index\.html|entry\.js|app\.js|styles\.css|favicon\.svg|sw\.js|chunks\/[a-zA-Z0-9_.-]+\.js|assets\/[a-zA-Z0-9_./-]+)$/.test(pathname);
   if(!route&&!asset)return notFound();
   const path=resolve(root,route?'index.html':'.'+pathname);
   if(!path.startsWith(root+sep))return new Response('Forbidden',{status:403,headers:SECURITY_HEADERS});
   const file=Bun.file(path);if(!await file.exists())return notFound();
   if(config.published&&(route||pathname==='/index.html'))return shellResponse(file,req.method);
   if(config.published&&pathname==='/sw.js')return swResponse(file,req.method);
   return new Response(req.method==='HEAD'?null:file,{headers:{...SECURITY_HEADERS,'Content-Type':file.type,...(asset&&pathname!='/index.html'?{'Cache-Control':'no-cache'}:{})}});
  }catch(err){logRequestError({method:req.method,url,error:err});return Response.json({error:'伺服器暫時無法完成要求。'},{status:500,headers:SECURITY_HEADERS});}
 };
}
