import {resolve,sep} from 'node:path';
export const SECURITY_HEADERS={
 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Frame-Options':'SAMEORIGIN',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
export function createHttpHandler({root,accounts}){
 root=resolve(root);
 return async (req,server)=>{
  const url=new URL(req.url);
  try{
   const api=await accounts.handle(req,{ip:server?.requestIP?.(req)?.address});
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
  }catch(err){console.error('Request failed:',err?.name||'Error');return Response.json({error:'伺服器暫時無法完成要求。'},{status:500,headers:SECURITY_HEADERS});}
 };
}