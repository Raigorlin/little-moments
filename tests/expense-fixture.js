import {expect} from '@playwright/test';
import {seed} from '../src/model.js';
export const base=process.env.CAMPING_BASE_URL;
export async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
export async function fixture(p){
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const {user}=await api(p,'/api/session');const {trip}=await api(p,'/api/trips','POST',{legacyState:seed()});
 const path=`/api/trips/${trip.id}/ledger`,detail=()=>api(p,`/api/trips/${trip.id}`),ledger=()=>api(p,path);
 const before=await detail();await p.goto(`/qa-admin/trips/${trip.id}`);await p.locator('.section-tabs [data-tab="expenses"]').click();
 await expect(p.locator('.xp-panel')).toBeVisible();
 return {user,trip,path,detail,ledger,before};
}
export const manualRow=(id,extra={})=>({id,date:'2026-11-19',title:'食材測試',amountCents:30000,payerId:'p1',participantIds:['p1','p2'],category:'食材',note:'',shoppingId:'',source:'manual',receiptId:'',receiptLine:'',...extra});
export async function seedLedger(p,f,expenses,settlements=[]){const {ledger}=await f.ledger();return api(p,f.path,'PUT',{expectedUserId:f.user.id,revision:ledger.revision,requestId:crypto.randomUUID(),expenses,settlements});}
export async function assertTripUnchanged(f){expect(await f.detail()).toEqual(f.before);}
