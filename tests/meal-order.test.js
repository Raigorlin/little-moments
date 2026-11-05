import {test,expect} from 'bun:test';
import {MEAL_SLOTS,mealSlotRank,mealSlotOptions,groupMealsByDate} from '../src/meal-order.js';
const meal=(id,date,slot)=>({id,date,slot});
test('five meal slots follow chronological order',()=>expect(MEAL_SLOTS).toEqual(['早餐','午餐','下午茶','晚餐','消夜']));
test('date is sorted before slot, with stable order for same-slot dishes',()=>{
 const input=[meal('night','2026-11-21','消夜'),meal('dinner','2026-11-20','晚餐'),meal('lunch1','2026-11-21','午餐'),meal('breakfast','2026-11-21','早餐'),meal('tea','2026-11-21','下午茶'),meal('lunch2','2026-11-21','午餐')];
 expect(groupMealsByDate(input).map(g=>[g.date,g.meals.map(m=>m.id)])).toEqual([['2026-11-20',['dinner']],['2026-11-21',['breakfast','lunch1','lunch2','tea','night']]]);
});
test('display sorting does not mutate data or stored array order',()=>{
 const input=Object.freeze([Object.freeze(meal('a','2026-11-22','晚餐')),Object.freeze(meal('b','2026-11-20','早餐'))]);
 expect(groupMealsByDate(input)[0].meals[0]).toBe(input[1]);expect(input.map(m=>m.id)).toEqual(['a','b']);
});
test('older aliases have the expected time order',()=>expect(['早','午','下午茶','晚','宵夜'].map(mealSlotRank)).toEqual([0,1,2,3,4]));
test('unknown legacy slots appear after known slots on the same date, unchanged',()=>{
 const input=[meal('old','2026-11-20','早午餐'),meal('new','2026-11-20','午餐')];
 expect(groupMealsByDate(input)[0].meals.map(m=>m.id)).toEqual(['new','old']);expect(input[0].slot).toBe('早午餐');
});
test('legacy form option is preserved, not silently replaced with dinner',()=>expect(mealSlotOptions('早午餐')).toEqual([...MEAL_SLOTS,'早午餐']));
test('new forms have only the five choices and choices are independent copies',()=>{const options=mealSlotOptions();options.pop();expect(mealSlotOptions('午餐')).toEqual(MEAL_SLOTS);expect(MEAL_SLOTS).toHaveLength(5);});
test('empty menu returns no date groups',()=>expect(groupMealsByDate()).toEqual([]));
