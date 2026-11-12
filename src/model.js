import { validActivityVehicles } from './vehicle-itinerary.js';
import { SHOPPING_CATEGORIES } from './ingredients.js';
import { DISH_TYPES } from './recipes.js';
export const LEGACY_STORAGE_KEY = 'ggc-local-demo-v1';
export const STORAGE_KEY = 'ggc-local-demo-v2';
export const THEMES_KEY = 'ggc-local-theme';
export const TABS = [ ['schedule','行程表'], ['meals','料理菜單'], ['shopping','採買清單'], ['gear','裝備分工'], ['expenses','分帳記帳'] ];
/** The tab key to render: the value itself when it is a remaining tab, otherwise 'schedule'. */
export function resolveTab(value) { return TABS.some(([key]) => key === value) ? value : 'schedule'; }
export const COLORS = ['coral', 'blue', 'green', 'yellow', 'lavender', 'peach'];
export const uid = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const escape = value => String(value ?? '').replace(/[&<>"'`]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'}[char]));
export const dateLabel = date => new Date(`${date}T12:00:00`).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
export const weekday = date => new Date(`${date}T12:00:00`).toLocaleDateString('zh-TW', { weekday: 'short' });
export const isoDate = date => date.toISOString().slice(0, 10);
export function dateRange(start, end) {
  const result = [];
  const first = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(+first) || !Number.isFinite(+last) || last < first || isoDate(first) !== start || isoDate(last) !== end || +last - +first > 30 * 86400000) return result;
  for (let d = first; d <= last && result.length < 31; d = new Date(+d + 86400000)) result.push(isoDate(d));
  return result;
}
export const personName = (state, id) => state.people.find(p => p.id === id)?.name || '待分配';
export function emptyState(date = new Date()) {
  const today = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return {
    schema: 1, revision: 0, currentUser: 'me', joined: true,
    trip: {title:'我的露營旅行',destination:'',startDate:today,endDate:today,description:'',note:''},
    people: [{id:'me',name:'我',color:'coral',role:'旅行召集人'}],
    activities: [], meals: [], shopping: [], gear: [], vehicles: [], events: [], departed: []
  };
}
export function seed() {
  return {
    schema: 1, revision: 0, currentUser: 'p1', joined: true,
    trip: { title: '雲海裡，住一晚', destination: '山間小日子營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '一起煮飯、一起看星星。把忙碌留在山下，把好日子帶上來。', note: '山上早晚溫差大，記得帶保暖外套。這趟不趕路，慢慢來就好。' },
    people: [ {id:'p1',name:'小安',color:'coral',role:'這趟的召集人'}, {id:'p2',name:'阿哲',color:'blue',role:'咖啡擔當'}, {id:'p3',name:'小雨',color:'green',role:'料理小隊長'}, {id:'p4',name:'阿森',color:'yellow',role:'營火守護者'}, {id:'p5',name:'米米',color:'lavender',role:'底片記錄員'}, {id:'p6',name:'大海',color:'peach',role:'路上的 DJ'} ],
    activities: [
      {id:'a1',date:'2026-11-20',time:'14:00',title:'城市集合，把日常暫停',type:'meet',location:'台北車站東三門',note:'先吃飽再集合，帶上你的好心情。',people:['p1','p2','p3','p4','p5','p6'],done:false},
      {id:'a2',date:'2026-11-20',time:'15:00',title:'把好吃的，一起買齊',type:'market',location:'山下超市',note:'照著採買清單分頭行動，別忘了冰塊。',people:['p1','p3','p5'],done:false},
      {id:'a3',date:'2026-11-20',time:'16:30',title:'你好，山間小日子',type:'camp',location:'山間小日子營地',note:'分工搭帳、擺好椅子，再慢慢喝杯咖啡。',people:['p1','p2','p3','p4','p5','p6'],done:false},
      {id:'a4',date:'2026-11-20',time:'18:30',title:'營地的第一頓晚餐',type:'meal',location:'我們的天幕下',note:'熱騰騰的壽喜燒，配上今晚的聊天時間。',people:['p1','p2','p3','p4','p5','p6'],done:false},
      {id:'a5',date:'2026-11-20',time:'20:00',title:'把星星留給今晚',type:'night',location:'營地草坪',note:'關掉大燈、泡一杯熱可可，一起抬頭看看。',people:[],done:false},
      {id:'a6',date:'2026-11-21',time:'08:30',title:'被咖啡香叫醒',type:'meal',location:'天幕下',note:'沒有鬧鐘的早晨，從一杯手沖開始。',people:['p2'],done:false},
      {id:'a7',date:'2026-11-21',time:'10:00',title:'走一段森林小徑',type:'camp',location:'營地周邊步道',note:'帶水和輕便外套，遇到喜歡的風景就停下。',people:[],done:false},
      {id:'a8',date:'2026-11-21',time:'18:00',title:'炭火上的小派對',type:'meal',location:'我們的營位',note:'阿森負責生火，其他人一起串蔬菜。',people:['p3','p4'],done:false},
      {id:'a9',date:'2026-11-22',time:'09:00',title:'最後一杯咖啡，再慢慢收拾',type:'meal',location:'營地',note:'一起留下比來時更乾淨的營地。',people:[],done:false},
      {id:'a10',date:'2026-11-22',time:'11:00',title:'把回憶帶回家',type:'travel',location:'回程路上',note:'下次，換一座山見。',people:[],done:false}
    ],
    meals: [
      {id:'m1',date:'2026-11-20',slot:'晚餐',title:'暖暖壽喜燒',cookId:'p3',servings:6,ingredients:'牛肉片、板豆腐、高麗菜、香菇、壽喜燒醬',notes:'先煎洋蔥，再加入醬汁和食材慢慢煮。'},
      {id:'m2',date:'2026-11-21',slot:'早餐',title:'熱壓吐司與手沖咖啡',cookId:'p2',servings:6,ingredients:'吐司、雞蛋、起司、咖啡豆',notes:'起司加倍，咖啡慢慢喝。'},
      {id:'m3',date:'2026-11-21',slot:'晚餐',title:'星空下的炭火燒烤',cookId:'p4',servings:6,ingredients:'雞腿肉、香腸、玉米、甜椒、棉花糖',notes:'生熟食分開夾取，雞肉要烤熟。'},
      {id:'m4',date:'2026-11-22',slot:'早餐',title:'簡單吃，也很幸福',cookId:'p1',servings:6,ingredients:'貝果、奶油、水果、鮮奶',notes:'把剩下的食材好好吃完。'}
    ],
    shopping: [
      {id:'s1',name:'牛肉片',quantity:'2 盒',category:'肉類',assignee:'p3',done:false},
      {id:'s2',name:'雞腿肉',quantity:'6 片',category:'肉類',assignee:'p4',done:false},
      {id:'s3',name:'高麗菜',quantity:'1 顆',category:'蔬菜',assignee:'p1',done:true},
      {id:'s4',name:'香菇',quantity:'2 包',category:'蔬菜',assignee:'p1',done:false},
      {id:'s5',name:'甜椒、玉米',quantity:'各 3 個',category:'蔬菜',assignee:'p5',done:false},
      {id:'s6',name:'板豆腐',quantity:'2 盒',category:'蛋奶',assignee:'p3',done:false},
      {id:'s7',name:'雞蛋',quantity:'1 盒',category:'蛋奶',assignee:'p1',done:true},
      {id:'s8',name:'吐司、貝果',quantity:'各 1 包',category:'主食',assignee:'p5',done:false},
      {id:'s9',name:'咖啡豆',quantity:'250 g',category:'飲料',assignee:'p2',done:true},
      {id:'s10',name:'飲用水',quantity:'12 L',category:'飲料',assignee:'p6',done:false},
      {id:'s11',name:'棉花糖',quantity:'1 包',category:'零食',assignee:'p5',done:false},
      {id:'s12',name:'冰塊',quantity:'2 袋',category:'其他',assignee:'',done:false}
    ],
    gear: [
      {id:'g1',name:'睡袋',quantity:'1 個',scope:'personal',assignee:'',ready:[]},
      {id:'g2',name:'睡墊',quantity:'1 個',scope:'personal',assignee:'',ready:[]},
      {id:'g3',name:'餐具與水杯',quantity:'1 組',scope:'personal',assignee:'',ready:[]},
      {id:'g4',name:'保暖外套',quantity:'1 件',scope:'personal',assignee:'',ready:[]},
      {id:'g5',name:'雙人帳篷',quantity:'1 頂',scope:'shared',assignee:'p1',ready:[]},
      {id:'g6',name:'天幕與營柱',quantity:'1 組',scope:'shared',assignee:'p4',ready:[]},
      {id:'g7',name:'卡式爐與瓦斯',quantity:'1 組',scope:'shared',assignee:'p3',ready:[]},
      {id:'g8',name:'手沖咖啡組',quantity:'1 組',scope:'shared',assignee:'p2',ready:['p2']},
      {id:'g9',name:'冰桶',quantity:'1 個',scope:'shared',assignee:'p6',ready:[]},
      {id:'g10',name:'營燈',quantity:'2 盞',scope:'shared',assignee:'',ready:[]},
      {id:'g11',name:'延長線',quantity:'1 條',scope:'shared',assignee:'',ready:[]}
    ],
    vehicles: [{id:'v1',name:'山線小巴',driver:'p2',seats:4,passengers:['p1','p3'],meeting:'14:00 · 台北車站東三門'}, {id:'v2',name:'海風號',driver:'p6',seats:4,passengers:['p4','p5'],meeting:'14:00 · 台北車站東三門'}],
    events: [{id:'e1',text:'建立了這本旅行手冊',at:'2026-11-03T08:30:00.000Z',actor:'小安'}],
    departed: []
  };
}
export function isValidState(value) {
  if (!value || value.schema !== 1 || !value.trip || !Array.isArray(value.people) || !value.people.length || value.people.length > 100) return false;
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.joined !== 'boolean') return false;
  if (!['title','destination','startDate','endDate','description','note'].every(k => typeof value.trip[k] === 'string' && value.trip[k].length <= 5000)) return false;
  const dates = dateRange(value.trip.startDate, value.trip.endDate);
  if (!dates.length || !value.trip.title.trim()) return false;
  const specs = {people:['id','name','color','role'], activities:['id','date','time','title','type','location','note'], meals:['id','date','slot','title','cookId','ingredients','notes'], shopping:['id','name','quantity','category','assignee'], gear:['id','name','quantity','scope','assignee'], vehicles:['id','name','driver','meeting'], events:['id','text','at','actor']};
  for (const [collection, fields] of Object.entries(specs)) {
    if (!Array.isArray(value[collection]) || value[collection].length > 1000) return false;
    if (!value[collection].every(item => item && fields.every(key => typeof item[key] === 'string' && item[key].length <= 5000) && item.id.length > 0)) return false;
    if (new Set(value[collection].map(i => i.id)).size !== value[collection].length) return false;
  }
  const people = new Set(value.people.map(p => p.id));
  const person = id => id === '' || people.has(id);
  const ids = list => Array.isArray(list) && list.length === new Set(list).size && list.every(id => typeof id === 'string' && people.has(id));
  return people.has(value.currentUser)
    && value.people.every(p => p.name.trim() && COLORS.includes(p.color))
    && value.gear.every(g => ['personal','shared'].includes(g.scope) && person(g.assignee) && ids(g.ready) && (g.scope !== 'shared' || g.ready.every(id => id === g.assignee)))
    && value.activities.every(a => dates.includes(a.date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(a.time) && ['meet','market','camp','meal','night','travel'].includes(a.type) && ids(a.people) && validActivityVehicles(a, value.vehicles) && typeof a.done === 'boolean')
    && value.shopping.every(s => typeof s.done === 'boolean' && person(s.assignee) && SHOPPING_CATEGORIES.includes(s.category) && (s.recipeRemoved === undefined || typeof s.recipeRemoved === 'boolean') && (s.source === undefined || ['meal','manual'].includes(s.source)) && (s.mealIds === undefined || (Array.isArray(s.mealIds) && s.mealIds.length === new Set(s.mealIds).size && s.mealIds.every(id => value.meals.some(m => m.id === id)))))
    && value.meals.every(m => (m.imageKind === undefined || DISH_TYPES.some(([id])=>id===m.imageKind)) && dates.includes(m.date) && person(m.cookId) && Number.isInteger(m.servings) && m.servings > 0 && m.servings <= 100)
    && value.vehicles.every(v => person(v.driver) && ids(v.passengers) && !v.passengers.includes(v.driver) && Number.isInteger(v.seats) && v.seats > 0 && v.seats <= 9 && v.passengers.length + 1 <= v.seats)
    && value.events.every(ev => Number.isFinite(Date.parse(ev.at))) && ids(value.departed);
}
export function readStorage(storage) {
  let raw, migratedFromLegacy=false;
  try { raw = storage.getItem(STORAGE_KEY); if(raw===null){raw=storage.getItem(LEGACY_STORAGE_KEY);migratedFromLegacy=raw!==null;} } catch { return {state:emptyState(),status:'unavailable'}; }
  if (raw === null) return {state:emptyState(),status:'empty'};
  try { const state = JSON.parse(raw); if(isValidState(state)) return {state,status:'ok',migratedFromLegacy}; } catch {}
  return {state:emptyState(),status:'invalid',raw};
}
export function load(storage) { return readStorage(storage).state; }
export function save(storage, state) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; } catch { return false; }
}
export function myGear(state, person = state.currentUser) { return state.gear.filter(g => g.scope === 'personal' || g.assignee === person); }
export function readyCount(state, person = state.currentUser) { return myGear(state, person).filter(g => g.ready.includes(person)).length; }
export function unassigned(state) { return state.gear.filter(g => g.scope === 'shared' && !g.assignee); }
export function togglePacking(state, id) {
  const item = state.gear.find(g => g.id === id);
  if (!item || !myGear(state).some(g => g.id === id)) return false;
  item.ready = item.ready.includes(state.currentUser) ? item.ready.filter(p => p !== state.currentUser) : [...item.ready, state.currentUser];
  if (!item.ready.includes(state.currentUser)) state.departed = state.departed.filter(p => p !== state.currentUser);
  return true;
}
export function assignShopping(state, id, person) {
  const item = state.shopping.find(s => s.id === id);
  if (!item || typeof person !== 'string' || (person && !state.people.some(p => p.id === person)) || item.assignee === person) return false;
  item.assignee = person;
  item.source = 'manual';
  return true;
}
export function assignGear(state, id, person) {
  const item = state.gear.find(g => g.id === id);
  if (!item || (person && !state.people.some(p => p.id === person))) return false;
  item.assignee = person; item.ready = []; state.departed = []; return true;
}
export function canDepart(state) { return readyCount(state) === myGear(state).length && unassigned(state).length === 0; }
export function progress(state) {
  const total = state.gear.reduce((n,g) => n + (g.scope === 'personal' ? state.people.length : 1), 0);
  const done = state.gear.reduce((n,g) => n + (g.scope === 'personal' ? g.ready.length : Number(!!g.assignee && g.ready.includes(g.assignee))),0);
  return {shoppingDone:state.shopping.filter(s => s.done).length,shoppingTotal:state.shopping.length,gearDone:done,gearTotal:total};
}
export function logEvent(state, text) { state.revision = (state.revision || 0) + 1; state.events.unshift({id:uid(),text,actor:personName(state,state.currentUser),at:new Date().toISOString()}); state.events = state.events.slice(0, 50); }

export const normalizeParticipantName = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu,' ');
const participantKey = value => normalizeParticipantName(value).replace(/\p{Default_Ignorable_Code_Point}/gu,'').toLocaleLowerCase('zh-TW');
export function addParticipant(state, name, role = '') {
  const normalized=normalizeParticipantName(name), normalizedRole=normalizeParticipantName(role);
  if(!participantKey(normalized).trim())throw new Error('請填寫名字或暱稱，不能只有空白。');
  const controlCheck=normalized.replace(/(\p{Extended_Pictographic}\p{Variation_Selector}?\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})/gu,'$1');
  if(/[\p{Cf}\p{Cc}]/u.test(controlCheck))throw new Error('名字不能包含隱藏控制字元。');
  if([...normalized].length>30)throw new Error('名字最多 30 個字。');
  if([...normalizedRole].length>60)throw new Error('小隊角色最多 60 個字。');
  if(state.people.some(p=>participantKey(p.name)===participantKey(normalized)))throw new Error('這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。');
  if(state.people.length>=100)throw new Error('小隊最多 100 位旅伴，目前已額滿。');
  const person={id:uid(),name:normalized,role:normalizedRole||'新加入的旅伴',color:COLORS[state.people.length%COLORS.length]};
  return {state:{...state,people:[...state.people,person],departed:[]},person};
}
