import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createAccountService} from '../server/accounts.js';
import {parseConfig,redactedSummary,policySummary,isLoopbackAddress} from '../server/config.js';
import {connectWithRetry,DatabaseConnectError,describeTarget} from '../server/db/connect.js';
import {createHttpHandler} from '../server/http.js';
import {createReceiptAi} from '../server/receipt-ai.js';
import {createSetupGuard} from '../server/setup-guard.js';
// 設定（Req 8.1、8.4、8.7、11.8）：錯誤只輸出變數名與原因，不輸出值，並在連線 Database 或監聽任何連接埠前結束。
// 應用層設定（CAMPING_REGISTRATION、CAMPING_RECEIPT_AI_POLICY、收據 AI 用量上限）也由 parseConfig 驗證。
const result=parseConfig(process.env);
if(!result.ok){for(const e of result.errors)console.error(`設定錯誤 ${e.name}: ${e.reason}`);process.exit(2);}
const {config}=result;
// 靜態根目錄（Req 16.2）：只由 CAMPING_DIST 決定（相對路徑以工作目錄為基準，預設 dist），
// 不依賴原始碼目錄結構或 import.meta.url，打包成 /app/server/serve.js 後行為相同。
const distRoot=resolve(process.env.CAMPING_DIST||'dist');
if(!existsSync(resolve(distRoot,'index.html'))){console.error('設定錯誤 CAMPING_DIST: 找不到前端建置成品 index.html（請先執行 bun run build）');process.exit(2);}
// Setup_Token（Req 9.2）：非 loopback 綁定時啟用；未提供時由 guard 產生並只輸出至 stdout 一次。
let setup;
try{setup=createSetupGuard({bindAddress:config.bindAddress,setupToken:config.setupToken??undefined});}
catch(err){console.error(err?.code==='SETUP_TOKEN_TOO_SHORT'?'設定錯誤 CAMPING_SETUP_TOKEN: 長度不足':'設定錯誤 CAMPING_SETUP_TOKEN: 無法建立設定碼保護');process.exit(2);}
// Req 11.1：不再讀取 CAMPING_DB（只警告，不輸出其值）。
if(process.env.CAMPING_DB!==undefined)console.warn('警告 CAMPING_DB 已忽略：資料庫改由 CAMPING_DATABASE_* 設定');
// Database（Req 11.5）：1–5 秒間隔重試，總計 30 秒；失敗時訊息只含主機與連接埠，結束碼 3。
let db;
try{db=await connectWithRetry(config.database,{log:m=>console.warn(m)});}
catch(err){
 console.error(err instanceof DatabaseConnectError?`${err.message}（${err.code}）`:`無法連線至 Database ${describeTarget(config.database)}`);
 process.exit(3);
}
// 帳號服務選項（任務 18.4 的 server/accounts.js 依此實作）：
//   registrationPolicySeed  'open'｜'closed'｜null（CAMPING_REGISTRATION；管理員儲存的政策優先，未設定時為 open）
//   receiptAiPolicySeed     'all'｜'admins'｜'off'｜null（管理員儲存的政策優先）
//   aiCost                  AI_Cost_Config（用量上限與模型設定，server/ai-cost.js 的 quotaDecision 使用）
const accounts=await createAccountService({
 db,setup,
 receiptAi:createReceiptAi({env:process.env,cost:config.aiCost}),
 aiCost:config.aiCost,
 registrationPolicySeed:config.registrationPolicySeed,
 receiptAiPolicySeed:config.receiptAiPolicySeed,
});
const server=Bun.serve({hostname:config.bindAddress,port:config.port,maxRequestBodySize:4_194_304,fetch:createHttpHandler({
 // Req 11.6：/healthz 以 SELECT 1 檢查連線，2 秒內未成功即視為失敗。
 root:distRoot,accounts,allowedHosts:config.allowedHosts,trustedProxies:config.trustedProxies,health:()=>db.ping(2000),
})});
// 啟動訊息（Req 8.5）：只含 bind、實際連接埠與 Allowed_Hosts；前綴供 check-accounts.mjs 等待。
console.log(`Camping accounts ready: ${redactedSummary({...config,port:server.port})}`);
// 應用層設定摘要（Req 26.17）：只含政策值與其來源，不含秘密。
console.log(`Camping accounts settings: ${policySummary(config,await accounts.receiptAiPolicy?.(),await accounts.registrationPolicy?.())}`);
console.log(isLoopbackAddress(config.bindAddress)
 ?'First visit: create your own administrator. No default credentials. Listening on loopback only.'
 :'First visit: create your own administrator with the setup token. No default credentials.');
let stopping=false;
async function shutdown(){
 if(stopping)return;
 stopping=true;
 server.stop(true);
 accounts.close();
 await db.close(); // sql.close({ timeout: 5 })
 process.exit(0);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
