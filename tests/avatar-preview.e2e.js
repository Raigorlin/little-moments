import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
const base=process.env.CAMPING_BASE_URL;
const nav=(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();
async function api(page,path,method='GET',body){
 const r=await page.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});
 expect(r.ok(),await r.text()).toBe(true);return r.json();
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('account planner avatars use the first letter across tabs and reload without changing data',async({page})=>{
 await api(page,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const state=seed();state.people[0].name='Alex Lee';state.people[1].name='Ena';state.people[2].name='Mike';
 const {trip}=await api(page,'/api/trips','POST',{legacyState:state});
 const before=await api(page,`/api/trips/${trip.id}`);
 await page.goto(`/qa-admin/trips/${trip.id}`);
 const checkAvatars=async scope=>{
  for(const [name,letter] of [['Alex Lee','A'],['Ena','E'],['Mike','M']]){
   const avatars=scope.locator(`.avatar[aria-label="${name}"]`);expect(await avatars.count()).toBeGreaterThan(0);
   for(const avatar of await avatars.all())await expect(avatar).toHaveText(letter);
  }
 };
 for(const tab of ['schedule','meals']){await nav(page,tab);await checkAvatars(page);}
 // Companion cards moved from the removed crew tab into the trip menu drawer.
 await page.getByRole('button',{name:'旅行選單',exact:true}).click();
 const menu=page.locator('aside#trip-menu');await expect(menu).toBeVisible();await checkAvatars(menu.locator('.member-card'));
 await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);
 await page.reload();await expect(page.locator('.avatar[aria-label="Alex Lee"]')).toHaveText('A');
 expect(await api(page,`/api/trips/${trip.id}`)).toEqual(before);
});

test('[TC-MEAL-001] meal editor omits the image preview without changing saved data',async({page})=>{
 await page.goto('/demo/#/trip');await nav(page,'meals');
 const before=await page.evaluate(k=>localStorage.getItem(k),STORAGE_KEY);
 await page.getByRole('button',{name:'新增餐次',exact:true}).click();
 await expect(page.locator('#meal-image-preview')).toHaveCount(0);
 await expect(page.getByRole('combobox',{name:'料理圖片',exact:true})).toHaveCount(0);
 await page.getByRole('textbox',{name:'料理名稱',exact:true}).fill('雞肉咖哩飯');
 await expect(page.locator('#meal-image-preview')).toHaveCount(0);
 await expect(page.getByText('通用餐盤 · 料理示意圖',{exact:true})).toHaveCount(0);
 await expect(page.getByText('咖哩飯 · 料理示意圖',{exact:true})).toHaveCount(0);
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'取消',exact:true}).click();
 expect(await page.evaluate(k=>localStorage.getItem(k),STORAGE_KEY)).toBe(before);
});
