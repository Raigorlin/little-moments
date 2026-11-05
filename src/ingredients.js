export const SHOPPING_CATEGORIES = ['肉類','海鮮','蔬菜','水果','蛋奶','豆製品','主食','調味料','飲料','零食','其他'];
const keyOf = name => name.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-TW');

// Keep quantities in the shopping list. Ingredient names are not a quantity parser.
export function parseIngredients(text = '') {
  const unique = new Map();
  for (const part of text.normalize('NFKC').split(/[、，;；\/。\r\n]+|(?<!\d)[,.]|[,.](?!\d)/u)) {
    const name = part.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (name && !unique.has(keyOf(name))) unique.set(keyOf(name), name);
  }
  return [...unique.values()];
}

// Specific products precede broad food names: 雞粉 is seasoning, not meat.
// Local, offline rules only. Unknown names stay editable under 其他.
const rules = [
  ['零食', /玉米片|蛋糕/],
  ['蛋奶', /茶葉蛋/],
  ['肉類', /(?:蒜味|蒜香)香腸|薑母鴨|鹽酥雞|麻油雞|醬燒雞腿/],
  ['調味料', /醬油|鹽麴|^鹽(?:\d|$)|醬(?:油|汁|料|包)?$|醬[\d\s]|魚露|蠔油|醋|鹽(?:巴|粒)?$|胡椒|香料|調味|咖哩粉|咖哩塊|雞粉|雞精粉|高湯|湯底|味醂|米酒|料酒|味噌|芥末|孜然|八角|肉桂|橄欖油|沙拉油|食用油|麻油|香油|砂糖|冰糖|黑糖|紅糖|白糖|蜂蜜|辣油|辣粉|辣椒粉|辣椒油|味精|柴魚粉/],
  ['零食', /棉花糖|餅乾|洋芋片|薯片|爆米花|巧克力|糖果|布丁|果凍|冰淇淋|堅果|瓜子|花生糖|鳳梨酥|蛋捲|肉乾|魚酥/],
  ['飲料', /豆漿|米漿|燕麥奶|椰奶|杏仁奶|奶茶|咖啡|可可粉|茶葉|紅茶|綠茶|烏龍茶|汽水|氣泡水|飲用水|礦泉水|果汁|柳橙汁|啤酒|紅酒|白酒|運動飲料/],
  ['豆製品', /豆腐|豆乾|豆干|豆皮|腐竹|素肉|素雞|素鴨|百頁|百葉豆腐/],
  ['主食', /吐司|土司|貝果|麵包|饅頭|烏龍麵|泡麵|拉麵|義大利麵|冬粉|米粉|米線|麵條|麵粉|餃子皮|餃皮|水餃|餛飩|年糕|白米|糙米|糯米|燕麥|麥片|白飯|米飯|地瓜(?!葉)|馬鈴薯|餅皮/],
  ['蛋奶', /雞蛋|鴨蛋|鵪鶉蛋|皮蛋|鹹蛋|牛奶|鮮奶|奶油|起司|乳酪|優格|優酪乳|煉乳|蛋液|奶粉/],
  ['肉類', /(?:洋蔥|番茄)豬肉|番茄牛腩/],
  ['海鮮', /蒜蓉蝦/],
  ['蔬菜', /高麗菜|白菜|青江菜|小松菜|空心菜|菠菜|花椰菜|青花菜|地瓜葉|大陸妹|萵苣|茼蒿|芥藍|油菜|娃娃菜|包心菜|水蓮|菇|木耳|洋蔥|青蔥|大蔥|蒜|薑|韭菜|芹菜|香菜|九層塔|羅勒|薄荷|玉米|甜椒|青椒|彩椒|辣椒|番茄|蕃茄|茄子|小黃瓜|大黃瓜|櫛瓜|絲瓜|苦瓜|南瓜|冬瓜|胡蘿蔔|紅蘿蔔|白蘿蔔|筍|竹筍|蘆筍|蓮藕|芋頭|秋葵|豆芽|毛豆|豌豆|四季豆|荷蘭豆|甜豆|花生|海帶|紫菜|海苔/],
  ['水果', /水果|蘋果|香蕉|芭樂|鳳梨|奇異果|柳丁|橘子|橙子|葡萄|草莓|藍莓|西瓜|哈密瓜|香瓜|木瓜|芒果|水蜜桃|百香果|火龍果|檸檬|柚子|酪梨|櫻桃|荔枝|龍眼|蓮霧|梨子|水梨/],
  ['海鮮', /吳郭魚|鮭魚|鯖魚|鱈魚|鯛魚|鮪魚|秋刀魚|虱目魚|鱸魚|魚片|魚排|魚丸|魚板|蝦|蟹|蛤蜊|蛤蠣|蛤仔|扇貝|干貝|蛎|牡蠣|蚵|透抽|小卷|中卷|花枝|魷魚|章魚|海鮮/],
  ['肉類', /牛肉|牛排|牛腩|牛肋|牛五花|豬肉|豬排|豬五花|豬梅花|豬里肌|豬絞肉|雞肉|雞腿|雞胸|雞翅|雞柳|全雞|鴨肉|鴨胸|鴨腿|羊肉|羊排|培根|香腸|火腿|熱狗|貢丸|肉丸|絞肉|排骨|五花肉|里肌肉|梅花肉|梅花豬|肉片/]
];
const exact = {肉:'肉類',雞:'肉類',豬:'肉類',牛:'肉類',魚:'海鮮',蛋:'蛋奶',奶:'蛋奶',米:'主食',麵:'主食',水:'飲料',茶:'飲料',鹽:'調味料',糖:'調味料',油:'調味料',蔬菜:'蔬菜'};
export function classifyIngredient(name) {
  const key = keyOf(name);
  if (Object.hasOwn(exact, key)) return exact[key];
  return rules.find(([,pattern]) => pattern.test(key))?.[0] || '其他';
}

/** Reconcile recipe needs, without changing existing amounts, buyers or categories.
 * Old/manual combined rows (甜椒、玉米) cover both names without copying quantities.
 * Only unused, unpurchased, unedited recipe-generated rows are removed.
 * Compute first, then apply, so a capacity error cannot partially change the list.
 */
export function syncMealIngredients(state) {
  const needs = new Map();
  for (const meal of state.meals) {
    for (const name of parseIngredients(meal.ingredients)) {
      const key = keyOf(name);
      if (!needs.has(key)) needs.set(key, {name, mealIds:[]});
      needs.get(key).mealIds.push(meal.id);
    }
  }
  // A manual/purchased row takes precedence over an untouched generated duplicate.
  const owner = new Map();
  const priority = item => item.source === 'meal' && !item.done ? 1 : 0;
  for (const item of [...state.shopping].sort((a,b) => priority(a)-priority(b))) {
    for (const name of parseIngredients(item.name)) {
      const key=keyOf(name);
      if (!owner.has(key)) owner.set(key,item.id);
    }
  }
  const covered = new Set();
  let added = 0, removed = 0;
  const shopping = [];
  for (const item of state.shopping) {
    const keys = parseIngredients(item.name).map(keyOf);
    const mealIds = [...new Set(keys.filter(key => owner.get(key)===item.id).flatMap(key => needs.get(key)?.mealIds || []))];
    if (item.source === 'meal' && !mealIds.length && !item.done) { removed++; continue; }
    const recipeRemoved = !keys.some(key => needs.has(key)) && Boolean(item.recipeRemoved || item.mealIds?.length);
    const kept = {...item, mealIds};
    if(recipeRemoved || item.recipeRemoved !== undefined) kept.recipeRemoved=recipeRemoved;
    // Once kept because it was bought, the orphan is a manual item, even if unchecked later.
    if(item.source==='meal' && item.done && !mealIds.length) kept.source='manual';
    shopping.push(kept);
    for (const key of keys) covered.add(key);
  }
  for (const [key, need] of needs) {
    if (covered.has(key)) continue;
    shopping.push({id:globalThis.crypto.randomUUID(),name:need.name,quantity:'數量待確認',category:classifyIngredient(need.name),assignee:'',done:false,source:'meal',mealIds:need.mealIds});
    added++;
  }
  if (shopping.length > 1000) throw new Error('採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。');
  const changed = JSON.stringify(shopping) !== JSON.stringify(state.shopping);
  if (changed) state.shopping = shopping;
  return {changed,added,removed};
}
