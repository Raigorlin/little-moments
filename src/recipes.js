import {parseIngredients} from './ingredients.js';
export const DISH_TYPES = [
  ['hotpot','壽喜燒／火鍋'],['bbq','烤肉串燒'],['toast','熱壓吐司'],['curry','咖哩飯'],
  ['pasta','義大利麵'],['breakfast','貝果早餐'],['salad','蔬菜沙拉'],['custom','通用餐盤']
];
export const RECIPE_TEMPLATES = [
  {id:'sukiyaki',title:'暖暖壽喜燒',imageKind:'hotpot',ingredients:'牛肉片、板豆腐、高麗菜、香菇、洋蔥、壽喜燒醬',notes:'先煎洋蔥，再加入醬汁和食材慢慢煮。'},
  {id:'hotpot',title:'什錦火鍋',imageKind:'hotpot',ingredients:'豬肉片、高麗菜、金針菇、板豆腐、玉米、蛤蜊、高湯',notes:'依食材熟成時間分批下鍋，生熟食分開夾取。'},
  {id:'bbq',title:'星空炭火燒烤',imageKind:'bbq',ingredients:'雞腿肉、香腸、玉米、甜椒、櫛瓜、烤肉醬',notes:'肉類與蔬菜分開處理，雞肉要烤熟。'},
  {id:'toast',title:'起司熱壓吐司',imageKind:'toast',ingredients:'吐司、雞蛋、起司、火腿、奶油',notes:'吐司外側薄抹奶油，夾入熟蛋與配料後熱壓。'},
  {id:'curry',title:'野炊雞肉咖哩飯',imageKind:'curry',ingredients:'雞腿肉、馬鈴薯、紅蘿蔔、洋蔥、咖哩塊、白米',notes:'先炒香洋蔥與雞肉，燉熟根莖後加入咖哩塊。'},
  {id:'pasta',title:'番茄義大利麵',imageKind:'pasta',ingredients:'義大利麵、番茄、洋蔥、大蒜、絞肉、番茄醬、橄欖油',notes:'煮麵水留一小杯，拌醬時調整濃稠度。'},
  {id:'breakfast',title:'貝果早安盤',imageKind:'breakfast',ingredients:'貝果、雞蛋、奶油、蘋果、鮮奶、咖啡豆',notes:'烤熱貝果，搭配煎蛋、水果與喜歡的飲品。'},
  {id:'salad',title:'清爽野餐沙拉',imageKind:'salad',ingredients:'萵苣、小黃瓜、番茄、玉米、雞蛋、橄欖油',notes:'蔬菜洗淨瀝乾，出餐前再拌入調味。'}
];
export const COMMON_INGREDIENTS = {
  '肉類':['牛肉片','豬肉片','雞腿肉','雞胸肉','香腸','培根','火腿','絞肉'],
  '海鮮':['鮮蝦','蛤蜊','鮭魚','花枝','干貝'],
  '蔬菜':['高麗菜','洋蔥','香菇','金針菇','玉米','甜椒','番茄','紅蘿蔔','小黃瓜','櫛瓜','萵苣','大蒜'],
  '蛋奶':['雞蛋','起司','鮮奶','奶油','優格'],
  '豆製品':['板豆腐','豆皮','豆乾'],
  '主食':['白米','吐司','貝果','義大利麵','烏龍麵','馬鈴薯'],
  '調味料':['壽喜燒醬','烤肉醬','咖哩塊','番茄醬','醬油','橄欖油','鹽','胡椒','高湯'],
  '水果飲料':['蘋果','香蕉','葡萄','咖啡豆','豆漿','飲用水'],
  '點心':['棉花糖','餅乾','巧克力']
};
export function mergeIngredients(current, extra) {
  return parseIngredients(`${current || ''}、${extra || ''}`).join('、');
}
export function applyRecipeTemplate(draft, id) {
  const recipe=RECIPE_TEMPLATES.find(r=>r.id===id);
  if(!recipe)throw new Error('請先選擇常用料理範本。');
  return {...draft,title:recipe.title,notes:recipe.notes,imageKind:recipe.imageKind,ingredients:mergeIngredients(draft.ingredients,recipe.ingredients)};
}
export function inferDishKind(meal) {
  if(DISH_TYPES.some(([id])=>id===meal.imageKind))return meal.imageKind;
  const text=String(meal.title||'');
  for(const [pattern,kind] of [[/壽喜燒|火鍋|涮|湯鍋/,'hotpot'],[/烤肉|燒烤|串燒|串烤|烤雞|烤魚|烤玉米/,'bbq'],[/吐司|土司|三明治/,'toast'],[/咖哩/,'curry'],[/義大利麵|意大利麵|義式麵/,'pasta'],[/沙拉/,'salad'],[/貝果|早餐|早安/,'breakfast']])if(pattern.test(text))return kind;
  const items=parseIngredients(meal.ingredients);
  if(items.some(s=>/貝果/.test(s)))return 'breakfast';
  if(items.some(s=>/吐司|土司/.test(s)))return 'toast';
  if(items.some(s=>/咖哩/.test(s)))return 'curry';
  if(items.some(s=>/義大利麵/.test(s)))return 'pasta';
  if(items.some(s=>/壽喜燒醬|火鍋湯底/.test(s)))return 'hotpot';
  if(items.some(s=>/烤肉醬/.test(s)))return 'bbq';
  return 'custom';
}
