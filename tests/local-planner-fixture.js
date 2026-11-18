import {test as base,expect} from '@playwright/test';
import {emptyState,LEGACY_STORAGE_KEY,seed,STORAGE_KEY} from '../src/model.js';
import {exampleTrip,EXAMPLE_TEXT} from './fixtures/example-trip.js';

/** Before every page load, writes `state` as the Local_Planner's trip, but only on /demo/ without ?blank and only while
 * neither storage key has a value, so a reload keeps what the page saved. Use it on a page without another such script
 * (the first script that writes wins). */
export async function writeLocalPlannerState(page,state){
  await page.addInitScript(({key,legacyKey,state})=>{
    if((location.pathname==='/demo'||location.pathname.startsWith('/demo/'))&&!new URLSearchParams(location.search).has('blank')&&localStorage.getItem(key)===null&&localStorage.getItem(legacyKey)===null)localStorage.setItem(key,state);
  },{key:STORAGE_KEY,legacyKey:LEGACY_STORAGE_KEY,state:JSON.stringify(state)});
}

export const test=base.extend({
  page:async({page},use)=>{
    await writeLocalPlannerState(page,seed());
    await use(page);
  }
});

/** Same as `test`, but the Local_Planner starts with Example_Trip (tests/fixtures/example-trip.js) instead of seed(). */
export const exampleTripTest=base.extend({
  page:async({page},use)=>{
    await writeLocalPlannerState(page,exampleTrip());
    await use(page);
  }
});

export {expect,emptyState,exampleTrip,EXAMPLE_TEXT};
