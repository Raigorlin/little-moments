import {test,expect} from 'bun:test';
import {seed,assignShopping} from '../src/model.js';
import {syncMealIngredients} from '../src/ingredients.js';

test('inline shopping assignment changes only responsible person and manual preservation marker',()=>{
 const state=seed();syncMealIngredients(state);const item=state.shopping.find(s=>s.source==='meal');
 expect(item).toBeTruthy();item.done=true;
 const before=structuredClone(state),person=state.people.find(p=>p.id!==item.assignee).id;
 expect(assignShopping(state,item.id,person)).toBe(true);
 const expected=structuredClone(before);Object.assign(expected.shopping.find(s=>s.id===item.id),{assignee:person,source:'manual'});
 expect(state).toEqual(expected);
});
test('manually assigned generated ingredients survive meal removal and sync',()=>{
 const state=seed();syncMealIngredients(state);const item=state.shopping.find(s=>s.source==='meal');
 assignShopping(state,item.id,state.people[0].id);const before=structuredClone(item);
 state.meals=[];syncMealIngredients(state);
 const kept=state.shopping.find(s=>s.id===item.id);expect(kept).toBeTruthy();
 expect(kept.assignee).toBe(before.assignee);expect(kept.quantity).toBe(before.quantity);expect(kept.source).toBe('manual');
});
test('clear assignment works and invalid or unchanged assignments do not mutate state',()=>{
 const state=seed(),item=state.shopping.find(s=>s.assignee);expect(assignShopping(state,item.id,'')).toBe(true);expect(item.assignee).toBe('');
 const before=structuredClone(state);
 for(const [id,person] of [[item.id,''],[item.id,'missing'],['missing',state.people[0].id],[item.id,null],[item.id,{}]]){
  expect(assignShopping(state,id,person)).toBe(false);expect(state).toEqual(before);
 }
});
