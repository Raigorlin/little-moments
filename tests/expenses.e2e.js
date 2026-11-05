import {test,expect} from '@playwright/test';
import {fixture,seedLedger,manualRow,assertTripUnchanged} from './expense-fixture.js';
const panel=p=>p.locator('.xp-panel');
const action=(p,key)=>panel(p).locator(`[data-xp="${key}"]`);
const form=p=>panel(p).locator('[data-xp-form="expense"]');
const field=(p,key)=>form(p).locator(`[data-xp-field="${key}"]`);
async function ready(p){await expect(action(p,'new-expense')).toBeEnabled();}
async function draft(p,title='營地晚餐食材',amount='300'){
 await ready(p);await action(p,'new-expense').click();await field(p,'title').fill(title);await field(p,'amount').fill(amount);await field(p,'date').fill('2026-11-19');await field(p,'payerId').selectOption('p1');
 await action(p,'form-none').click();await field(p,'participantIds').first().waitFor();
 await form(p).locator('[data-xp-field="participantIds"][value="p1"]').check();await form(p).locator('[data-xp-field="participantIds"][value="p2"]').check();
}
async function save(p){await form(p).getByRole('button',{name:'儲存支出',exact:true}).click();await expect(form(p)).toHaveCount(0);await expect(panel(p).locator('.xp-notice')).toContainText('已儲存');}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('manual expense saves cents and chosen participants, shopping link never changes purchased status',async({page:p})=>{
 const f=await fixture(p);await draft(p,'牛肉片','300.01');await field(p,'shoppingId').selectOption('s1');await save(p);
 const {ledger:l}=await f.ledger();expect(l.revision).toBe(1);expect(l.expenses).toHaveLength(1);expect(l.expenses[0]).toMatchObject({title:'牛肉片',amountCents:30001,payerId:'p1',participantIds:['p1','p2'],shoppingId:'s1',source:'manual'});
 await expect(panel(p).locator('.xp-total')).toContainText('NT$300.01');await assertTripUnchanged(f);
 await p.reload();await p.locator('.section-tabs [data-tab="expenses"]').click();await ready(p);await expect(panel(p)).toContainText('牛肉片');expect((await f.ledger()).ledger).toEqual(l);
});

test('invalid money and no participants never save; cancel and tab navigation preserve or discard only with confirmation',async({page:p})=>{
 const f=await fixture(p);await draft(p,'保留的草稿','0');await form(p).getByRole('button',{name:'儲存支出',exact:true}).click();await expect(form(p).locator('.form-error')).not.toBeEmpty();expect((await f.ledger()).ledger.revision).toBe(0);
 await field(p,'amount').fill('300');await action(p,'form-none').click();await form(p).getByRole('button',{name:'儲存支出',exact:true}).click();await expect(form(p).locator('.form-error')).toContainText('至少選擇');
 p.once('dialog',d=>d.dismiss());await p.locator('.section-tabs [data-tab="schedule"]').click();await expect(field(p,'title')).toHaveValue('保留的草稿');
 p.once('dialog',d=>d.accept());await p.locator('.section-tabs [data-tab="schedule"]').click();await expect(panel(p)).toHaveCount(0);await assertTripUnchanged(f);expect((await f.ledger()).ledger.revision).toBe(0);
});

test('stale ledger conflict retains form, explicit reload keeps draft, resubmission preserves other person entries',async({page:p})=>{
 const f=await fixture(p);await draft(p,'我的草稿','100');await seedLedger(p,f,[manualRow('other',{title:'其他人的支出'})]);
 await form(p).getByRole('button',{name:'儲存支出',exact:true}).click();await expect(panel(p).locator('[data-xp-state="conflict"]')).toBeVisible();await expect(field(p,'title')).toHaveValue('我的草稿');expect((await f.ledger()).ledger.expenses).toHaveLength(1);
 p.once('dialog',d=>d.accept());await panel(p).locator('[data-xp-state="conflict"] [data-xp="reload"]').click();await expect(panel(p).locator('[data-xp-state="conflict"]')).toHaveCount(0);await expect(field(p,'title')).toHaveValue('我的草稿');await save(p);
 const {ledger:l}=await f.ledger();expect(l.expenses.map(x=>x.title)).toEqual(['其他人的支出','我的草稿']);await assertTripUnchanged(f);
});

test('lost success response retries the identical request and never books the money twice',async({page:p})=>{
 const f=await fixture(p);await draft(p);const payloads=[];let lost=false;
 await p.route('**/api/trips/*/ledger',async route=>{if(route.request().method()!=='PUT')return route.continue();payloads.push(route.request().postDataJSON());if(!lost){lost=true;const result=await route.fetch();expect(result.ok()).toBe(true);await result.dispose();return route.abort('failed');}return route.continue();});
 await form(p).getByRole('button',{name:'儲存支出',exact:true}).click();await expect(panel(p).locator('[data-xp-state="pending"]')).toBeVisible();expect((await f.ledger()).ledger.expenses).toHaveLength(1);
 await action(p,'retry').click();await expect(form(p)).toHaveCount(0);const {ledger:l}=await f.ledger();expect(l.revision).toBe(1);expect(l.expenses).toHaveLength(1);expect(payloads).toHaveLength(2);expect(payloads[1]).toEqual(payloads[0]);await assertTripUnchanged(f);
});

test('backend unavailable and demo mode fail closed instead of writing local money records',async({page:p})=>{
 await p.route('**/api/trips/*/ledger',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'未知 API 路徑'})}));
 const f=await fixture(p);await expect(panel(p).locator('[data-xp-state="unavailable"]')).toBeVisible();await expect(action(p,'new-expense')).toHaveCount(0);await p.unroute('**/api/trips/*/ledger');expect((await f.ledger()).ledger.revision).toBe(0);
 await p.goto('/demo/#/trip');await p.locator('.section-tabs [data-tab="expenses"]').click();await expect(panel(p).locator('[data-xp-state="demo"]')).toContainText('分帳需要登入帳號');await expect(action(p,'new-expense')).toHaveCount(0);await assertTripUnchanged(f);
});


test('repayment lowers outstanding balance, and owner removal recalculates totals after confirmation',async({page:p})=>{
 const f=await fixture(p);await draft(p,'共同食材','300');await save(p);
 const bal=id=>panel(p).locator(`[data-xp-person="${id}"]`);
 await expect(bal('p1')).toContainText('應收回 NT$150');await expect(bal('p2')).toContainText('需補 NT$150');
 await panel(p).locator('[data-xp-transfer="0"] [data-xp="settle-suggested"]').click();const settle=panel(p).locator('[data-xp-form="settlement"]');
 await expect(settle.locator('[data-xp-field="fromId"]')).toHaveValue('p2');await expect(settle.locator('[data-xp-field="toId"]')).toHaveValue('p1');await expect(settle.locator('[data-xp-field="amount"]')).toHaveValue('150');
 await settle.getByRole('button',{name:'記錄這筆還款'}).click();await expect(settle).toHaveCount(0);await expect(bal('p2')).toContainText('已結清');expect((await f.ledger()).ledger.settlements).toHaveLength(1);
 await panel(p).locator('[data-xp-expense] [data-xp="ask-remove-expense"]').click();await expect(panel(p).locator('.xp-row.is-confirm')).toContainText('確定從帳本移除');
 await panel(p).locator('.xp-row.is-confirm [data-xp="cancel-confirm"]').click();expect((await f.ledger()).ledger.expenses).toHaveLength(1);
 await panel(p).locator('[data-xp-expense] [data-xp="ask-remove-expense"]').click();await panel(p).locator('.xp-row.is-confirm [data-xp="confirm-remove"]').click();await expect(panel(p).locator('[data-xp-expense]')).toHaveCount(0);
 expect((await f.ledger()).ledger.expenses).toHaveLength(0);await assertTripUnchanged(f);
});

test('receipt text is re-parsed, every corrected item is explicitly reviewed, then duplicate photo is blocked',async({page:p})=>{
 const f=await fixture(p);await ready(p);await action(p,'open-receipt').click();
 const file=p.locator('.xp-receipt input[data-xp-file]');const png=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=400;c.height=100;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,400,100);return c.toDataURL('image/png').split(',')[1];});
 const image={name:'receipt-manual-review.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')};
 await p.route('**/assets/ocr/worker.min.js',route=>route.fulfill({status:404,contentType:'text/javascript',body:'missing'}));await file.setInputFiles(image);
 await expect(panel(p).locator('[data-xp-receipt-note]')).toContainText('辨識失敗',{timeout:20000});
 const raw=p.locator('textarea[data-xp-receipt="text"]');await raw.fill('高麗菜 80\n雞蛋 1O0\n牛肉片 210\n總計 390');await action(p,'reparse').click();
 const rows=panel(p).locator('li[data-xp-line]');await expect(rows).toHaveCount(3);await expect(rows.nth(1).locator('input[data-xp-row-key="amount"]')).toHaveValue('');await rows.nth(1).locator('input[data-xp-row-key="amount"]').fill('100');await rows.nth(1).locator('input[data-xp-row-key="selected"]').check();
 await panel(p).locator('[data-xp-receipt="date"]').fill('2026-11-19');await panel(p).locator('[data-xp-receipt="payerId"]').selectOption('p1');
 await panel(p).locator('[data-xp-receipt="participantIds"][value="p1"]').check();await panel(p).locator('[data-xp-receipt="participantIds"][value="p2"]').check();
 await panel(p).locator('[data-xp-receipt="verified"]').check();await expect(panel(p).locator('.xp-rc-summary')).toContainText('NT$390');
 await action(p,'commit-receipt').click();await expect(panel(p).locator('li[data-xp-expense]')).toHaveCount(3);
 const {ledger:l}=await f.ledger();expect(l.expenses.map(x=>x.amountCents)).toEqual([8000,10000,21000]);expect(l.expenses.every(x=>x.source==='receipt'&&x.receiptId===l.expenses[0].receiptId)).toBe(true);expect(new Set(l.expenses.map(x=>x.receiptLine)).size).toBe(3);await assertTripUnchanged(f);
 await action(p,'open-receipt').click();await p.locator('.xp-receipt input[data-xp-file]').setInputFiles(image);await expect(panel(p).locator('[data-xp-receipt-error]')).toContainText('不能再次');expect((await f.ledger()).ledger.revision).toBe(1);
});

test('desktop, mobile and dark theme expense view is readable without horizontal scroll',async({page:p})=>{
 const f=await fixture(p);await draft(p,'共同食材','240');await save(p);
 for(const theme of ['light','dark']){await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [320,390,768,1440]){
  await p.setViewportSize({width,height:950});await expect(panel(p).locator('[data-xp-section="balances"]')).toBeVisible();await expect(panel(p).locator('[data-xp-expense]')).toBeVisible();
  expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if(width===390||width===1440)await panel(p).screenshot({path:`previews/expenses-${theme}-${width}.png`});
 }}await assertTripUnchanged(f);
});


test('receipt discrepancy and missing review confirmation block writes until corrected',async({page:p})=>{
 const f=await fixture(p);await ready(p);await action(p,'open-receipt').click();
 const png=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=400;c.height=100;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,400,100);return c.toDataURL('image/png').split(',')[1];});
 await p.route('**/assets/ocr/worker.min.js',route=>route.fulfill({status:404,contentType:'text/javascript',body:'missing'}));
 await p.locator('.xp-receipt input[data-xp-file]').setInputFiles({name:'receipt-diff.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await expect(panel(p).locator('[data-xp-receipt-note]')).toContainText('辨識失敗',{timeout:20000});
 await panel(p).locator('textarea[data-xp-receipt="text"]').fill('牛肉片 210\n雞蛋 65\n總計 315');await action(p,'reparse').click();
 await panel(p).locator('[data-xp-receipt="date"]').fill('2026-11-19');await panel(p).locator('[data-xp-receipt="payerId"]').selectOption('p1');await panel(p).locator('[data-xp-receipt="participantIds"][value="p1"]').check();
 await action(p,'commit-receipt').click();await expect(panel(p).locator('[data-xp-receipt-error]')).toContainText('逐項核對');expect((await f.ledger()).ledger.revision).toBe(0);
 await panel(p).locator('[data-xp-receipt="verified"]').check();await action(p,'commit-receipt').click();await expect(panel(p).locator('[data-xp-receipt-error]')).toContainText('不一致');expect((await f.ledger()).ledger.revision).toBe(0);
 await panel(p).locator('[data-xp-receipt="totalInput"]').fill('275');await action(p,'commit-receipt').click();await expect(panel(p).locator('li[data-xp-expense]')).toHaveCount(2);expect((await f.ledger()).ledger.expenses.reduce((a,x)=>a+x.amountCents,0)).toBe(27500);await assertTripUnchanged(f);
});
