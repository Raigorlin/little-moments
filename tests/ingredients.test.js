import {describe,test,expect} from 'bun:test';
import {parseIngredients,classifyIngredient,syncMealIngredients,SHOPPING_CATEGORIES} from '../src/ingredients.js';
import {seed,isValidState,save,load,readStorage,STORAGE_KEY,LEGACY_STORAGE_KEY} from '../src/model.js';
const recipeState = (...ingredients) => {
  const state=seed();
  state.shopping=[];
  state.meals=ingredients.map((text,i)=>({...state.meals[0],id:`meal-${i}`,ingredients:text}));
  return state;
};
const find = (state,name) => state.shopping.find(s=>s.name===name);

describe('ingredient parsing and classification',()=>{
  test('accepts ideographic/Chinese/English commas, semicolons and newlines',()=>{
    expect(parseIngredients(' 牛肉片、 高麗菜，雞蛋, 起司；白米;番茄\n鮮奶\r\n')).toEqual(['牛肉片','高麗菜','雞蛋','起司','白米','番茄','鮮奶']);
  });
  test('discards empty tokens and deduplicates normalized names',()=>{
    expect(parseIngredients('、 , ，；\n')).toEqual([]);
    expect(parseIngredients('雞 蛋、雞蛋、 ＡＢＣ , abc')).toEqual(['雞 蛋','ABC']);
    expect(parseIngredients()).toEqual([]);
  });
  test.each([
    ['牛肉片','肉類'],['豬五花','肉類'],['雞胸肉','肉類'],['香腸','肉類'],['培根','肉類'],
    ['鮭魚','海鮮'],['白蝦','海鮮'],['蛤蜊','海鮮'],['花枝','海鮮'],
    ['高麗菜','蔬菜'],['金針菇','蔬菜'],['地瓜葉','蔬菜'],['玉米','蔬菜'],['甜椒','蔬菜'],['辣椒','蔬菜'],['薑','蔬菜'],['毛豆','蔬菜'],['番茄','蔬菜'],
    ['蘋果','水果'],['水果','水果'],['雞蛋','蛋奶'],['鮮奶','蛋奶'],['奶油','蛋奶'],['起司','蛋奶'],
    ['板豆腐','豆製品'],['豆皮','豆製品'],['素雞','豆製品'],
    ['吐司','主食'],['貝果','主食'],['白米','主食'],['義大利麵','主食'],['地瓜','主食'],
    ['壽喜燒醬','調味料'],['雞粉','調味料'],['魚露醬','調味料'],['花生醬','調味料'],['辣椒粉','調味料'],['肉桂粉','調味料'],
    ['咖啡豆','飲料'],['燕麥奶','飲料'],['蘋果汁','飲料'],['豆漿','飲料'],
    ['棉花糖','零食'],['牛肉乾','零食'],['冰塊','其他'],['神秘食材','其他'],['constructor','其他']
  ])('classifies %s as %s',(name,category)=>expect(classifyIngredient(name)).toBe(category));
});

describe('recipe-to-shopping synchronization',()=>{
  test('creates categorized entries with explicit unknown quantities and valid schema',()=>{
    const state=recipeState('牛肉片、高麗菜、雞蛋、板豆腐、醬油、鮮蝦、水果');
    expect(syncMealIngredients(state)).toEqual({changed:true,added:7,removed:0});
    expect(state.shopping.map(s=>s.category)).toEqual(['肉類','蔬菜','蛋奶','豆製品','調味料','海鮮','水果']);
    expect(state.shopping.every(s=>s.quantity==='數量待確認' && !s.done && s.assignee==='')).toBe(true);
    expect(isValidState(state)).toBe(true);
  });
  test('same names across meals stay one row and repeated sync is a no-op',()=>{
    const state=recipeState('牛肉片、牛肉片、高麗菜','高麗菜、牛肉片');
    syncMealIngredients(state);
    const before=JSON.stringify(state);
    expect(syncMealIngredients(state)).toEqual({changed:false,added:0,removed:0});
    expect(JSON.stringify(state)).toBe(before);
    expect(state.shopping).toHaveLength(2);
    expect(find(state,'牛肉片').mealIds).toEqual(['meal-0','meal-1']);
  });
  test('meal edits remove only unused generated entries; shared needs remain',()=>{
    const state=recipeState('牛肉片、高麗菜','高麗菜');syncMealIngredients(state);
    const cabbageId=find(state,'高麗菜').id;
    state.meals[0].ingredients='白蝦';syncMealIngredients(state);
    expect(find(state,'牛肉片')).toBeUndefined();
    expect(find(state,'高麗菜').id).toBe(cabbageId);
    expect(find(state,'高麗菜').mealIds).toEqual(['meal-1']);
    expect(find(state,'白蝦').category).toBe('海鮮');
    state.meals=[];syncMealIngredients(state);expect(state.shopping).toEqual([]);
    expect(isValidState(state)).toBe(true);
  });
  test('purchased items, manual rows and user-edited auto rows survive removing meals',()=>{
    const state=recipeState('牛肉片、雞蛋');syncMealIngredients(state);
    find(state,'牛肉片').done=true;
    Object.assign(find(state,'雞蛋'),{source:'manual',quantity:'2 盒',category:'其他',assignee:'p2'});
    state.shopping.push({id:'manual',name:'冰塊',quantity:'2 袋',category:'其他',assignee:'p1',done:false});
    state.meals=[];syncMealIngredients(state);
    expect(state.shopping).toHaveLength(3);
    expect(find(state,'牛肉片').done).toBe(true);
    expect(find(state,'雞蛋')).toMatchObject({quantity:'2 盒',category:'其他',assignee:'p2',mealIds:[]});
    expect(isValidState(state)).toBe(true);
  });
  test('existing/manual matched entries keep identity, quantity, category and buyer',()=>{
    const state=recipeState('雞蛋');
    state.shopping=[{id:'existing',name:'雞 蛋',quantity:'3 盒',category:'其他',assignee:'p3',done:true}];
    syncMealIngredients(state);
    expect(state.shopping).toEqual([{id:'existing',name:'雞 蛋',quantity:'3 盒',category:'其他',assignee:'p3',done:true,mealIds:['meal-0']}]);
  });
  test('legacy combined rows cover each ingredient without duplicating their quantities',()=>{
    const state=seed();const old=structuredClone(state.shopping);
    syncMealIngredients(state);
    expect(state.shopping.filter(s=>['甜椒','玉米','吐司','貝果'].includes(s.name))).toHaveLength(0);
    for(const item of old)expect(state.shopping.find(s=>s.id===item.id)).toMatchObject(item);
    expect(find(state,'甜椒、玉米').mealIds).toEqual(['m3']);
    expect(find(state,'吐司、貝果').mealIds).toEqual(['m2','m4']);
    expect(find(state,'壽喜燒醬').category).toBe('調味料');
    expect(isValidState(state)).toBe(true);
  });
  test('clearing a recipe removes obsolete references and retains purchased entries',()=>{
    const state=recipeState('牛肉片、雞蛋');syncMealIngredients(state);find(state,'雞蛋').done=true;
    state.meals[0].ingredients='';syncMealIngredients(state);
    expect(state.shopping).toHaveLength(1);expect(find(state,'雞蛋').mealIds).toEqual([]);
  });
  test('new category and linkage metadata round-trip through old schema version',()=>{
    const state=recipeState('蝦仁、蘋果、豆皮、醬油');syncMealIngredients(state);
    let raw=null;const storage={getItem:()=>raw,setItem:(_,value)=>raw=value};
    expect(save(storage,state)).toBe(true);expect(load(storage)).toEqual(state);
    const restored=load(storage);expect(syncMealIngredients(restored).changed).toBe(false);
    for(const category of SHOPPING_CATEGORIES){restored.shopping[0].category=category;expect(isValidState(restored)).toBe(true);}
  });
  test('rejects malformed source metadata and nonexistent meal references',()=>{
    for(const patch of [{source:'unknown'},{mealIds:'m1'},{mealIds:[null]},{mealIds:['ghost']},{mealIds:['meal-0','meal-0']}]){
      const state=recipeState('牛肉片');syncMealIngredients(state);Object.assign(state.shopping[0],patch);expect(isValidState(state)).toBe(false);
    }
  });
  test('capacity failure leaves original list untouched',()=>{
    const state=recipeState('new ingredient');
    state.shopping=Array.from({length:1000},(_,i)=>({id:`s-${i}`,name:`manual-${i}`,quantity:'1',category:'其他',assignee:'',done:false}));
    const before=JSON.stringify(state);
    expect(()=>syncMealIngredients(state)).toThrow('1,000');expect(JSON.stringify(state)).toBe(before);
  });
});

test('halfwidth separators normalize before parsing, numeric commas stay in the item',()=>{
  expect(parseIngredients('牛肉､豬肉')).toEqual(['牛肉','豬肉']);
  expect(parseIngredients('1,000g 牛肉、雞蛋')).toEqual(['1,000g 牛肉','雞蛋']);
});
test('a manual duplicate supersedes a generated row without losing details',()=>{
  const state=recipeState('雞蛋');syncMealIngredients(state);
  state.shopping.push({id:'manual',name:'雞蛋',quantity:'1 盒',category:'蛋奶',assignee:'p2',done:false,source:'manual'});
  syncMealIngredients(state);expect(state.shopping).toHaveLength(1);expect(state.shopping[0]).toMatchObject({id:'manual',quantity:'1 盒',mealIds:['meal-0']});
});
test('purchased orphans stay after being unchecked; manual orphans are visibly marked',()=>{
  const state=recipeState('雞蛋、牛肉片');syncMealIngredients(state);find(state,'雞蛋').done=true;find(state,'牛肉片').source='manual';
  state.meals=[];syncMealIngredients(state);expect(state.shopping.every(s=>s.recipeRemoved)).toBe(true);
  find(state,'雞蛋').done=false;syncMealIngredients(state);expect(state.shopping).toHaveLength(2);expect(isValidState(state)).toBe(true);
});
test('only one legacy duplicate is linked so the other remains removable',()=>{
  const state=recipeState('雞蛋');state.shopping=['one','two'].map(id=>({id,name:'雞蛋',quantity:'1 盒',category:'蛋奶',assignee:'',done:false}));
  syncMealIngredients(state);expect(state.shopping.map(s=>s.mealIds.length)).toEqual([1,0]);
});
test('one-way storage migration preserves original data and ignores later old-tab writes',()=>{
  const legacy=seed(),data=new Map([[LEGACY_STORAGE_KEY,JSON.stringify(legacy)]]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
  const result=readStorage(storage);expect(result.migratedFromLegacy).toBe(true);syncMealIngredients(result.state);save(storage,result.state);
  expect(data.get(LEGACY_STORAGE_KEY)).toBe(JSON.stringify(legacy));legacy.trip.title='Old tab';data.set(LEGACY_STORAGE_KEY,JSON.stringify(legacy));expect(load(storage).trip.title).not.toBe('Old tab');expect(data.has(STORAGE_KEY)).toBe(true);
});
test.each([['茶葉蛋','蛋奶'],['蒜味香腸','肉類'],['薑母鴨','肉類'],['鹽酥雞','肉類'],['洋蔥豬肉','肉類'],['番茄牛腩','肉類'],['蒜蓉蝦','海鮮'],['吳郭魚','海鮮'],['蠔油','調味料'],['柳橙汁','飲料'],['蜂蜜蛋糕','零食'],['玉米片','零食'],['梅花豬','肉類']])('specific product classification: %s',(name,category)=>expect(classifyIngredient(name)).toBe(category));

test.each(['醬油 1瓶','醬油膏','鹽 1包','鹽麴'])('seasoning names remain recognizable: %s',name=>expect(classifyIngredient(name)).toBe('調味料'));


test('ingredient delimiters support slash and periods with numeric decimal preservation',()=>{
 expect(parseIngredients('牛肉片/高麗菜,雞蛋.起司。白米、鮮奶')).toEqual(['牛肉片','高麗菜','雞蛋','起司','白米','鮮奶']);
 expect(parseIngredients('牛肉片／高麗菜．鸡蛋，白米')).toEqual(['牛肉片','高麗菜','鸡蛋','白米']);
 expect(parseIngredients('牛奶 1.5L/白米 1,000g.雞蛋')).toEqual(['牛奶 1.5L','白米 1,000g','雞蛋']);
 expect(parseIngredients(' /、.,。／． ')).toEqual([]);
 const state=recipeState('牛肉片/高麗菜,雞蛋.板豆腐。醬油');syncMealIngredients(state);
 expect(state.shopping.map(s=>s.name)).toEqual(['牛肉片','高麗菜','雞蛋','板豆腐','醬油']);
 expect(state.shopping.map(s=>s.category)).toEqual(['肉類','蔬菜','蛋奶','豆製品','調味料']);
});
