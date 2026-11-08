import {test,expect,describe} from 'bun:test';
import {seed,isValidState,addParticipant,normalizeParticipantName} from '../src/model.js';
import {RECIPE_TEMPLATES,DISH_TYPES,COMMON_INGREDIENTS,applyRecipeTemplate,mergeIngredients,inferDishKind} from '../src/recipes.js';
import {parseIngredients,syncMealIngredients,classifyIngredient} from '../src/ingredients.js';
import {DISH_KINDS} from '../src/dish-art.js';

describe('recipe templates and matching art',()=>{
 test('templates cover registered artwork and have valid classified ingredients',()=>{
  expect(DISH_TYPES.map(([k])=>k).sort()).toEqual([...DISH_KINDS].sort());
  expect(new Set(RECIPE_TEMPLATES.map(r=>r.id)).size).toBe(RECIPE_TEMPLATES.length);
  for(const recipe of RECIPE_TEMPLATES){expect(DISH_KINDS).toContain(recipe.imageKind);expect(parseIngredients(recipe.ingredients).length).toBeGreaterThan(3);for(const name of parseIngredients(recipe.ingredients))expect(classifyIngredient(name)).not.toBe('其他');}
  for(const items of Object.values(COMMON_INGREDIENTS))expect(new Set(items).size).toBe(items.length);
 });
 test('applying preset merges ingredients without mutating draft, dates, cook or servings',()=>{
  const draft={title:'原本',notes:'筆記',ingredients:'雞腿肉、鮮蝦',date:'2026-11-21',cookId:'p2',servings:'9'},copy=structuredClone(draft);
  const result=applyRecipeTemplate(draft,'curry');expect(draft).toEqual(copy);expect(result).toMatchObject({date:draft.date,cookId:'p2',servings:'9',imageKind:'curry'});expect(parseIngredients(result.ingredients).filter(s=>s==='雞腿肉')).toHaveLength(1);expect(result.ingredients).toContain('鮮蝦');
 });
 test('quick ingredients merge normalized names and reject no input safely',()=>{expect(mergeIngredients(' 雞蛋、雞蛋','雞蛋、高麗菜')).toBe('雞蛋、高麗菜');expect(mergeIngredients('', '')).toBe('');});
 test('unknown preset fails without data change',()=>{const draft={ingredients:'雞蛋'};expect(()=>applyRecipeTemplate(draft,'__proto__')).toThrow();expect(draft).toEqual({ingredients:'雞蛋'});});
 test('existing demo meals get matching pictures without data migration',()=>{expect(seed().meals.map(inferDishKind)).toEqual(['hotpot','toast','bbq','breakfast']);});
 test.each([['咖哩飯','curry'],['番茄義大利麵','pasta'],['野餐沙拉','salad'],['不知道吃什麼','custom']])('infers %s',(title,kind)=>expect(inferDishKind({title})).toBe(kind));
 test('explicit type wins; invalid type cannot inject markup',()=>{expect(inferDishKind({title:'咖哩飯',imageKind:'salad'})).toBe('salad');expect(inferDishKind({imageKind:'<script>'})).toBe('custom');});
 test('saved template retains schema and shopping sync',()=>{const state=seed();state.meals.push({...state.meals[0],...applyRecipeTemplate({ingredients:''},'pasta'),id:'pasta-new'});syncMealIngredients(state);expect(isValidState(state)).toBe(true);expect(state.shopping.some(s=>s.name==='義大利麵')).toBe(true);state.meals.at(-1).imageKind='evil';expect(isValidState(state)).toBe(false);});
});
describe('invitation creates a new independent person',()=>{
 test('adds a unique person without mutating existing data or taking an identity',()=>{const state=seed(),copy=structuredClone(state);const result=addParticipant(state,' 小樹 ','');expect(state).toEqual(copy);expect(result.state.people).toHaveLength(7);expect(result.person).toMatchObject({name:'小樹',role:'新加入的旅伴'});expect(result.person.id).not.toBe(state.currentUser);expect(isValidState(result.state)).toBe(true);});
 test('normalizes fullwidth characters and internal spaces',()=>expect(normalizeParticipantName(' Ａｌｉｃｅ   Lin ')).toBe('Alice Lin'));
 test.each(['','   ','\u3000','\u200b','\u202eJack', '樹'.repeat(31)])('rejects invalid name %p',name=>{const state=seed();expect(()=>addParticipant(state,name)).toThrow();expect(state.people).toHaveLength(6);});
 test('rejects duplicate existing person rather than impersonating',()=>{const state=seed();expect(()=>addParticipant(state,' 小安 ')).toThrow('已在小隊');expect(state.currentUser).toBe('p1');});
 test('duplicate names compare normalized spelling and case',()=>{const state=addParticipant(seed(),'Alice').state;expect(()=>addParticipant(state,' ＡＬＩＣＥ ')).toThrow('已在小隊');});
 test('checks role length and total participant cap',()=>{expect(()=>addParticipant(seed(),'小樹','角'.repeat(61))).toThrow('60');const state=seed();state.people=Array.from({length:100},(_,i)=>({...state.people[0],id:`p-${i}`,name:`name-${i}`}));expect(()=>addParticipant(state,'One more')).toThrow('100');});
 test('invalid additions preserve packing while valid new member clears readiness declaration',()=>{const state=seed();state.departed=['p1'];expect(()=>addParticipant(state,'小安')).toThrow();expect(state.departed).toEqual(['p1']);expect(addParticipant(state,'小樹').state.departed).toEqual([]);});
});

test('emoji joined names work while invisible lookalikes and empty names are rejected',()=>{
 expect(addParticipant(seed(),'小樹👩‍🍳').person.name).toBe('小樹👩‍🍳');
 expect(addParticipant(seed(),'露營👨‍👩‍👧‍👦').person.name).toContain('👨‍👩‍👧‍👦');
 for(const name of ['小安\uFE0F','小安\u3164','小安\u115F'])expect(()=>addParticipant(seed(),name)).toThrow('已在小隊');
 for(const name of ['\u3164','\uFE0F','\u115F'])expect(()=>addParticipant(seed(),name)).toThrow('空白');
 expect(()=>addParticipant(seed(),'A\u200DB')).toThrow('控制');
});
test.each(['烤雞','烤魚','烤玉米'])('recognizes common grilled dish %s',title=>expect(inferDishKind({title})).toBe('bbq'));
