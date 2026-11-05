import {test,expect} from '@playwright/test';
import {fixture,assertTripUnchanged} from './expense-fixture.js';
import {syntheticReceipt} from './receipt-fixture.js';

const SEL={
 start:'[data-xp="open-receipt"]',
 file:'input[type=file][data-xp-file]',
 progress:'progress[id$="-ocr-progress"]',
 status:'[id$="-ocr-status"]',
 cancel:'[data-xp="cancel-ocr"]',
 text:'textarea[data-xp-receipt="text"]',
 row:'li[data-xp-line]',
 amount:'input[data-xp-row-key="amount"]',
 note:'.xp-receipt-main > .xp-notice',
 error:'[data-xp-receipt-error]',
 warnings:'.xp-warn-list',
 total:'[data-xp-receipt="totalInput"]',
 discrepancy:'[data-xp-receipt="discrepancy"]',
 commit:'[data-xp="commit-receipt"]',
};
const WORKER='/assets/ocr/worker.min.js';

// Service workers are blocked so every OCR fetch (page and dedicated worker) is visible to context routing.
test.use({serviceWorkers:'block'});
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

async function open(p,context,baseURL){
 const origin=new URL(baseURL).origin,requests=[],workers=[];
 context.on('request',r=>requests.push({url:r.url(),method:r.method(),body:r.postDataBuffer()}));
 p.on('worker',w=>{const entry={url:w.url(),closed:false};workers.push(entry);w.on('close',()=>{entry.closed=true;});});
 const f=await fixture(p);
 p.on('dialog',d=>d.accept());
 await p.locator(SEL.start).click();
 await expect(p.locator(SEL.file)).toBeAttached();
 const mark=requests.length;
 const ocrWorkers=()=>workers.filter(w=>w.url.endsWith(WORKER));
 const external=()=>requests.filter(r=>!/^(?:data|blob):/.test(r.url)&&new URL(r.url).origin!==origin).map(r=>r.url);
 const since=()=>requests.slice(mark);
 const writes=()=>since().filter(r=>!['GET','HEAD'].includes(r.method)).map(r=>`${r.method} ${r.url}`);
 const workersClosed=async()=>{await expect.poll(()=>ocrWorkers().length,{timeout:10000}).toBeGreaterThan(0);await expect.poll(()=>ocrWorkers().every(w=>w.closed),{timeout:5000}).toBe(true);};
 const assertClean=async()=>{
  expect(external()).toEqual([]);
  expect(writes()).toEqual([]);
  expect(ocrWorkers().every(w=>!w.url.startsWith('blob:'))).toBe(true);
  expect(await p.evaluate(()=>/\[native code\]/.test(Function.prototype.toString.call(window.Worker)))).toBe(true);
  expect((await f.ledger()).ledger.expenses).toEqual([]);
  await assertTripUnchanged(f);
 };
 return {f,since,ocrWorkers,workersClosed,assertClean};
}
const ocrAssets=s=>s().map(r=>new URL(r.url).pathname).filter(x=>x.startsWith('/assets/ocr/'));

test('recognises a synthetic Traditional Chinese receipt in the browser with same-origin assets and no writes',async({page:p,context,baseURL})=>{
 test.setTimeout(150000);
 const o=await open(p,context,baseURL);
 await p.locator(SEL.file).setInputFiles(await syntheticReceipt(p,{chinese:true}));
 await expect(p.locator(SEL.progress)).toBeVisible();
 await expect(p.locator(SEL.text)).toHaveValue(/355/,{timeout:120000});
 const text=await p.locator(SEL.text).inputValue();
 expect(['高麗菜','雞蛋','牛肉片','總計'].filter(word=>text.replace(/\s+/g,'').includes(word)).length).toBeGreaterThanOrEqual(2);
 const amounts=await p.locator(`${SEL.row} ${SEL.amount}`).evaluateAll(xs=>xs.map(x=>x.value));
 expect(amounts.filter(a=>['80','65','210'].includes(a)).length).toBeGreaterThanOrEqual(2);
 expect(amounts).not.toContain('355');
 const assets=ocrAssets(o.since);
 expect(assets).toContain(WORKER);
 expect(assets).toContain('/assets/ocr/lang/chi_tra.traineddata.gz');
 expect(assets).toContain('/assets/ocr/lang/eng.traineddata.gz');
 expect(new Set(assets.filter(x=>x.startsWith('/assets/ocr/core/'))).size).toBe(1);
 expect(o.since().some(r=>r.body&&r.body.length>1000)).toBe(false);
 expect(await p.evaluate(async()=>(await indexedDB.databases?.()||[]).map(d=>d.name))).not.toContain('keyval-store');
 await o.workersClosed();await o.assertClean();
});

// OCR may misread the printed total (e.g. 355 as 395), so the test checks the review safeguards, not exact digits.
test('recognises a synthetic English receipt and a total mismatch is flagged for review, never auto-booked',async({page:p,context,baseURL})=>{
 test.setTimeout(150000);
 const o=await open(p,context,baseURL);
 await p.locator(SEL.file).setInputFiles(await syntheticReceipt(p,{chinese:false}));
 await expect(p.locator(SEL.text)).toHaveValue(/TOTAL[\s\S]*\d{2,4}/i,{timeout:120000});
 const text=(await p.locator(SEL.text).inputValue()).toUpperCase();
 expect(['CABBAGE','EGGS','BEEF'].filter(word=>text.includes(word)).length).toBeGreaterThanOrEqual(2);
 const ocrTotal=Number([...text.matchAll(/TOTAL\D*(\d{2,4})/g)].pop()[1]);
 const amounts=await p.locator(`${SEL.row} ${SEL.amount}`).evaluateAll(xs=>xs.map(x=>x.value));
 expect(amounts.filter(a=>['80','65','210'].includes(a)).length).toBeGreaterThanOrEqual(2);
 expect(amounts).not.toContain(String(ocrTotal));
 const sum=amounts.reduce((acc,a)=>acc+(/^\d+$/.test(a)?Number(a):0),0);
 if(sum!==ocrTotal)await expect(p.locator(SEL.warnings)).toContainText('不符');
 else{await p.locator(SEL.total).fill(String(sum+40));await p.locator(SEL.total).blur();}
 await expect(p.locator(SEL.discrepancy)).toBeVisible();
 await expect(p.locator(SEL.discrepancy)).not.toBeChecked();
 await p.locator(SEL.commit).click();
 await expect(p.locator(SEL.error)).toBeVisible();
 await o.workersClosed();await o.assertClean();
});

test('a missing language file fails fast with a Chinese message and terminates the worker',async({page:p,context,baseURL})=>{
 test.setTimeout(90000);
 await context.route('**/assets/ocr/lang/chi_tra.traineddata.gz',r=>r.fulfill({status:404,contentType:'text/plain',body:'missing'}));
 const o=await open(p,context,baseURL);
 const started=Date.now();
 await p.locator(SEL.file).setInputFiles(await syntheticReceipt(p,{chinese:true}));
 await expect(p.locator(SEL.note)).toContainText('辨識元件載入失敗',{timeout:30000});
 expect(Date.now()-started).toBeLessThan(30000);
 await expect(p.locator(SEL.cancel)).toHaveCount(0);
 await o.workersClosed();await o.assertClean();
});

test('cancel during language loading terminates the native worker immediately',async({page:p,context,baseURL})=>{
 test.setTimeout(90000);
 let held=null;const reached=new Promise(resolve=>{held=resolve;});
 const stalled=[];
 await context.route('**/assets/ocr/lang/*.traineddata.gz',route=>{stalled.push(route);held();});
 const o=await open(p,context,baseURL);
 try{
  await p.locator(SEL.file).setInputFiles(await syntheticReceipt(p,{chinese:true}));
  await reached;
  await expect(p.locator(SEL.status)).toBeVisible();
  await expect(p.locator(SEL.cancel)).toBeVisible();
  await p.locator(SEL.cancel).click();
  await expect(p.locator(SEL.note)).toContainText('已取消辨識');
  await o.workersClosed();
  await expect(p.locator(SEL.text)).toBeEditable();
  await o.assertClean();
 }finally{for(const route of stalled)await route.abort().catch(()=>{});}
});

test('rejects invalid, disguised, oversized and over-pixel images without starting OCR',async({page:p,context,baseURL})=>{
 const o=await open(p,context,baseURL);
 const input=p.locator(SEL.file);
 const png=(w,h)=>{const b=Buffer.alloc(64);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12,'ascii');b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
 await input.setInputFiles({name:'receipt.gif',mimeType:'image/gif',buffer:Buffer.from('GIF89a')});
 await expect(p.locator(SEL.error)).toContainText('JPEG、PNG 或 WebP');
 await input.setInputFiles({name:'huge.png',mimeType:'image/png',buffer:Buffer.concat([png(100,100),Buffer.alloc(10*1024*1024)])});
 await expect(p.locator(SEL.error)).toContainText('10 MB');
 await input.setInputFiles({name:'fake.png',mimeType:'image/png',buffer:Buffer.from('this is not really an image file')});
 await expect(p.locator(SEL.note)).toContainText('只支援 JPEG、PNG 或 WebP 照片');
 await input.setInputFiles({name:'giant.png',mimeType:'image/png',buffer:png(5000,4001)});
 await expect(p.locator(SEL.note)).toContainText('2,000 萬像素');
 expect(ocrAssets(o.since)).toEqual([]);
 expect(o.ocrWorkers()).toEqual([]);
 await o.assertClean();
});
