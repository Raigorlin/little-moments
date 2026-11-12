import { describe, test, expect } from 'bun:test';
import {seed,emptyState,isValidState, dateRange, load, save, STORAGE_KEY, togglePacking, assignGear, canDepart, myGear, readyCount, unassigned, progress, escape} from '../src/model.js';
import {illustration,logo} from '../src/art.js';
const memory=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)}};
describe('local camping model',()=>{
  test('demo data has a valid complete schema',()=>expect(isValidState(seed())).toBe(true));
  test('validates date ranges and leap days',()=>{expect(dateRange('2028-02-28','2028-03-01')).toHaveLength(3);expect(dateRange('2026-11-22','2026-11-20')).toEqual([]);expect(dateRange('bad','bad')).toEqual([]);});
  test('persists and restores changes',()=>{const store=memory(),state=seed();state.trip.title='My trip';expect(save(store,state)).toBe(true);expect(load(store).trip.title).toBe('My trip');});
  test('new and malformed local storage starts from a blank valid planner',()=>{expect(isValidState(emptyState())).toBe(true);const fresh=load(memory());expect(isValidState(fresh)).toBe(true);expect(fresh.trip.title).toBe('我的露營旅行');expect(fresh.activities).toEqual([]);expect(fresh.meals).toEqual([]);const store=memory();store.setItem(STORAGE_KEY,'{broken');const recovered=load(store);expect(isValidState(recovered)).toBe(true);expect(recovered.activities).toEqual([]);});
  test('storage failures are reported, not treated as saved',()=>expect(save({setItem(){throw Error('quota')}},seed())).toBe(false));
  test('nested malformed backup data is rejected',()=>{const state=seed();state.gear[0].ready='no';expect(isValidState(state)).toBe(false);});
  test('unknown active identity is rejected',()=>{const state=seed();state.currentUser='unknown';expect(isValidState(state)).toBe(false);});
  test('packing marks belong to the chosen participant',()=>{const state=seed();togglePacking(state,'g1');expect(readyCount(state)).toBe(1);state.currentUser='p2';expect(state.gear[0].ready).toEqual(['p1']);expect(readyCount(state)).toBe(1);});
  test('cannot tick another participants shared equipment',()=>{const state=seed();expect(togglePacking(state,'g6')).toBe(false);});
  test('unassigned group items block departure',()=>{const state=seed();for(const g of myGear(state))togglePacking(state,g.id);expect(canDepart(state)).toBe(false);expect(unassigned(state)).toHaveLength(2);});
  test('departure succeeds only after assignment and own packing',()=>{const state=seed();assignGear(state,'g10','p2');assignGear(state,'g11','p2');for(const g of myGear(state))togglePacking(state,g.id);expect(canDepart(state)).toBe(true);});
  test('reassigning clears obsolete readiness and departure',()=>{const state=seed();state.departed=['p2'];assignGear(state,'g8','p1');expect(state.gear.find(g=>g.id==='g8').ready).toEqual([]);expect(state.departed).toEqual([]);});
  test('unknown assignment is not accepted',()=>expect(assignGear(seed(),'g8','unknown')).toBe(false));
  test('progress includes personal gear for each participant',()=>expect(progress(seed())).toEqual({shoppingDone:3,shoppingTotal:12,gearDone:1,gearTotal:31}));
  test('renders untrusted text as escaped text',()=>expect(escape('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  test('escapes backticks',()=>expect(escape('`${alert(1)}`')).toBe('&#96;${alert(1)}&#96;'));
  test('SVG art does not allow class injection',()=>{expect(illustration('camp','"><script>')).not.toContain('<script>');expect(logo()).toContain('viewBox="0 0 44 44"');});
});

test('rejects hidden categories and unknown gear assignees in backups',()=>{const state=seed();state.shopping[0].category='invisible';expect(isValidState(state)).toBe(false);const other=seed();other.gear[4].assignee='ghost';expect(isValidState(other)).toBe(false);});
test('rejects out of trip dates and duplicate passengers',()=>{const state=seed();state.activities[0].date='2030-01-01';expect(isValidState(state)).toBe(false);const other=seed();other.vehicles[0].passengers=['p1','p1'];expect(isValidState(other)).toBe(false);});
test('rejects normalized invalid dates and spans longer than one month',()=>{expect(dateRange('2026-02-30','2026-03-04')).toEqual([]);expect(dateRange('2026-01-01','2026-03-01')).toEqual([]);});
