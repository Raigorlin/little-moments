import {test,expect} from './local-planner-fixture.js';
import {poolMember} from './support/e2e-pool.js';
// Invitation_Dialog open-link list (Req 13.20, 16.10, 16.11, 19.1, 19.2, 19.10–19.13).
const testBase=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const adminName='qa-admin';
const fields={title:'邀請清單測試',destination:'松林營地',startDate:'2026-10-02',endDate:'2026-10-04',description:'一起去露營。',note:'',coverKind:'camp',status:'planning'};
const EMPTY='目前沒有可撤銷的邀請連結。',ONCE='連結只會顯示這一次，請現在複製。',MEMBER_LIMIT='每位旅伴在每趟旅行最多 5 個有效邀請連結。';
async function api(page,path,method='GET',body){const res=await page.request.fetch(testBase+path,{method,headers:body?{'Content-Type':'application/json','Origin':testBase}:{},data:body});return {status:res.status(),data:await res.json()};}
// Distinct display names so each Invite_List entry shows whose link it is. Accounts come from the harness pool
// (the register API is limited per client address; see tests/support/e2e-pool.js), renamed by the admin.
const member=(page,displayName='測試露友')=>poolMember(page,testBase,{displayName});
async function createTrip(page){const r=await api(page,'/api/trips','POST',fields);expect(r.status).toBeLessThan(300);return r.data.trip;}
async function createInvite(page,trip,user){const r=await api(page,`/api/trips/${trip.id}/invites`,'POST',{expectedUserId:user.id});expect(r.status).toBe(201);return r.data;}
const dialog=page=>page.locator('#dialog');
const entries=page=>dialog(page).locator('.invite-links li');
async function openInvites(page){await page.locator('.toolbar-actions [data-action="invite"]').click();await expect(dialog(page)).toBeVisible();await expect(dialog(page).getByRole('heading',{name:'尚未使用的邀請連結',exact:true})).toBeVisible();}
// A Trip_Member joins through an owner link in its own signed-in context and lands on the trip page.
async function joinAsMember(browser,ownerPage,owner,trip,displayName){
 const invite=await createInvite(ownerPage,trip,owner);
 const context=await browser.newContext({baseURL:testBase});const page=await context.newPage();const user=await member(page,displayName);
 await page.goto(invite.urlPath);await page.locator('form [name="join-name"]').fill(displayName);await page.locator('form button[type="submit"]').click();
 await expect(page).toHaveURL(new RegExp(`/${user.username}/trips/${trip.id}$`));
 return {context,page,user};
}
test.beforeAll(async({browser,baseURL})=>{
 if(!baseURL||new URL(baseURL).port!=='5181')throw new Error('Account browser tests must use the isolated test server on port 5181.');
 const page=await browser.newPage();
 const session=await api(page,'/api/session');
 if(session.data.needsSetup){const r=await api(page,'/api/setup','POST',{username:adminName,displayName:'測試管理員',password});expect([200,201,409]).toContain(r.status);}
 await page.close();
});
test('[TC-INVITE-003] owner and member lists show the right open links and a revoked link stops working @critical',async({page,browser})=>{
 const owner=await member(page,'營主小林'),trip=await createTrip(page);
 await page.goto(`/${owner.username}/trips/${trip.id}`);await openInvites(page);
 await expect(dialog(page)).toContainText(EMPTY);await expect(entries(page)).toHaveCount(0);await expect(page.locator('#invite-url')).toHaveCount(0);
 await dialog(page).getByRole('button',{name:'建立邀請連結',exact:true}).click();
 await expect(page.locator('#invite-url')).toHaveValue(new RegExp(`^${testBase.replace(/[.]/g,'\\.')}/invite/`));await expect(dialog(page)).toContainText(ONCE);
 await expect(entries(page)).toHaveCount(1);await expect(entries(page).first()).toContainText('營主小林');await expect(dialog(page)).not.toContainText(EMPTY);
 const ownerLink=new URL(await page.locator('#invite-url').inputValue()).pathname;
 const guest=await joinAsMember(browser,page,owner,trip,'旅伴阿樹');
 try{
  // The member sees only links it created: the owner's open link is not listed.
  await openInvites(guest.page);await expect(dialog(guest.page)).toContainText(EMPTY);
  await dialog(guest.page).getByRole('button',{name:'建立邀請連結',exact:true}).click();await expect(guest.page.locator('#invite-url')).toBeVisible();
  await expect(entries(guest.page)).toHaveCount(1);await expect(entries(guest.page).first()).toContainText('旅伴阿樹');await expect(dialog(guest.page)).not.toContainText('營主小林');
  // The owner (a Trip_Manager) sees every open link of the trip, including the member's.
  await page.reload();await openInvites(page);await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).filter({hasText:'旅伴阿樹'})).toHaveCount(1);await expect(entries(page).filter({hasText:'營主小林'})).toHaveCount(1);
  await entries(page).filter({hasText:'營主小林'}).getByRole('button',{name:'撤銷'}).click();
  await expect(page.locator('.toasts')).toContainText('邀請連結已撤銷');await expect(entries(page)).toHaveCount(1);await expect(entries(page).first()).toContainText('旅伴阿樹');
  expect((await api(page,`/api/trips/${trip.id}/invites`)).data.invites).toHaveLength(1);
 }finally{await guest.context.close();}
 const visitor=await browser.newContext({baseURL:testBase});
 try{const p=await visitor.newPage();await p.goto(ownerLink);await expect(p.getByRole('heading',{name:'邀請連結無效或已過期',exact:true})).toBeVisible();await expect(p.locator('form[data-form="acct-invite-register"]')).toHaveCount(0);}
 finally{await visitor.close();}
});
test('[TC-INVITE-004] member at the 5-link limit sees the limit in the dialog, revokes one and creates again',async({page,browser})=>{
 const owner=await member(page,'營主阿明'),trip=await createTrip(page);
 const guest=await joinAsMember(browser,page,owner,trip,'旅伴小雨');
 try{
  const p=guest.page;for(let i=0;i<5;i++)await createInvite(p,trip,guest.user);
  await p.setViewportSize({width:320,height:720});await p.reload();await openInvites(p);await expect(entries(p)).toHaveCount(5);
  expect(await dialog(p).evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await dialog(p).getByRole('button',{name:'建立邀請連結',exact:true}).click();
  await expect(dialog(p).locator('.form-error')).toHaveText(MEMBER_LIMIT);await expect(entries(p)).toHaveCount(5);await expect(p.locator('#invite-url')).toHaveCount(0);
  await entries(p).first().getByRole('button',{name:'撤銷'}).click();await expect(entries(p)).toHaveCount(4);
  await dialog(p).getByRole('button',{name:'建立邀請連結',exact:true}).click();
  await expect(p.locator('#invite-url')).toBeVisible();await expect(dialog(p).locator('.form-error')).toHaveText('');await expect(entries(p)).toHaveCount(5);
 }finally{await guest.context.close();}
});
