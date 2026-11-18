import { test, expect } from '@playwright/test';
import { exampleTrip } from './fixtures/example-trip.js';

const user={id:'qa-user-id',username:'qa-user',displayName:'隔離測試',role:'member'};
const url='/qa-user/trips/qa-trip';
const studio=page=>page.locator('.story-studio-host');
const field=(page,id)=>studio(page).locator(`#${id}`);
const copy=value=>structuredClone(value);

test.use({serviceWorkers:'block'});

async function fakeAccount(page,{canDelete=true,canEdit=true,conflict=false}={}){
  let state=exampleTrip(),revision=3,putCount=0,lastRequest=null;
  state.revision=revision;
  const caps={canEdit,canDelete,canInvite:true,canManage:canDelete,personId:'p1'};
  const trip=()=>({id:'qa-trip',revision,title:state.trip.title,destination:state.trip.destination,startDate:state.trip.startDate,endDate:state.trip.endDate});
  await page.route('**/api/**',async route=>{
    const request=route.request(),u=new URL(request.url()),path=u.pathname;
    const reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/session')return reply(200,{user});
    if(path==='/api/trips/qa-trip'&&request.method()==='GET')return reply(200,{state:copy(state),trip:trip(),permissions:caps});
    if(path==='/api/trips/qa-trip'&&request.method()==='PUT'){
      putCount++;lastRequest=request.postDataJSON();
      if(conflict)return reply(409,{error:'其他人已更新這趟旅行'});
      if(!canEdit)return reply(403,{error:'沒有編輯權限'});
      if(lastRequest.expectedUserId!==user.id||lastRequest.revision!==revision)return reply(409,{error:'版本衝突'});
      state=copy(lastRequest.state);revision++;state.revision=revision;
      return reply(200,{state:copy(state),trip:trip(),permissions:caps});
    }
    return reply(404,{error:'此測試未模擬該 API'});
  });
  return {read:()=>({state:copy(state),revision,putCount,lastRequest})};
}

test('[studio-account] owner edits save through revision-checked API with original itinerary intact',async({page})=>{
  const backend=await fakeAccount(page);
  await page.goto(url);
  await expect(field(page,'poster')).toBeAttached();
  await field(page,'tab-cover').click();
  await field(page,'headline').fill('帳號版四車繪本');
  await field(page,'saveTrip').click();
  await expect.poll(()=>backend.read().putCount).toBe(1);
  await expect.poll(()=>backend.read().state.storybook?.headline).toBe('帳號版四車繪本');
  const result=backend.read();
  expect(result.putCount).toBe(1);
  expect(result.lastRequest).toMatchObject({revision:3,expectedUserId:user.id});
  expect(result.state.storybook.headline).toBe('帳號版四車繪本');
  expect(result.state.routes).toEqual(exampleTrip().routes);
  expect(result.state.meals).toEqual(exampleTrip().meals);
  await page.reload();
  await expect(field(page,'headline')).toHaveValue('帳號版四車繪本');
});

test('[studio-account] a 409 keeps unsaved draft and never retries over the newer revision',async({page})=>{
  const backend=await fakeAccount(page,{conflict:true});
  await page.goto(url);
  await expect(field(page,'poster')).toBeAttached();
  await field(page,'tab-cover').click();
  await field(page,'headline').fill('我還沒儲存的繪本');
  await field(page,'saveTrip').click();
  await expect(page.locator('.save-warning')).toContainText('其他人已更新');
  await expect(field(page,'headline')).toHaveValue('我還沒儲存的繪本');
  expect(backend.read().putCount).toBe(1);
  expect(backend.read().state.storybook?.headline).toBeUndefined();
  await field(page,'saveTrip').click();
  expect(backend.read().putCount).toBe(1);
});

test('[studio-account] collaborator can edit but cannot delete a linked meal or car',async({page})=>{
  const backend=await fakeAccount(page,{canDelete:false});
  await page.goto(url);
  await expect(field(page,'poster')).toBeAttached();
  await field(page,'section-events').click();
  const meal=studio(page).locator('#eventList li.entry:has(.meal-badge)');
  await expect(meal).toHaveCount(1);
  await expect(meal.locator('button.danger')).toHaveAttribute('disabled', '');
  await field(page,'tab-assets').click();
  await expect(studio(page).locator('#vehicleList button.danger').first()).toBeDisabled();
  expect(backend.read().putCount).toBe(0);
});


test('[studio-account] viewer cannot edit or issue a trip PUT', async ({page}) => {
  const backend=await fakeAccount(page,{canEdit:false,canDelete:false});
  await page.goto(url);
  await expect(field(page,'poster')).toBeAttached();
  await expect(studio(page).locator('[data-studio-root]')).toHaveAttribute('data-can-edit','false');
  await expect(field(page,'editorPanel')).toBeHidden();
  await expect(field(page,'saveTrip')).toBeHidden();
  expect(backend.read().putCount).toBe(0);
});
