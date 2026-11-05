import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base='http://127.0.0.1:5181';
const bun=process.env.CAMPING_BUN;
if(!bun)throw new Error('CAMPING_BUN must name the installed Bun executable.');
const server=spawn(bun,[resolve(root,'scripts/serve.mjs')],{cwd:root,env:{...process.env,PORT:'5181',CAMPING_DB:':memory:',CAMPING_BEDROCK_REGION:'',CAMPING_BEDROCK_MODEL_ID:'',CAMPING_BEDROCK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let browser;
try{
 await new Promise((done,reject)=>{server.stdout.on('data',data=>{process.stdout.write(data);if(String(data).includes('Camping accounts ready:'))done();});server.stderr.on('data',d=>process.stderr.write(d));server.once('error',reject);server.once('exit',code=>reject(new Error(`Test server exited ${code}`)));});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto(base+'/setup');await page.getByLabel('帳號名稱（網址用）',{exact:true}).fill('qa-admin');await page.getByLabel('顯示名稱',{exact:true}).fill('測試管理員');await page.getByLabel('密碼',{exact:true}).fill('Local-Only-Test-Pass-2026');await page.getByLabel('再次輸入密碼',{exact:true}).fill('Local-Only-Test-Pass-2026');await page.getByRole('button',{name:'建立管理員帳號',exact:true}).click();await page.waitForURL('**/qa-admin/home');
 console.log('First-admin setup form passed on isolated in-memory database.');
 await browser.close();browser=null;
 const args=process.argv.slice(2);
 const code=await new Promise((done,reject)=>{const child=spawn(process.execPath,[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--config',resolve(root,'playwright.config.js'),...args],{cwd:root,env:{...process.env,CAMPING_BASE_URL:base},stdio:'inherit'});child.once('error',reject);child.once('exit',done);});
 if(code)process.exitCode=code;
 if(!code){
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
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
}finally{if(browser)await browser.close();server.kill('SIGTERM');}
