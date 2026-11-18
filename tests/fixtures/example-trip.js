// Example_Trip and Example_Text from the trip-planning-workflow-enhance requirements (introduction,
// 「範例行程與預期文字版」; design 「Example_Trip 固定資料」). Playwright tests (through
// tests/local-planner-fixture.js) and bun tests use this same data.
import { syncMealIngredients } from '../../src/ingredients.js';
import { DESTINATION_REF } from '../../src/itinerary-model.js';

const DAY_1 = '2026-10-20', DAY_2 = '2026-10-21', DAY_3 = '2026-10-22';

// Every activity is for all participants (people: [] and no vehicleIds) and has no location or note.
const activity = (id, date, time, title, type) => ({ id, date, time, title, type, location: '', note: '', people: [], done: false });
// Every meal uses the default time of its slot, so no meal has a `time` key.
const meal = (id, date, slot, title, ingredients) => ({ id, date, slot, title, cookId: '', servings: 8, ingredients, notes: '' });
const shoppingItem = (id, name, quantity, category, assignee) => ({ id, name, quantity, category, assignee, done: false, source: 'manual' });
const route = (id, date, vehicleId, from, to, time, stops = []) => ({ id, date, vehicleId, from, to, time, stops });

/**
 * A new Example_Trip Trip_State on every call; callers may change it freely.
 *
 * Identifiers: people p1–p8 (小安、阿哲、小雨、阿森、米米、大海、阿凱、小芸); vehicles v1–v4 (第一車 to 第四車);
 * places pl-a, pl-b, pl-c, pl-d (出發地點 A to D), pl-shop (超市／賣場) and pl-taipei (台北); routes rt-1-v1 to rt-1-v4
 * (day 1, to the destination) and rt-3-v1 to rt-3-v4 (day 3, back to 台北); stop st-1 (第三車・採買組 shops at
 * 超市／賣場 on day 1); activities a1–a10; meals m1 (day 1 dinner) to m5 (day 3 breakfast); the eight manual shopping
 * items s1–s8 (s1–s3 for 小雨, s4–s8 for 大海); and s9–s18, the recipe ingredients (assignee '' = 待分配) that
 * syncMealIngredients() added. Because that sync already ran, running it again (as the Local_Planner does when it
 * loads) does not change the state.
 */
export function exampleTrip() {
  const state = {
    schema: 1, revision: 0, currentUser: 'p1', joined: true,
    trip: {
      title: '夕淞度日', destination: '夕淞度日營區', startDate: DAY_1, endDate: DAY_3,
      description: '一起，把日子過慢一點。\n把喜歡的小地方，畫進我們的旅程。', note: ''
    },
    people: [
      { id: 'p1', name: '小安', color: 'coral', role: '這趟的召集人' },
      { id: 'p2', name: '阿哲', color: 'blue', role: '咖啡擔當' },
      { id: 'p3', name: '小雨', color: 'green', role: '料理小隊長' },
      { id: 'p4', name: '阿森', color: 'yellow', role: '營火守護者' },
      { id: 'p5', name: '米米', color: 'lavender', role: '底片記錄員' },
      { id: 'p6', name: '大海', color: 'peach', role: '路上的 DJ' },
      { id: 'p7', name: '阿凱', color: 'coral', role: '帳篷工程師' },
      { id: 'p8', name: '小芸', color: 'blue', role: '甜點擔當' }
    ],
    activities: [
      activity('a1', DAY_1, '13:00', '搭帳・營地佈置', 'pitch'),
      activity('a2', DAY_1, '20:00', '星空夜聊・自由活動', 'night'),
      activity('a3', DAY_2, '08:00', '起床', 'wake'),
      activity('a4', DAY_2, '10:00', '自由活動、拍照', 'free'),
      activity('a5', DAY_2, '14:00', '下午茶、聊天、玩遊戲', 'tea'),
      activity('a6', DAY_2, '20:00', '自由活動', 'night'),
      activity('a7', DAY_3, '08:00', '起床', 'wake'),
      activity('a8', DAY_3, '10:00', '拆帳、整理裝備', 'strike'),
      activity('a9', DAY_3, '11:30', '環境清潔、裝車', 'clean'),
      activity('a10', DAY_3, '12:00', '四車集合、返程', 'return')
    ],
    meals: [
      meal('m1', DAY_1, '晚餐', '烤肉派對', ''),
      meal('m2', DAY_2, '早餐', '早餐', '培根、炒蛋、吐司、咖啡'),
      meal('m3', DAY_2, '午餐', '午餐', '台式炒泡麵、香腸、煎蛋'),
      meal('m4', DAY_2, '晚餐', '豪華火鍋', ''),
      meal('m5', DAY_3, '早餐', '早餐', '蘿蔔糕、荷包蛋、熱狗、咖啡')
    ],
    shopping: [
      shoppingItem('s1', '五花肉片', '2 盒', '肉類', 'p3'),
      shoppingItem('s2', '鮮蝦', '1 盒', '海鮮', 'p3'),
      shoppingItem('s3', '高麗菜', '1 顆', '蔬菜', 'p3'),
      shoppingItem('s4', '運動飲料', '8 瓶', '飲料', 'p6'),
      shoppingItem('s5', '洋芋片', '3 包', '零食', 'p6'),
      shoppingItem('s6', '瓦斯', '4 罐', '其他', 'p6'),
      shoppingItem('s7', '衛生紙', '1 串', '其他', 'p6'),
      shoppingItem('s8', '免洗餐具', '1 組', '其他', 'p6')
    ],
    gear: [],
    vehicles: [
      { id: 'v1', name: '第一車', driver: 'p1', seats: 4, passengers: ['p2'], meeting: '' },
      { id: 'v2', name: '第二車', driver: 'p4', seats: 4, passengers: ['p5'], meeting: '' },
      { id: 'v3', name: '第三車・採買組', driver: 'p3', seats: 4, passengers: ['p6'], meeting: '' },
      { id: 'v4', name: '第四車', driver: 'p7', seats: 4, passengers: ['p8'], meeting: '' }
    ],
    places: [
      { id: 'pl-a', name: '出發地點 A' },
      { id: 'pl-b', name: '出發地點 B' },
      { id: 'pl-c', name: '出發地點 C' },
      { id: 'pl-d', name: '出發地點 D' },
      { id: 'pl-shop', name: '超市／賣場' },
      { id: 'pl-taipei', name: '台北' }
    ],
    routes: [
      route('rt-1-v1', DAY_1, 'v1', 'pl-a', DESTINATION_REF, '08:00'),
      route('rt-1-v2', DAY_1, 'v2', 'pl-b', DESTINATION_REF, '08:30'),
      route('rt-1-v3', DAY_1, 'v3', 'pl-c', DESTINATION_REF, '09:00', [{ id: 'st-1', place: 'pl-shop', kind: 'shop' }]),
      route('rt-1-v4', DAY_1, 'v4', 'pl-d', DESTINATION_REF, '09:30'),
      route('rt-3-v1', DAY_3, 'v1', DESTINATION_REF, 'pl-taipei', '12:00'),
      route('rt-3-v2', DAY_3, 'v2', DESTINATION_REF, 'pl-taipei', '12:00'),
      route('rt-3-v3', DAY_3, 'v3', DESTINATION_REF, 'pl-taipei', '12:00'),
      route('rt-3-v4', DAY_3, 'v4', DESTINATION_REF, 'pl-taipei', '12:00')
    ],
    // No day sets a place, so every Day_Location is the trip destination.
    daySettings: [
      { date: DAY_1, title: '向山裡出發', arrival: '12:00' },
      { date: DAY_2, title: '住進慢慢的日子' },
      { date: DAY_3, title: '把快樂一起帶回家' }
    ],
    events: [],
    departed: []
  };
  let count = state.shopping.length;
  syncMealIngredients(state);
  // The sync gives the ingredient rows it adds random identifiers; number them after the manual items instead.
  state.shopping = state.shopping.map(item => (item.source === 'meal' ? { ...item, id: `s${++count}` } : item));
  return state;
}

/** Example_Text: the expected Itinerary_Text of exampleTrip(). Lines are joined with LF; no newline after the last line. */
export const EXAMPLE_TEXT = [
  '夕淞度日｜三天兩夜',
  '',
  '一起，把日子過慢一點。',
  '',
  '把喜歡的小地方，畫進我們的旅程。',
  '',
  '車輛：第一車、第二車、第三車・採買組、第四車',
  '',
  '第 1 天・10/20（週二）｜向山裡出發',
  '地點：夕淞度日營區',
  '',
  '路線',
  '第一車｜08:00 出發：出發地點 A → 夕淞度日營區',
  '第二車｜08:30 出發：出發地點 B → 夕淞度日營區',
  '第三車・採買組｜09:00 出發：出發地點 C → 超市／賣場（採買：五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具） → 夕淞度日營區',
  '第四車｜09:30 出發：出發地點 D → 夕淞度日營區',
  '預計 12:00 抵達・四車會合',
  '',
  '活動',
  '13:00 搭帳・營地佈置（搭帳）',
  '18:00 晚餐：烤肉派對（烤肉）',
  '20:00 星空夜聊・自由活動（夜晚）',
  '',
  '第 2 天・10/21（週三）｜住進慢慢的日子',
  '地點：夕淞度日營區',
  '',
  '活動',
  '08:00 起床（起床）',
  '08:30 早餐（早餐）',
  '培根、炒蛋、吐司、咖啡',
  '',
  '10:00 自由活動、拍照（自由活動）',
  '12:00 午餐（午餐）',
  '台式炒泡麵、香腸、煎蛋',
  '',
  '14:00 下午茶、聊天、玩遊戲（下午茶／遊戲）',
  '18:00 晚餐：豪華火鍋（火鍋）',
  '20:00 自由活動（夜晚）',
  '',
  '第 3 天・10/22（週四）｜把快樂一起帶回家',
  '地點：夕淞度日營區',
  '',
  '活動',
  '08:00 起床（起床）',
  '08:30 早餐（早餐）',
  '蘿蔔糕、荷包蛋、熱狗、咖啡',
  '',
  '10:00 拆帳、整理裝備（拆帳）',
  '11:30 環境清潔、裝車（清潔）',
  '12:00 四車集合、返程（返程）',
  '',
  '路線',
  '第一車｜12:00 出發：夕淞度日營區 → 台北',
  '第二車｜12:00 出發：夕淞度日營區 → 台北',
  '第三車・採買組｜12:00 出發：夕淞度日營區 → 台北',
  '第四車｜12:00 出發：夕淞度日營區 → 台北',
  '平安返回台北・不預估返抵時間'
].join('\n');
