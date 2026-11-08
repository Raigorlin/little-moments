import {test,expect} from 'bun:test';
import {TABS,resolveTab,STORAGE_KEY} from '../src/model.js';
import {tripMenuEntries} from '../src/trip-menu.js';

// ---------------------------------------------------------------------------
// Deterministic property-test harness, copied from tests/mobile-swipe.test.js.
//
// It is copied rather than imported because importing a test file would also
// register that file's tests here. Contract:
//
//   forAll(name, generator, property, options?)
//     registers a bun test that runs `generator` at least MIN_ITERATIONS times.
//     `generator(gen, i)` receives the per-iteration random source and the
//     iteration index, and returns the sample. `property(sample, gen)` either
//     asserts with `expect` or returns false to fail. On failure the thrown
//     message carries the seed and the JSON-serialized sample, so the exact
//     counterexample can be replayed with TRIP_MENU_SEED=<seed>.
//
// Each iteration draws from its own PRNG seeded from (stream seed + index), so
// one iteration is replayable in isolation and adding properties never shifts
// the samples of the existing ones.
// ---------------------------------------------------------------------------

/** Base seed. Override to replay a reported counterexample: TRIP_MENU_SEED=12345 bun test */
export const SEED=(Number(process.env.TRIP_MENU_SEED)||0x7A1B5)>>>0;
/** At least 100 iterations per property, per the testing strategy in design.md. */
const MIN_ITERATIONS=100;
export const ITERATIONS=Math.max(MIN_ITERATIONS,Number(process.env.TRIP_MENU_ITERATIONS)||200);

/** Standard mulberry32: 32-bit seed in, float in [0,1) out. */
export function mulberry32(seed){
 let a=seed>>>0;
 return function(){
  a=(a+0x6D2B79F5)>>>0;
  let t=a;
  t=Math.imul(t^(t>>>15),t|1);
  t^=t+Math.imul(t^(t>>>7),t|61);
  return ((t^(t>>>14))>>>0)/4294967296;
 };
}

/** FNV-1a over the property name, so each property owns an independent stream. */
function streamSeed(name,base){
 let h=0x811C9DC5;
 for(let i=0;i<name.length;i+=1){h=Math.imul(h^name.charCodeAt(i),0x01000193);}
 return (h^base)>>>0;
}

/** Convenience draws over a PRNG. Shared by every property generator. */
export function sampler(random){
 return {
  random,
  float(min,max){return min+random()*(max-min);},
  int(min,max){return Math.floor(min+random()*(max-min+1));},
  pick(list){return list[Math.floor(random()*list.length)];},
  bool(probability=0.5){return random()<probability;},
  string(maxLength=12){
   let s='';
   const length=Math.floor(random()*(maxLength+1));
   for(let i=0;i<length;i+=1)s+=String.fromCharCode(32+Math.floor(random()*95));
   return s;
  },
 };
}

/** JSON for the failure message, surviving NaN, Infinity and undefined. */
export function describeSample(sample){
 const json=JSON.stringify(sample,(_key,value)=>{
  if(typeof value==='number'&&!Number.isFinite(value))return String(value);
  if(value===undefined)return '<undefined>';
  return value;
 });
 return json===undefined?String(sample):json;
}

/** The runner. Throws a reproducible counterexample report on the first failure. */
export function runAll(name,generator,property,options={}){
 const base=(options.seed??SEED)>>>0;
 const iterations=Math.max(MIN_ITERATIONS,options.iterations??ITERATIONS);
 const stream=streamSeed(name,base);
 for(let i=0;i<iterations;i+=1){
  const iterationSeed=(stream+i*0x9E3779B1)>>>0;
  const gen=sampler(mulberry32(iterationSeed));
  let sample;
  try{sample=generator(gen,i);}
  catch(error){throw new Error(report(name,i,iterations,base,iterationSeed,'<generator threw>',error.message));}
  try{
   if(property(sample,gen)===false)throw new Error('property returned false');
  }catch(error){
   throw new Error(report(name,i,iterations,base,iterationSeed,describeSample(sample),error.message));
  }
 }
}

function report(name,i,iterations,base,iterationSeed,sampleJson,message){
 return `${name}\n  failed on iteration ${i+1} of ${iterations}\n  seed: ${base} (replay this run with TRIP_MENU_SEED=${base}; iteration seed ${iterationSeed})\n  sample: ${sampleJson}\n  cause: ${message}`;
}

/** Register a property as a bun test. */
export function forAll(name,generator,property,options={}){
 test(name,()=>runAll(name,generator,property,options));
}

// ---------------------------------------------------------------------------
// Example tests: section tabs and storage.
// ---------------------------------------------------------------------------

test('section tabs are exactly the five remaining keys in order',()=>{
 // Requirements 1.1, 1.3, 5.1, 7.2
 expect(TABS.map(([k])=>k)).toEqual(['schedule','meals','shopping','gear','expenses']);
});

test('the removed tab keys resolve to schedule',()=>{
 // Requirements 4.1, 7.2
 expect(resolveTab('crew')).toBe('schedule');
 expect(resolveTab('settings')).toBe('schedule');
});

test('the storage key is unchanged',()=>{
 // Requirements 6.1, 7.3
 expect(STORAGE_KEY).toBe('ggc-local-demo-v2');
});

// ---------------------------------------------------------------------------
// Property tests.
// ---------------------------------------------------------------------------

// Feature: remove-vehicle-travel-tabs, Property 1: Tab resolution is identity on Remaining_Tabs and schedule elsewhere
// **Validates: Requirements 4.1, 4.2**
// The expected value uses this hard-coded list, independent of TABS.
const REMAINING_TAB_KEYS=['schedule','meals','shopping','gear','expenses'];

function nearMiss(gen){
 const base=gen.pick([...REMAINING_TAB_KEYS,'crew','settings']);
 switch(gen.int(0,5)){
  case 0:return base.toUpperCase();
  case 1:return base[0].toUpperCase()+base.slice(1);
  case 2:return gen.pick([' ','  ','\t','\n'])+base;
  case 3:return base+gen.pick([' ','\t','\n','/','s']);
  case 4:return gen.pick(['#','tab-','x','/'])+base;
  default:return base.slice(0,gen.int(0,base.length-1));
 }
}

forAll('Property 1: Tab resolution is identity on Remaining_Tabs and schedule elsewhere',gen=>{
 switch(gen.int(0,4)){
  case 0:return gen.pick(REMAINING_TAB_KEYS);
  case 1:return gen.pick(['crew','settings']);
  case 2:return nearMiss(gen);
  case 3:return '';
  default:return gen.string(16);
 }
},value=>{
 const expected=REMAINING_TAB_KEYS.includes(value)?value:'schedule';
 expect(resolveTab(value)).toBe(expected);
});

// ---------------------------------------------------------------------------
// Trip_Menu entries.
// ---------------------------------------------------------------------------

test('with no account the menu has every fixed entry',()=>{
 // Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 3.10, 3.11
 const state={people:[{id:'p1'}],currentUser:'p1',vehicles:[{id:'v1'}],events:[]};
 const m=tripMenuEntries(state,null);
 const actions=[
  m.trip.action,m.addPerson.action,m.switchIdentity.action,
  m.addVehicle.action,...m.vehicles.map(v=>v.edit.action),
  ...m.data,m.reset.action,
 ];
 for(const action of ['trip-settings','person','profile','vehicle','export','import','print','reset']){
  expect(actions).toContain(action);
 }
});

// Feature: remove-vehicle-travel-tabs, Property 2: Every person gets an entry, with edit rights matching the old crew tab
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 3.10, 3.11**
const PERM_VALUES=[true,false,undefined,null,0,1,'','yes','false',[],{}];

forAll('Property 2: Every person gets an entry, with edit rights matching the old crew tab',gen=>{
 const count=gen.int(0,8);
 // Unique ids, so "exactly one isMe" is well defined.
 const people=Array.from({length:count},(_,i)=>({id:`p${i}-${gen.int(0,999)}`,name:gen.string(6)}));
 const pickId=()=>count&&gen.bool(0.7)?gen.pick(people).id:gen.pick(['ghost','',undefined]);
 const currentUser=pickId();
 let account=null;
 if(gen.bool(0.8)){
  const permissions={};
  if(gen.bool(0.9))permissions.canEdit=gen.pick(PERM_VALUES);
  if(gen.bool(0.9))permissions.canManage=gen.pick(PERM_VALUES);
  if(gen.bool(0.9))permissions.personId=pickId();
  account=gen.bool(0.9)?{permissions}:{};
 }
 return {state:{people,currentUser,vehicles:[],events:[]},account};
},({state,account})=>{
 const result=tripMenuEntries(state,account).people;
 expect(result.map(p=>p.id)).toEqual(state.people.map(p=>p.id));
 const meCount=result.filter(p=>p.isMe===true).length;
 const present=state.people.some(p=>p.id===state.currentUser);
 expect(meCount).toBe(present?1:0);
 result.forEach((entry,i)=>{
  const person=state.people[i];
  expect(entry.isMe).toBe(person.id===state.currentUser);
  let expected=false;
  if(account&&account.permissions){
   const p=account.permissions;
   if(p.canEdit){
    if(p.canManage)expected=true;
    else if(person.id===p.personId)expected=true;
   }
  }
  expect(entry.canEdit).toBe(expected);
 });
});

// Feature: remove-vehicle-travel-tabs, Property 3: Every vehicle gets an edit entry, and a delete entry exactly when deletion is allowed
// **Validates: Requirements 3.5, 3.6, 3.11**
forAll('Property 3: Every vehicle gets an edit entry, and a delete entry exactly when deletion is allowed',gen=>{
 const count=gen.int(0,8);
 const vehicles=Array.from({length:count},(_,i)=>({id:`v${i}-${gen.int(0,999)}`,name:gen.string(6)}));
 let account=null;
 switch(gen.int(0,3)){
  case 0:break;
  case 1:account={};break;
  case 2:account={permissions:{}};break;
  default:account={permissions:{canDelete:gen.pick(PERM_VALUES)}};
 }
 return {state:{people:[],currentUser:undefined,vehicles,events:[]},account};
},({state,account})=>{
 const result=tripMenuEntries(state,account).vehicles;
 expect(result.map(v=>v.id)).toEqual(state.vehicles.map(v=>v.id));
 // Expected rule computed here without optional chaining, independent of the implementation.
 let expected;
 if(account===null)expected=true;
 else if(account.permissions&&account.permissions.canDelete===true)expected=true;
 else expected=false;
 for(const entry of result){
  expect(entry.edit.action).toBe('vehicle');
  expect(entry.canDelete).toBe(expected);
 }
});

// Feature: remove-vehicle-travel-tabs, Property 4: The menu shows the most recent events in stored order
// **Validates: Requirements 6.2**
forAll('Property 4: The menu shows the most recent events in stored order',gen=>{
 const count=gen.int(0,30);
 const atValue=()=>{
  switch(gen.int(0,4)){
   case 0:return new Date(gen.int(0,2_000_000_000_000)).toISOString();
   case 1:return gen.int(0,2_000_000_000_000);
   case 2:return gen.string(10);
   case 3:return null;
   default:return undefined;
  }
 };
 const events=Array.from({length:count},()=>({actor:gen.string(8),text:gen.string(20),at:atValue()}));
 const account=gen.bool(0.5)?null:{permissions:{canEdit:gen.bool(),canManage:gen.bool(),canDelete:gen.bool()}};
 return {state:{people:[],currentUser:undefined,vehicles:[],events},account};
},({state,account})=>{
 // Expected list built with a loop, independent of the implementation's slice.
 const limit=state.events.length<8?state.events.length:8;
 const expected=[];
 for(let i=0;i<limit;i+=1)expected.push({...state.events[i]});
 const result=tripMenuEntries(state,account).events;
 expect(result.length).toBe(limit);
 expect(result).toEqual(expected);
});
