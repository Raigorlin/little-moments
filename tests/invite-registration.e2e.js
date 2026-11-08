import {test,expect} from './local-planner-fixture.js';
const testBase=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const adminName='qa-admin';
let serial=0;
const slug=()=>`qa-${Date.now().toString(36)}-${++serial}-${Math.random().toString(36).slice(2,6)}`;
const fields={title:'山嵐邀請測試',destination:'雲杉營地',startDate:'2026-10-02',endDate:'2026-10-04',description:'一起去看山。',note:'',coverKind:'camp',status:'planning'};
async function api(page,path,method='GET',body){const res=await page.request.fetch(testBase+path,{method,headers:body?{'Content-Type':'application/json','Origin':testBase}:{},data:body});return {status:res.status(),data:await res.json()};}
async function member(page,displayName='測試露友'){const username=slug();const r=await api(page,'/api/register','POST',{username,displayName,password});expect(r.status).toBeLessThan(300);return r.data.user;}
async function ownerInvite(page,extra={}){
 const owner=await member(page,extra.displayName);
 const r=await api(page,'/api/trips','POST',{...fields,...extra.trip});expect(r.status).toBeLessThan(300);
 const invite=await api(page,`/api/trips/${r.data.trip.id}/invites`,'POST',{});expect(invite.status).toBe(201);
 return {owner,trip:r.data.trip,invite:invite.data};
}
test.beforeAll(async({browser,baseURL})=>{
 if(!baseURL||new URL(baseURL).port!=='5181')throw new Error('Account browser tests must use the isolated test server on port 5181.');
 const page=await browser.newPage();
 const session=await api(page,'/api/session');
 if(session.data.needsSetup){const r=await api(page,'/api/setup','POST',{username:adminName,displayName:'測試管理員',password});expect([200,201,409]).toContain(r.status);}
 await page.close();
});

// Req 14.1, 14.13, 15.9, 17.3
test('signed-out visitor sees the preview above the form, registers, lands on the trip; a second visitor gets the invalid-link page',async({page,browser})=>{
 const {trip,invite}=await ownerInvite(page,{displayName:'山嵐主揪'});
 const first=await browser.newContext({baseURL:testBase}),second=await browser.newContext({baseURL:testBase});
 try{
  const v=await first.newPage();await v.goto(invite.urlPath);
  const content=v.locator('.invite-content');const form=content.locator('form[data-form="acct-invite-register"]');
  await expect(form).toBeVisible();
  const heading=content.getByRole('heading',{name:fields.title,exact:true});await expect(heading).toBeVisible();
  await expect(content).toContainText('2026年10月2日');await expect(content).toContainText('2026年10月4日');
  await expect(content).toContainText(fields.destination);
  const inviter=content.getByText('山嵐主揪 邀請你加入',{exact:true});await expect(inviter).toBeVisible();
  const formTop=(await form.boundingBox()).y;
  for(const el of [heading,content.getByText(fields.destination,{exact:true}),inviter])expect((await el.boundingBox()).y).toBeLessThan(formTop);
  const username=slug();
  await v.locator('#invite-username').fill(username);await v.locator('#invite-display').fill('新來的露友');
  await v.locator('#invite-password').fill(password);await v.locator('#invite-confirm').fill(password);
  await v.locator('#join-name').fill('小雲');await v.locator('#join-role').fill('營火守護者');
  await v.getByRole('button',{name:'建立帳號並加入',exact:true}).click();
  await expect(v).toHaveURL(new RegExp(`/${username}/trips/${trip.id}$`));
  await expect(v.getByText(fields.title,{exact:true}).first()).toBeVisible();
  const joined=await api(v,`/api/trips/${trip.id}`);expect(joined.status).toBe(200);expect(joined.data.state.people.some(p=>p.name==='小雲')).toBe(true);

  const w=await second.newPage();await w.goto(invite.urlPath);
  await expect(w.getByRole('heading',{name:'邀請連結無效或已過期',exact:true})).toBeVisible();
  await expect(w.getByRole('link',{name:'前往登入',exact:true})).toHaveAttribute('href','/login');
  await expect(w.locator('form[data-form="acct-invite-register"]')).toHaveCount(0);
  await expect(w.getByText(fields.title,{exact:true})).toHaveCount(0);
 }finally{await first.close();await second.close();}
});

test('invite preview renders trip and inviter text without injecting markup',async({page,browser})=>{
 const title='<img src=x onerror="window.__xss=1">雲海',destination='<b id="inj">營地</b>',displayName='<i id="who">主揪</i>';
 const {invite}=await ownerInvite(page,{displayName,trip:{title,destination}});
 const ctx=await browser.newContext({baseURL:testBase});
 try{
  const v=await ctx.newPage();await v.goto(invite.urlPath);
  const content=v.locator('.invite-content');
  await expect(content.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await expect(content).toContainText(destination);await expect(content).toContainText(`${displayName} 邀請你加入`);
  await expect(content.locator('img, #inj, #who')).toHaveCount(0);
  expect(await v.evaluate(()=>window.__xss)).toBeUndefined();
 }finally{await ctx.close();}
});
