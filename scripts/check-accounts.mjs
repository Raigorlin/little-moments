// 瀏覽器測試 harness（Requirement 3.8、3.9、5.3、5.6、5.7、5.9；design.md Components §7）。以原生 Node 執行：
//   node scripts/check-accounts.mjs [playwright test 參數…]
//
// 必要環境變數：
//   CHROME_PATH、CAMPING_BUN     Chromium 與 Bun 可執行檔的絕對路徑；未設定、空字串、不存在或不可執行即失敗，
//                                不提供任何預設路徑（Req 3.9）。檢查在建立資料庫、啟動伺服器或瀏覽器之前完成。
//   CAMPING_TEST_DATABASE_*      Ephemeral_Database 的管理連線（見 tests/support/pg.js）；帳號需 CREATEDB 權限。
//
// 流程：
//   1. 以 ci/verify-env.mjs 驗證 CHROME_PATH／CAMPING_BUN（錯誤只列變數名與原因）。
//   2. 建立拋棄式 DATABASE lm_e2e_<random>（tests/support/e2e-db.mjs），以 scripts/migrate.mjs 套用全部遷移，
//      之後以 CAMPING_DATABASE_* 指向該 DATABASE 啟動 scripts/serve.mjs（port 5181、loopback）。
//      App_Server 沒有設定 search_path 的環境變數，因此用獨立 DATABASE 而非 schema 隔離。
//   3. 遷移與伺服器的 stdout/stderr 寫入 reports/server.log。
//   4. 首次管理員設定 → 建立 member 帳號池（tests/support/e2e-seed-members.mjs）→ Playwright
//      （playwright.config.js，retries 0）→ 預覽截圖。
//   5. 不論成功、失敗或 SIGINT／SIGTERM，都停止伺服器並 DROP 該 DATABASE。
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as fs from 'node:fs';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {verifyEnv} from '../ci/verify-env.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PORT='5181';
const base=`http://127.0.0.1:${PORT}`;

// 1. 執行檔檢查（Req 3.9）：在任何子程序或瀏覽器啟動之前。
const envCheck=verifyEnv(process.env,fs);
if(!envCheck.ok){
 for(const p of envCheck.problems)console.error(`測試環境變數無效 ${p.name}: ${p.reason}`);
 process.exit(1);
}
const bun=process.env.CAMPING_BUN;
const chromePath=process.env.CHROME_PATH;
const {chromium}=await import('playwright');

// 子程序的基礎環境：移除任何可能指向真實環境的資料庫與網路設定、收據 AI 憑證，以及會改變測試預期的應用層政策
// （註冊政策、收據 AI 政策與用量上限；測試以預設值執行）。
const STRIP=/^(CAMPING_DATABASE_|CAMPING_DB$|CAMPING_BIND_ADDRESS$|CAMPING_ALLOWED_HOSTS$|CAMPING_TRUSTED_PROXIES$|CAMPING_SETUP_TOKEN$|CAMPING_OPENAI_|CAMPING_REGISTRATION$|CAMPING_RECEIPT_AI_|CAMPING_E2E_POOL_)/;
// member 帳號池（tests/support/e2e-seed-members.mjs、tests/support/e2e-pool.js）：註冊 API 依用戶端 IP 每小時限 20 次，
// 而所有 E2E 請求都來自 127.0.0.1，因此預先在拋棄式 DATABASE 建立合成帳號供測試認領登入，不放寬任何限速。
const POOL_PREFIX='e2e-m';
const POOL_SIZE=150; // 完整套件（desktop＋mobile，含 security-harden 的邀請、安全頁面與 XSS 測試）約需 80 個
const poolPassword=`E2E-${randomBytes(18).toString('base64url')}`;
const baseEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!STRIP.test(k)));
const reports=resolve(root,'reports');
// 收據 AI 停用：不提供金鑰，金鑰檔指向不存在的路徑（否則 server/receipt-ai.js 會讀取 repository 的 .secrets/openai_api_key）。
const noAi={CAMPING_OPENAI_API_KEY:'',CAMPING_OPENAI_API_KEY_FILE:resolve(reports,'no-openai-key','openai_api_key')};
fs.mkdirSync(reports,{recursive:true});
const serverLog=fs.createWriteStream(resolve(reports,'server.log'),{flags:'w'});
const logLine=text=>serverLog.write(`[${new Date().toISOString()}] ${text}\n`);

/** 以 Bun 執行腳本；輸出寫入 server.log，回傳 {code, stdout}。 */
function runBun(args,{env=baseEnv,capture=false}={}){
 return new Promise((done,reject)=>{
  const child=spawn(bun,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let stdout='';
  child.stdout.on('data',d=>{if(capture)stdout+=d;else serverLog.write(d);});
  child.stderr.on('data',d=>serverLog.write(d));
  child.once('error',reject);
  child.once('exit',code=>done({code,stdout}));
 });
}

let dbName=null,server=null,browser=null,cleaning=null,poolDir=null;
async function cleanup(){
 if(cleaning)return cleaning;
 cleaning=(async()=>{
  if(browser){try{await browser.close();}catch{}browser=null;}
  if(poolDir){await rm(poolDir,{recursive:true,force:true}).catch(()=>{});poolDir=null;}
  if(server&&server.exitCode===null){
   const exited=new Promise(r=>server.once('exit',r));
   server.kill('SIGTERM');
   await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);
   if(server.exitCode===null)server.kill('SIGKILL');
  }
  if(dbName){
   const {code}=await runBun([resolve(root,'tests/support/e2e-db.mjs'),'drop',dbName]);
   if(code===0)logLine(`dropped e2e database ${dbName}`);
   else{console.error(`無法刪除 E2E 資料庫 ${dbName}（結束碼 ${code}），請手動 DROP DATABASE`);process.exitCode||=1;}
   dbName=null;
  }
  await new Promise(r=>serverLog.end(r));
 })();
 return cleaning;
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{console.error(`收到 ${signal}，清理測試環境`);await cleanup();process.exit(130);});

try{
 // 2. 拋棄式 DATABASE 與遷移。
 const created=await runBun([resolve(root,'tests/support/e2e-db.mjs'),'create'],{capture:true});
 const name=created.stdout.trim();
 if(created.code!==0||!/^lm_e2e_[0-9a-f]{16}$/.test(name))throw new Error(`無法建立 E2E 資料庫（結束碼 ${created.code}，詳見 reports/server.log）`);
 dbName=name;
 logLine(`created e2e database ${dbName}`);
 const e=process.env;
 const dbEnv={
  CAMPING_DATABASE_HOST:e.CAMPING_TEST_DATABASE_HOST,
  CAMPING_DATABASE_NAME:dbName,
  CAMPING_DATABASE_USER:e.CAMPING_TEST_DATABASE_USER,
  CAMPING_DATABASE_PASSWORD:e.CAMPING_TEST_DATABASE_PASSWORD,
  ...(e.CAMPING_TEST_DATABASE_PORT?{CAMPING_DATABASE_PORT:e.CAMPING_TEST_DATABASE_PORT}:{}),
  ...(e.CAMPING_TEST_DATABASE_SSLMODE?{CAMPING_DATABASE_SSLMODE:e.CAMPING_TEST_DATABASE_SSLMODE}:{}),
 };
 const serverEnv={...baseEnv,...noAi,...dbEnv,PORT,CAMPING_BIND_ADDRESS:'127.0.0.1'};
 logLine('running migrations');
 const migrated=await runBun([resolve(root,'scripts/migrate.mjs')],{env:serverEnv});
 if(migrated.code!==0)throw new Error(`遷移失敗（結束碼 ${migrated.code}，詳見 reports/server.log）`);

 // 3. 伺服器；日誌寫入 reports/server.log。
 logLine('starting server');
 server=spawn(bun,[resolve(root,'scripts/serve.mjs')],{cwd:root,env:serverEnv,stdio:['ignore','pipe','pipe']});
 await new Promise((done,reject)=>{
  let buffer='';
  server.stdout.on('data',data=>{serverLog.write(data);buffer+=data;if(buffer.includes('Camping accounts ready:')){buffer='';done();}else if(buffer.length>65536)buffer=buffer.slice(-1024);});
  server.stderr.on('data',d=>serverLog.write(d));
  server.once('error',reject);
  server.once('exit',code=>reject(new Error(`Test server exited ${code}（詳見 reports/server.log）`)));
 });
 console.log(`Test server ready on ${base} (isolated e2e database, log: reports/server.log).`);

 // 4. 首次管理員設定 → Playwright → 預覽截圖。
 browser=await chromium.launch({headless:true,executablePath:chromePath});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto(base+'/setup');await page.getByLabel('帳號名稱（網址用）',{exact:true}).fill('qa-admin');await page.getByLabel('顯示名稱',{exact:true}).fill('測試管理員');await page.getByLabel('密碼',{exact:true}).fill('Local-Only-Test-Pass-2026');await page.getByLabel('再次輸入密碼',{exact:true}).fill('Local-Only-Test-Pass-2026');await page.getByRole('button',{name:'建立管理員帳號',exact:true}).click();await page.waitForURL('**/qa-admin/home');
 console.log('First-admin setup form passed on isolated e2e database.');
 await browser.close();browser=null;
 // member 帳號池必須在首次管理員設定之後建立（使用者數 ≥ 1 時 /setup 不再提供設定表單）。
 const seeded=await runBun([resolve(root,'tests/support/e2e-seed-members.mjs'),POOL_PREFIX,String(POOL_SIZE)],{env:{...serverEnv,CAMPING_E2E_POOL_PASSWORD:poolPassword}});
 if(seeded.code!==0)throw new Error(`無法建立 E2E member 帳號池（結束碼 ${seeded.code}，詳見 reports/server.log）`);
 poolDir=await mkdtemp(resolve(tmpdir(),'lm-e2e-pool-'));
 const poolEnv={CAMPING_E2E_POOL_DIR:poolDir,CAMPING_E2E_POOL_PREFIX:POOL_PREFIX,CAMPING_E2E_POOL_SIZE:String(POOL_SIZE),CAMPING_E2E_POOL_PASSWORD:poolPassword};
 const args=process.argv.slice(2);
 const code=await new Promise((done,reject)=>{const child=spawn(process.execPath,[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--config',resolve(root,'playwright.config.js'),...args],{cwd:root,env:{...baseEnv,...poolEnv,CAMPING_BASE_URL:base},stdio:'inherit'});child.once('error',reject);child.once('exit',done);});
 if(code)process.exitCode=code;
 if(!code){
  browser=await chromium.launch({headless:true,executablePath:chromePath});
  const p=await browser.newPage({viewport:{width:1440,height:1000}});
  await p.goto(base+'/login');await p.getByLabel('帳號名稱',{exact:true}).fill('qa-admin');await p.getByLabel('密碼',{exact:true}).fill('Local-Only-Test-Pass-2026');await p.getByRole('button',{name:'登入',exact:true}).click();await p.waitForURL('**/qa-admin/home');
  const send=async(path,body)=>{const r=await p.request.post(base+path,{headers:{Origin:base,'Content-Type':'application/json'},data:body});if(!r.ok())throw Error('Preview seed rejected '+await r.text());return r.json();};
  await send('/api/trips',{title:'雲海裡，住一晚',destination:'山間小日子營地',startDate:'2026-11-20',endDate:'2026-11-22',description:'把好日子帶上山，一起看星星。',note:'山上記得保暖',status:'planning',coverKind:'camp'});
  await send('/api/trips',{title:'湖畔的夏日回信',destination:'日月潭水岸',startDate:'2026-07-18',endDate:'2026-07-19',description:'記得那一晚，湖邊的風很溫柔。',note:'第一次湖畔露營',status:'completed',coverKind:'lake'});
  await mkdir(resolve(root,'previews'),{recursive:true});await p.reload();await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:resolve(root,'previews/accounts-home-desktop.png'),fullPage:true});
  await p.setViewportSize({width:390,height:844});await p.screenshot({path:resolve(root,'previews/accounts-home-mobile.png'),fullPage:true});
  await p.locator('[data-action="acct-new-trip"]').click();await p.screenshot({path:resolve(root,'previews/accounts-new-card-mobile.png')});await p.getByRole('button',{name:'取消',exact:true}).click();
  await p.setViewportSize({width:1440,height:1000});await p.goto(base+'/admin');await p.locator('#admin-users .acct-user-row').first().waitFor();await p.screenshot({path:resolve(root,'previews/accounts-admin-desktop.png')});
  await p.goto(base+'/demo/#/trip');await p.locator('[data-tab="shopping"]').first().click();await p.locator('.shopping-list').screenshot({path:resolve(root,'previews/accounts-assignee-brackets.png')});
  console.log('Saved isolated account homepage, admin and bracket preview screenshots.');
 }
}catch(err){
 console.error(err?.message??err);
 process.exitCode||=1;
}finally{
 await cleanup();
}
