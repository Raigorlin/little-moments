import {test as base,expect} from '@playwright/test';
import {emptyState,LEGACY_STORAGE_KEY,seed,STORAGE_KEY} from '../src/model.js';

export const test=base.extend({
  page:async({page},use)=>{
    await page.addInitScript(({key,legacyKey,state})=>{
      if((location.pathname==='/demo'||location.pathname.startsWith('/demo/'))&&!new URLSearchParams(location.search).has('blank')&&localStorage.getItem(key)===null&&localStorage.getItem(legacyKey)===null)localStorage.setItem(key,state);
    },{key:STORAGE_KEY,legacyKey:LEGACY_STORAGE_KEY,state:JSON.stringify(seed())});
    await use(page);
  }
});

export {expect,emptyState};
