import {test,expect} from './local-planner-fixture.js';
import {fixture,assertTripUnchanged} from './expense-fixture.js';
import {syntheticReceipt} from './receipt-fixture.js';

const start='[data-xp="open-receipt"]';
const file='input[type=file][data-xp-file]';
const note='.xp-receipt-main > .xp-notice';
const statusPath='**/api/trips/**/receipt-ai';
const WORKER='/assets/ocr/worker.min.js';
const response={
 store:'測試超市',date:'2026-11-04',totalCents:35500,
 items:[
  {lineId:'item-1',title:'高麗菜',amount:'80',warning:''},
  {lineId:'item-2',title:'雞蛋',amount:'65',warning:''},
  {lineId:'item-3',title:'牛肉片',amount:'210',warning:''}
 ],
 warnings:[]
};
test.use({serviceWorkers:'block'});
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

async function open(page){
 const f=await fixture(page);
 await page.locator(start).click();
 await expect(page.locator(file)).toBeAttached();
 return f;
}

test('selecting a receipt automatically sends it to GPT-6 Luna and displays editable candidates',async({page,context})=>{
 const calls=[];
 await context.route(statusPath,async route=>{
  const request=route.request();
  calls.push({method:request.method(),headers:request.headers(),body:request.postDataBuffer()});
  if(request.method()==='GET')return route.fulfill({contentType:'application/json',body:JSON.stringify({enabled:true,provider:'OpenAI',modelId:'gpt-6-luna',maxImageBytes:3.5*1024*1024})});
  return route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
 });
 const f=await open(page);
 await expect(page.locator('.xp-receipt')).toContainText('自動傳送至 OpenAI');
 await page.locator(file).setInputFiles(await syntheticReceipt(page,{chinese:true}));
 await expect(page.locator('.xp-receipt')).toContainText('OpenAI 辨識完成');
 await expect(page.locator('li[data-xp-line]')).toHaveCount(3);
 await expect(page.locator('input[data-xp-row-key="title"]').first()).toHaveValue('高麗菜');
 expect(calls.map(x=>x.method)).toEqual(['GET','POST']);
 expect(calls[1].headers['x-receipt-consent']).toBe('openai-v1');
 expect(calls[1].headers['x-camping-user-id']).toBeTruthy();
 expect(calls[1].headers['content-type']).toBe('image/jpeg');
 expect(calls[1].body.length).toBeGreaterThan(100);
 expect(await page.locator('[data-xp="rerun-ocr"]').count()).toBe(0);
 expect((await context.pages()[0].evaluate(()=>performance.getEntriesByType('resource').map(x=>new URL(x.name).pathname))).filter(x=>x.startsWith('/assets/ocr/'))).toEqual([]);
 expect((await f.ledger()).ledger.expenses).toEqual([]);
 await assertTripUnchanged(f);
});

test('OpenAI failure stops recognition without local OCR or automatic retry',async({page,context})=>{
 const calls=[];
 await context.route(statusPath,async route=>{
  const request=route.request();
  calls.push(request.method());
  if(request.method()==='GET')return route.fulfill({contentType:'application/json',body:JSON.stringify({enabled:true,provider:'OpenAI',modelId:'gpt-6-luna',maxImageBytes:3.5*1024*1024})});
  return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'AI 辨識尚未設定'})});
 });
 const f=await open(page);
 await page.locator(file).setInputFiles(await syntheticReceipt(page,{chinese:true}));
 await expect(page.locator(note)).toContainText('OpenAI 辨識未完成');
 expect(calls).toEqual(['GET','POST']);
 expect(await page.locator('[data-xp="rerun-ocr"]').count()).toBe(0);
 expect((await page.locator('body').evaluate(()=>performance.getEntriesByType('resource').map(x=>new URL(x.name).pathname))).filter(x=>x.startsWith('/assets/ocr/'))).toEqual([]);
 expect((await f.ledger()).ledger.expenses).toEqual([]);
 await assertTripUnchanged(f);
});
