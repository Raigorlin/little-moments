// Feature: trip-planning-workflow-enhance, Property 10: 品項預覽與儲存後的結果相同
// **Validates: Requirements 6.6**
//
// Route 卡片中採買 Stop 的「要買的品項」預覽以 shoppingPlan(previewState(state, draft)) 推導（需求 6.6、D31、設計「規劃
// 行程」）。對每一組通過驗證的 Trip_State 與一張 Route 卡片的 Draft 檢查：
// - previewState() 不改變 state 與 Draft；同一組輸入與它的深拷貝得到相同的預覽。之後的 saveRoute() 與推導也不改變它們。
// - Draft 通過 saveRoute() 的驗證時（ctx.uid 為可重現的識別碼），預覽與儲存後的結果相同。Draft 的路線在兩邊依 routeId
//   找到，新路線則是不在 state 中的那一條，兩邊的日期與車輛都等於 Draft；Draft 中第 i 個 Stop 對應儲存後的第 i 個 Stop
//   （兩邊的任務類型都依 Draft 的順序），不比較預覽自己取的識別碼（新路線、新 Stop 與新地點）。每個 Stop 比較需求 6.6 的
//   內容：地點名稱；採買 Stop 是否為這台車（卡片的「哪一台車」）的 First_Shopping_Stop；是的話比較 Stop_Items（依採買
//   清單的順序，含名稱與「已買」）、Shopping_Summary、「沒有品項由{車名}的駕駛或乘客負責買」，以及每一行「{旅伴}也在
//   {另一台車}，負責買的品項算在{另一台車}」（D29）；不是的話比較「{車名}的採買品項列在第 {N} 天的{地點}」的 N 與地點
//   （D28）。另外比較整份 shoppingPlan()：每位旅伴的 Buyer_Car、每台車的 First_Shopping_Stop（其他路線以識別碼、Draft 的
//   路線以位置表示）與其 Stop_Items 及 Shopping_Summary、Unassigned_Shopping 的品項與原因，以及採買清單分頁的「第 {N} 天
//   在{地點}（{車名}）」。所以 Draft 改變其他車或其他天的 First_Shopping_Stop 時（例如換車、新增或移除採買 Stop），這些
//   結果也必須相同。
// - Draft 只因為不影響採買推導的欄位被拒絕時（Stop、起點或終點還沒選地點，出發時間無效，非採買 Stop 的備註過長，起點與
//   終點相同又沒有 Stop），在副本中補上這些欄位後儲存：預覽仍與儲存後的結果相同。原本沒有選地點的 Stop 在預覽中以
//   「第 {M} 個途中任務」代替地點（需求 6.6，M 是它在路線中的順序），儲存後的同一個位置也以這段文字比較；這時不比較
//   採買清單分頁的地點。Draft 因為車輛、Stop 數量、任務類型或新地點的名稱被拒絕時，只檢查第一點。
// 預覽的品項與說明由本檔依需求 6.6 與 6.11 的條文從 shoppingPlan() 的結果組成；名稱都是儲存的原文。
//
// Draft 以 routeDraft()（一半是含某台車 First_Shopping_Stop 的路線）、newRouteDraft()（需求 5.6）或 legacyRouteDraft()
// （需求 19.11）為起點，再做 0 到 8 次卡片上的修改：
// 改選「哪一台車」（多半是當天沒有路線的車，偶爾是已有路線的車或未選擇）、新增途中任務（排在最後，地點未選擇、任務類型為
// 採買，之後多半選地點）、移除、上移或下移、把任務類型改成採買或改成其他、移除或改掉每個採買 Stop、改選 Stop 的地點（含
// 未選擇）、修改備註（含 101 字）、改選起點或終點、修改出發時間（含全形與無效的輸入），以及以「＋新增地點」加入 Draft 的
// 新地點（名稱前後有空白，偶爾不符合需求 2.1）並選取它。最後多半像使用者儲存前一樣補齊卡片（選車、選地點、清除無效的時間
// 與過長的備註），一部分只補齊 Stop 以外的欄位，其餘保留未完成的欄位。
//
// Trip_State 來自本檔的 shoppingTrip()（1 到 4 天、1 到 4 台車，同一位旅伴常在多台車上，各車在多天有含採買 Stop 的路線，
// 所以 Draft 常改變 First_Shopping_Stop；其中一部分把既有的路線、Stop 與地點改成 previewState() 優先使用的識別碼
// 'new:route'、'new:stop:{i}' 與 'new:{k}'，預覽必須另外取不重複的識別碼，否則兩台車的 First_Shopping_Stop 會共用
// stopItems 的鍵）、需求 23.3 的 itineraryState()，以及本功能之前的 legacyState()（沒有 routes 與 places 鍵）。每個測試確認
// 列出的情況都至少出現一次，且有足夠多組實際比較了儲存後的結果；另一個測試先以需求 6.6、9.5 與 D29 的範例確認本檔組成的
// 預覽。設定環境變數 ITINERARY_PREVIEW_STATS=1 時印出各情況的次數（含 saveRoute() 拒絕的原因）。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { shoppingPlan, shoppingSummary } from '../src/itinerary-derive.js';
import { EDIT_MESSAGES, legacyRouteDraft, newRouteDraft, previewState, routeDraft, saveRoute } from '../src/itinerary-edits.js';
import { DESTINATION_REF, STOP_KINDS } from '../src/itinerary-model.js';
import { SHOPPING_CATEGORIES } from '../src/ingredients.js';
import { COLORS, dateRange, isValidState } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

// fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的測試，所以 30 秒後
// 停止縮小並回報目前的反例；尚未跑完全部組數就到時間也算失敗（failOnInterrupt）。bun test 不顯示錯誤的 cause，所以把
// 不相同的 Stop 與推導結果放進回報的訊息（includeErrorInReport）。
const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
});
const TIMEOUT = 60_000;

// ---- 隨機選擇（fc.gen()）：縮小時數值往 0 靠近，所以選項表的第一個值最簡單，機率型的特徵縮小後關閉 ----
const int = (g, min, max) => (max <= min ? min : g(fc.integer, { min, max }));
const chance = (g, percent) => int(g, 0, 99) >= 100 - percent;
const pick = (g, list) => list[int(g, 0, list.length - 1)];
function shuffle(g, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(g, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const range = n => Array.from({ length: n }, (_, i) => i);
/** 去除前後的 Unicode White_Space（含全形空白與換行）後為空。 */
const isBlank = text => /^\p{White_Space}*$/u.test(String(text ?? ''));
/** 可重現的識別碼（saveRoute() 的 ctx.uid）；'saved:' 開頭的識別碼不會與產生的資料或預覽的識別碼相同。 */
const counter = prefix => {
  let n = 0;
  return () => `${prefix}:${++n}`;
};
const missing = (seen, required) => required.filter(tag => !seen.has(tag));

// ---- 預覽的內容（需求 6.6、6.11），由 shoppingPlan() 的結果組成 ----

/**
 * 地點名稱：Place 的名稱或旅行目的地（儲存的原文）。尚未選擇地點的 Stop 以「第 {M} 個途中任務」代替，M 是它在路線中的
 * 順序（需求 6.5、6.6）；blank 中的位置（補上地點後儲存的 Draft 中，原本沒有選地點的 Stop）在 draftRoute 中也這樣表示。
 */
function labeler(state, draftRoute, blank = new Set()) {
  const names = new Map((state.places ?? []).map(place => [place.id, place.name]));
  return (route, stop) => {
    const index = route.stops.indexOf(stop);
    if (stop.place === '' || (route === draftRoute && blank.has(index))) return `第 ${index + 1} 個途中任務`;
    if (stop.place === DESTINATION_REF) return state.trip.destination;
    return names.has(stop.place) ? names.get(stop.place) : `（找不到地點 ${stop.place}）`;
  };
}

/**
 * 需求 6.6：Draft 的路線中每個 Stop 的預覽，依 Stop 的位置（index 從 0 起算）。每項有任務類型與地點名稱；採買 Stop 另有：
 * - first：是否為這台車（vehicleId，卡片的「哪一台車」）的 First_Shopping_Stop。
 * - 是的話：items（Stop_Items，依採買清單的順序，含名稱與「已買」）、summary（Shopping_Summary）、nobody（「沒有品項由
 *   {車名}的駕駛或乘客負責買」：沒有 Stop_Items，且這台車的駕駛與乘客都不是任何品項的「誰負責買」），以及 elsewhere
 *   （每一行「{旅伴}也在{另一台車}，負責買的品項算在{另一台車}」的 [旅伴, 另一台車]：先駕駛、再依乘客的順序，旅伴至少是
 *   一個品項的「誰負責買」，另一台車是他的 Buyer_Car，D29）。
 * - 不是的話：listedAt（「{車名}的採買品項列在第 {N} 天的{地點}」的 N 與地點，屬於這台車的 First_Shopping_Stop，D28）；
 *   這台車不存在時為 null。
 */
function stopPreviews(state, plan, route, vehicleId, label) {
  const car = state.vehicles.find(vehicle => vehicle.id === vehicleId);
  const members = car ? [...(car.driver ? [car.driver] : []), ...car.passengers] : [];
  const assignees = new Set(state.shopping.map(item => item.assignee).filter(Boolean));
  const personName = id => state.people.find(person => person.id === id)?.name;
  const carName = id => state.vehicles.find(vehicle => vehicle.id === id)?.name;
  const first = plan.firstStop.get(vehicleId);
  return route.stops.map((stop, index) => {
    const view = { index, kind: stop.kind, place: label(route, stop) };
    if (stop.kind !== 'shop') return view;
    if (!first || first.route !== route || first.stop !== stop) {
      return { ...view, first: false, listedAt: first ? { n: first.n, place: label(first.route, first.stop) } : null };
    }
    const items = plan.stopItems.get(stop.id) ?? [];
    return {
      ...view, first: true,
      items: items.map(item => ({ id: item.id, name: item.name, done: item.done })),
      summary: shoppingSummary(items),
      nobody: items.length === 0 && !members.some(id => assignees.has(id)),
      elsewhere: members
        .filter(id => assignees.has(id) && plan.buyerCar.get(id) !== vehicleId)
        .map(id => [personName(id), carName(plan.buyerCar.get(id))])
    };
  });
}

/**
 * 整份 shoppingPlan() 的結果，不含 Draft 路線與其中 Stop 的識別碼（以「Draft 的第 i 個 Stop」表示）：每位旅伴的
 * Buyer_Car；每台車的 First_Shopping_Stop（第 N 天、位置、地點名稱）與其 Stop_Items 的識別碼及 Shopping_Summary；
 * stopItems 的項目數；Unassigned_Shopping 的品項、代碼與原因；locations 為 true 時另有採買清單分頁的「第 {N} 天在{地點}
 * （{車名}）」。
 */
function planView(plan, draftRoute, label, locations) {
  const at = (route, stop) => (route === draftRoute ? `Draft 的第 ${route.stops.indexOf(stop) + 1} 個 Stop` : `路線 ${route.id} 的 Stop ${stop.id}`);
  const view = {
    buyerCar: [...plan.buyerCar],
    firstStop: [...plan.firstStop].map(([vehicleId, { route, stop, n }]) => {
      const items = plan.stopItems.get(stop.id);
      return {
        vehicleId, n, at: at(route, stop), place: label(route, stop),
        items: items ? items.map(item => item.id) : null, summary: shoppingSummary(items ?? [])
      };
    }),
    stopItems: plan.stopItems.size,
    unassigned: plan.unassigned.map(({ item, code, reason }) => [item.id, code, reason])
  };
  if (locations) view.locationOf = [...plan.locationOf].map(([id, { n, placeName, vehicleName }]) => [id, n, placeName, vehicleName]);
  return view;
}

/** after（預覽或儲存後）中 Draft 的路線：routeId 的那一條，新路線則是不在 before 中的那一條；日期與車輛等於 Draft。 */
function draftRouteOf(after, before, draft) {
  const known = new Set((before.routes ?? []).map(route => route.id));
  const found = (after.routes ?? []).filter(route => (draft.routeId ? route.id === draft.routeId : !known.has(route.id)));
  expect({ routeId: draft.routeId, routes: found.map(route => [route.date, route.vehicleId]) })
    .toEqual({ routeId: draft.routeId, routes: [[draft.date, draft.vehicleId]] });
  return found[0];
}

// ---- Route 卡片的 Draft ----
const STOP_KIND_KEYS = Object.freeze(STOP_KINDS.map(entry => entry.kind));
const OTHER_KINDS = Object.freeze(STOP_KIND_KEYS.filter(kind => kind !== 'shop'));
// 「幾點出發」：VALID_TIMES 可以儲存（前後空白、全形數字與冒號都可以），INVALID_TIMES 被拒絕（需求 5.10）。
const VALID_TIMES = Object.freeze(['', '08:30', ' 12:00 ', '０９：１５', '23:59']);
const INVALID_TIMES = Object.freeze(['8:3', '24:00', '12:60', '中午', '08:00:00']);
// 101 字的備註只在任務類型不是採買時被拒絕；採買 Stop 不保存備註（需求 6.4、6.13）。
const LONG_NOTE = '字'.repeat(101);
const NOTES = Object.freeze(['', '記得帶袋子', '  前後空白  ', '字'.repeat(100), LONG_NOTE]);
const PADS = Object.freeze(['', ' ', '\u3000', '\n']);

/** 已儲存的地點引用值：每個 Place 的識別碼，旅行目的地不是空白時另有 '@destination'。 */
const savedRefs = state => [...(state.places ?? []).map(place => place.id), ...(isBlank(state.trip.destination) ? [] : [DESTINATION_REF])];
/** 各車在最早一天有採買 Stop 的路線（First_Shopping_Stop 所在的路線，D28），依 state.vehicles 的順序；只用來挑選輸入。 */
function firstShoppingRoutes(state) {
  const routes = state.routes ?? [];
  return state.vehicles.flatMap(vehicle => {
    const route = routes.filter(item => item.vehicleId === vehicle.id && (item.stops ?? []).some(stop => stop.kind === 'shop'))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
    return route ? [route] : [];
  });
}
/** Draft 的日期中沒有其他路線的車（Draft 自己已儲存的路線不算）。 */
function freeCars(state, draft) {
  const busy = new Set((state.routes ?? []).filter(route => route.date === draft.date && route.id !== draft.routeId).map(route => route.vehicleId));
  return state.vehicles.filter(vehicle => !busy.has(vehicle.id));
}

function draftTools(g, state, draft) {
  let keys = 0;
  const tools = {
    /** 可以選取的已儲存地點；與 Draft 新地點相同的引用值代表新地點（設計「Route Draft 的形狀」），所以不選。 */
    refs: () => savedRefs(state).filter(ref => !draft.newPlaces.some(entry => entry.ref === ref)),
    /**
     * 以「＋新增地點」加入 Draft 的新地點，回傳它的引用值；名稱前後可能有空白（儲存時去除）。invalid 為 true 時兩成的名稱
     * 不符合需求 2.1（空白、超過 50 字，或與地點、旅行目的地、前一個新地點同名），儲存時被拒絕。
     */
    newPlace(invalid = false) {
      const k = 1 + Math.max(0, ...draft.newPlaces.map(entry => Number(entry.ref.slice('new:'.length)) || 0));
      const bad = [
        '', '  ', 'x'.repeat(51), ...(state.places ?? []).slice(0, 1).map(place => place.name),
        ...(isBlank(state.trip.destination) ? [] : [state.trip.destination]), ...draft.newPlaces.slice(-1).map(entry => entry.name)
      ];
      const name = invalid && chance(g, 20) ? pick(g, bad) : `${pick(g, PADS)}新地點〔${k}〕${pick(g, PADS)}`;
      draft.newPlaces.push({ ref: `new:${k}`, name });
      return `new:${k}`;
    },
    /** 地點下拉選單的選擇：多半是已儲存的地點，約一成二是新地點（沒有已儲存的地點時也是），blank% 未選擇。 */
    place(blank = 0) {
      const mode = int(g, 0, 99), refs = tools.refs();
      if (mode >= 100 - blank) return '';
      if (mode >= 88 - blank || !refs.length) return tools.newPlace();
      return pick(g, refs);
    },
    key: () => `k${++keys}`,
    /** 要修改的 Stop：一半是採買 Stop（有的話），讓修改常常改變 First_Shopping_Stop。 */
    stop() {
      const shops = draft.stops.filter(stop => stop.kind === 'shop');
      return shops.length && chance(g, 50) ? pick(g, shops) : pick(g, draft.stops);
    }
  };
  return tools;
}

/** 卡片上的修改；回傳修改的名稱，沒有修改時回傳 null。 */
const EDITS = {
  // 改選「哪一台車」：選單只列出當天沒有其他路線的車（需求 5.5）；偶爾是已有路線的車（例如其他分頁剛儲存，被拒絕）或未選擇。
  car(g, state, draft) {
    const free = freeCars(state, draft), mode = int(g, 0, 99);
    const next = mode < 90 && free.length ? pick(g, free).id : mode < 97 && state.vehicles.length ? pick(g, state.vehicles).id : '';
    if (next === draft.vehicleId) return null;
    draft.vehicleId = next;
    return 'car';
  },
  // 新增途中任務：排在最後，地點未選擇、任務類型為採買、備註空白（需求 6.4），之後多半選地點，有時改任務類型；已有
  // 6 個 Stop 時多半不能新增（需求 6.2），偶爾仍加入第 7 個（被拒絕）。
  add(g, state, draft, tools) {
    if (draft.stops.length >= 6 && !chance(g, 10)) return null;
    const stop = { stopId: null, key: tools.key(), place: '', kind: 'shop', note: '' };
    draft.stops.push(stop);
    if (chance(g, 65)) stop.place = tools.place();
    if (chance(g, 25)) stop.kind = pick(g, OTHER_KINDS);
    return 'add';
  },
  // 新增途中任務後連按幾次「上移」：還沒選地點的採買 Stop 排到前面，常成為 First_Shopping_Stop；之後一半選地點。
  insert(g, state, draft, tools) {
    if (draft.stops.length >= 6) return null;
    const stop = { stopId: null, key: tools.key(), place: '', kind: 'shop', note: '' };
    draft.stops.splice(int(g, 0, draft.stops.length), 0, stop);
    if (chance(g, 50)) stop.place = tools.place();
    return 'insert';
  },
  remove(g, state, draft, tools) {
    if (!draft.stops.length) return null;
    draft.stops.splice(draft.stops.indexOf(tools.stop()), 1);
    return 'remove';
  },
  // 不再採買：移除每個採買 Stop，或把它改成其他任務類型（例如改由另一天採買）。
  unshop(g, state, draft) {
    if (!draft.stops.some(stop => stop.kind === 'shop')) return null;
    const remove = chance(g, 50);
    draft.stops = draft.stops.flatMap(stop => (stop.kind !== 'shop' ? [stop] : remove ? [] : [{ ...stop, kind: pick(g, OTHER_KINDS) }]));
    return 'unshop';
  },
  // 上移或下移：與相鄰的 Stop 交換位置（需求 6.5）。
  move(g, state, draft) {
    if (draft.stops.length < 2) return null;
    const i = int(g, 0, draft.stops.length - 2);
    [draft.stops[i], draft.stops[i + 1]] = [draft.stops[i + 1], draft.stops[i]];
    return 'move';
  },
  kind(g, state, draft, tools) {
    if (!draft.stops.length) return null;
    const stop = tools.stop();
    if (stop.kind === 'shop') {
      stop.kind = pick(g, OTHER_KINDS);
      return 'from-shop';
    }
    stop.kind = chance(g, 70) ? 'shop' : pick(g, OTHER_KINDS.filter(kind => kind !== stop.kind));
    return stop.kind === 'shop' ? 'to-shop' : 'kind';
  },
  place(g, state, draft, tools) {
    if (!draft.stops.length) return null;
    tools.stop().place = tools.place(25);
    return 'place';
  },
  note(g, state, draft, tools) {
    if (!draft.stops.length) return null;
    tools.stop().note = pick(g, NOTES);
    return 'note';
  },
  end(g, state, draft, tools) {
    draft[chance(g, 50) ? 'to' : 'from'] = tools.place(10);
    return 'end';
  },
  time(g, state, draft) {
    draft.time = chance(g, 20) ? pick(g, INVALID_TIMES) : pick(g, VALID_TIMES);
    return 'time';
  },
  // 以「＋新增地點」加入新地點並選取它；兩成只加入、不選取（儲存時不加入 Place_List，需求 2.11）。
  'new-place'(g, state, draft, tools) {
    const ref = tools.newPlace(true);
    const target = int(g, 0, 9);
    if (target < 4 && draft.stops.length) tools.stop().place = ref;
    else if (target < 6) draft.from = ref;
    else if (target < 8) draft.to = ref;
    return 'new-place';
  }
};
const EDIT_CHOICES = Object.freeze([
  'add', 'kind', 'move', 'remove', 'car', 'insert', 'unshop', 'place', 'add', 'kind', 'end', 'time', 'note', 'new-place', 'unshop', 'move', 'car'
]);

/**
 * 使用者儲存前補齊卡片：選車、選起點與終點、清除無效的時間與過長的備註，起點與終點相同又沒有 Stop 時改選終點；stops 為
 * true 時也為沒有選地點的 Stop 選地點，否則保留它們（使用者還在選停靠點，預覽以「第 {M} 個途中任務」表示）。
 */
function finish(g, state, draft, tools, { stops }) {
  if (!draft.vehicleId) {
    const free = freeCars(state, draft);
    if (free.length) draft.vehicleId = pick(g, free).id;
  }
  if (!draft.from) draft.from = tools.place();
  if (!draft.to) draft.to = tools.place();
  for (const stop of draft.stops) {
    if (stops && !stop.place) stop.place = tools.place();
    if (stop.note === LONG_NOTE) stop.note = '';
  }
  if (INVALID_TIMES.includes(draft.time)) draft.time = '';
  if (draft.from === draft.to && !draft.stops.length) draft.to = tools.refs().find(ref => ref !== draft.from) ?? tools.newPlace();
}

/** state 的一張 Route 卡片的 Draft：{ draft, base, edits }（base 是起點的種類，edits 是做過的修改）。 */
function makeDraft(g, state) {
  const dates = dateRange(state.trip.startDate, state.trip.endDate);
  const routes = state.routes ?? [];
  // 「＋新增路線」只在當天還有車沒有路線時可用（需求 5.7），「轉成路線」只給在 First_Day 沒有路線的車（需求 19.11）。
  // 偶爾（以及這些都不可用時）仍建立新路線 Draft；沒有空車時「哪一台車」未選擇，儲存時被拒絕。
  const open = dates.filter(date => freeCars(state, { date, routeId: null }).length);
  const firstFree = freeCars(state, { date: dates[0], routeId: null });
  const bases = [...(routes.length ? ['route', 'route', 'route'] : []), ...(open.length ? ['new', 'new'] : []), ...(firstFree.length ? ['legacy'] : [])];
  const base = bases.length && chance(g, 95) ? pick(g, bases) : 'new';
  let draft;
  if (base === 'route') {
    // 一半是含某台車 First_Shopping_Stop 的路線，修改後常把品項移到其他 Stop、其他天或未分配採買清單
    const firsts = firstShoppingRoutes(state);
    draft = routeDraft(state, pick(g, firsts.length && chance(g, 50) ? firsts : routes).id);
  } else if (base === 'new') draft = newRouteDraft(state, pick(g, open.length ? open : dates));
  else {
    // 多半是有舊出發資料的車
    const legacy = firstFree.filter(vehicle => !isBlank(vehicle.meeting));
    draft = legacyRouteDraft(state, pick(g, legacy.length && chance(g, 80) ? legacy : firstFree).id);
  }
  const tools = draftTools(g, state, draft);
  const edits = new Set();
  for (let n = int(g, 0, 8); n > 0; n--) {
    const name = EDITS[pick(g, EDIT_CHOICES)](g, state, draft, tools);
    if (name) edits.add(name);
  }
  // 六成補齊整張卡片；兩成補齊 Stop 以外的欄位，並在任意位置多一個還沒選地點的採買 Stop（使用者還在選停靠點）；其餘保留
  // 未完成的欄位。
  const mode = int(g, 0, 99);
  if (mode >= 40) finish(g, state, draft, tools, { stops: true });
  else if (mode >= 20) {
    if (draft.stops.length < 6) draft.stops.splice(int(g, 0, draft.stops.length), 0, { stopId: null, key: tools.key(), place: '', kind: 'shop', note: '' });
    finish(g, state, draft, tools, { stops: false });
  }
  return { draft, base, edits };
}

// ---- 被拒絕的 Draft ----

/** saveRoute() 拒絕的原因。 */
function rejection(result) {
  const kinds = new Set();
  for (const { field, message } of result.errors) {
    if (field === 'vehicle' || field === 'time') kinds.add(field);
    else if (message === EDIT_MESSAGES.sameEnds) kinds.add('same-ends');
    else if ([EDIT_MESSAGES.from, EDIT_MESSAGES.to, EDIT_MESSAGES.stopPlace].includes(message)) kinds.add('no-place');
    else if (field.endsWith('-note')) kinds.add('note');
    else if (field.endsWith('-kind')) kinds.add('kind');
    else kinds.add('place-name');
  }
  const formErrors = result.formError ? result.formError.split('；') : [];
  for (const [kind, message] of [['stop-limit', EDIT_MESSAGES.stopLimit], ['place-limit', EDIT_MESSAGES.placeLimit], ['invalid-state', EDIT_MESSAGES.invalidState]]) {
    if (formErrors.includes(message)) kinds.add(kind);
  }
  return kinds;
}

/**
 * 只因為不影響採買推導的欄位被拒絕的 Draft：在副本中為沒有選地點的起點、終點與 Stop 選一個已儲存的地點（沒有可選的地點時，
 * 改為加入 Draft 的新地點「補上的地點〔n〕」），清除無效的出發時間與過長的備註，起點與終點相同又沒有 Stop 時改選終點。
 * 回傳 { draft, blank }，blank 是原本沒有選地點的 Stop 位置；有其他原因（車輛、Stop 數量、任務類型、新地點的名稱或地點
 * 數量）時回傳 null。
 */
function complete(state, draft, result) {
  if (result.formError) return null;
  const next = structuredClone(draft);
  const refs = savedRefs(state).filter(ref => !next.newPlaces.some(entry => entry.ref === ref));
  const fills = [];
  /** 不等於 avoid 的地點引用值。 */
  const fill = avoid => {
    const ref = [...refs, ...fills].find(item => item !== avoid);
    if (ref) return ref;
    const added = `new:fill-${fills.length + 1}`;
    next.newPlaces.push({ ref: added, name: `補上的地點〔${fills.length + 1}〕` });
    fills.push(added);
    return added;
  };
  const blank = new Set();
  for (const { field, message } of result.errors) {
    const index = next.stops.findIndex(stop => field === `stop-${stop.key}-place` || field === `stop-${stop.key}-note`);
    const stop = next.stops[index];
    if (field === 'time') next.time = '';
    else if (field === 'from' && message === EDIT_MESSAGES.from && next.from === '') next.from = fill(next.to);
    else if (field === 'to' && ((message === EDIT_MESSAGES.to && next.to === '') || message === EDIT_MESSAGES.sameEnds)) next.to = fill(next.from);
    else if (stop && field === `stop-${stop.key}-place` && message === EDIT_MESSAGES.stopPlace && stop.place === '') {
      stop.place = fill();
      blank.add(index);
    } else if (stop && field === `stop-${stop.key}-note`) stop.note = '';
    else return null;
  }
  return { draft: next, blank };
}

// ---- 屬性 ----

/** 比較預覽與儲存後的結果（blank 見 complete()），回傳這一組的情況。 */
function compare({ state, draft, preview, saved, blank }) {
  const previewRoute = draftRouteOf(preview, state, draft), savedRoute = draftRouteOf(saved, state, draft);
  // Draft 中第 i 個 Stop 對應兩邊的第 i 個 Stop
  const kinds = draft.stops.map(stop => stop.kind);
  expect({ preview: previewRoute.stops.map(stop => stop.kind), saved: savedRoute.stops.map(stop => stop.kind) })
    .toEqual({ preview: kinds, saved: kinds });
  const previewPlan = shoppingPlan(preview), savedPlan = shoppingPlan(saved);
  const previewLabel = labeler(preview, previewRoute), savedLabel = labeler(saved, savedRoute, blank);
  const views = stopPreviews(preview, previewPlan, previewRoute, draft.vehicleId, previewLabel);
  expect({ stops: views }).toEqual({ stops: stopPreviews(saved, savedPlan, savedRoute, draft.vehicleId, savedLabel) });
  const locations = blank.size === 0;
  expect(planView(previewPlan, previewRoute, previewLabel, locations)).toEqual(planView(savedPlan, savedRoute, savedLabel, locations));
  return outcomeTags({ state, draft, views, savedPlan, savedRoute, blank });
}

/** 涵蓋範圍：這一組比較中出現的情況。 */
function outcomeTags({ state, draft, views, savedPlan, savedRoute, blank }) {
  const tags = [];
  const shops = views.filter(view => view.kind === 'shop');
  const first = shops.find(view => view.first);
  if (first) {
    tags.push('first-in-draft');
    if (first.items.length) tags.push('first-with-items');
    if (first.index > 0) tags.push('first-not-leading');
    if (first.items.some(item => item.done)) tags.push('bought');
    if (first.summary !== first.items.map(item => item.name).join('、')) tags.push('summary-cleaned');
    if (first.nobody) tags.push('nobody');
    if (first.elsewhere.length) tags.push('d29');
    if (blank.has(first.index)) tags.push(first.items.length ? 'blank-first-with-items' : 'blank-first');
  }
  if (shops.some(view => !view.first && view.listedAt)) {
    tags.push(first ? 'listed-in-same-route' : 'listed-on-other-day');
    if (first && blank.has(first.index)) tags.push('listed-at-blank');
  }
  const chosen = new Set([draft.from, draft.to, ...draft.stops.map(stop => stop.place)]);
  const newRefs = draft.newPlaces.map(entry => entry.ref).filter(ref => chosen.has(ref));
  if (newRefs.length) tags.push('new-place-chosen');
  if (draft.stops.some(stop => newRefs.includes(stop.place))) tags.push('new-place-stop');

  // 與儲存前相比：First_Shopping_Stop 與品項的位置改變
  const before = shoppingPlan(state);
  const original = draft.routeId ? state.routes.find(route => route.id === draft.routeId) : null;
  if (original && original.vehicleId !== draft.vehicleId) tags.push('car-changed');
  const where = (plan, route, vehicleId) => {
    const entry = plan.firstStop.get(vehicleId);
    return !entry ? 'none' : entry.route === route ? 'draft' : 'other';
  };
  for (const vehicle of state.vehicles) {
    const was = where(before, original, vehicle.id), is = where(savedPlan, savedRoute, vehicle.id);
    if (was !== 'draft' && is === 'draft') tags.push(was === 'none' ? 'first-created' : 'first-taken-from-other-day');
    if (was === 'draft' && is !== 'draft') tags.push(is === 'none' ? 'first-removed' : 'first-moved-to-other-day');
    if (was === 'draft' && is === 'draft' && before.firstStop.get(vehicle.id).stop.id !== savedPlan.firstStop.get(vehicle.id).stop.id) {
      tags.push('first-moved-within-route');
    }
  }
  const itemPlaces = plan => {
    const out = new Map(plan.unassigned.map(({ item, code }) => [item.id, code]));
    for (const { stop } of plan.firstStop.values()) for (const item of plan.stopItems.get(stop.id) ?? []) out.set(item.id, `stop ${stop.id}`);
    return out;
  };
  const was = itemPlaces(before), is = itemPlaces(savedPlan);
  const atStop = place => place.startsWith('stop ');
  for (const [id, place] of was) {
    const now = is.get(id);
    if (now === place) continue;
    tags.push(atStop(place) && atStop(now) ? 'item-between-stops' : atStop(place) ? 'item-to-unassigned' : atStop(now) ? 'item-from-unassigned' : 'item-reason-changed');
  }

  // 既有的識別碼與預覽優先使用的識別碼相同
  const stopIds = new Set((state.routes ?? []).flatMap(route => (route.stops ?? []).map(stop => stop.id)));
  const own = new Set((original?.stops ?? []).map(stop => stop.id));
  if (!draft.routeId && (state.routes ?? []).some(route => route.id === 'new:route')) tags.push('collision:route');
  draft.stops.forEach((stop, i) => {
    const id = `new:stop:${i + 1}`;
    if (own.has(stop.stopId) || !stopIds.has(id)) return;
    tags.push('collision:stop');
    if ([...savedPlan.firstStop.values()].some(entry => entry.stop.id === id)) {
      tags.push(views[i].first ? 'collision:both-first' : 'collision:first-stop');
    }
  });
  const placeIds = new Set((state.places ?? []).map(place => place.id));
  if (newRefs.some(ref => placeIds.has(ref))) tags.push('collision:place');
  return tags;
}

/** 檢查一組 state 與 Draft，回傳這一組的情況（涵蓋範圍與統計用）。 */
function checkDraft(state, { draft, base, edits }) {
  const tags = new Set([`base:${base}`, ...[...edits].map(name => `edit:${name}`)]);
  const stateBefore = structuredClone(state), draftBefore = structuredClone(draft);
  const preview = previewState(state, draft);
  // 同一組輸入與它的深拷貝得到相同的預覽
  expect(previewState(structuredClone(state), structuredClone(draft))).toStrictEqual(preview);
  const result = saveRoute(state, draft, { uid: counter('saved') });
  const add = list => list.forEach(tag => tags.add(tag));
  if (result.ok) {
    tags.add('saved');
    add(compare({ state, draft, preview, saved: result.state, blank: new Set() }));
  } else {
    tags.add('rejected');
    add([...rejection(result)].map(kind => `rejected:${kind}`));
    const fixed = complete(state, draft, result);
    const done = fixed && saveRoute(state, fixed.draft, { uid: counter('saved') });
    if (done?.ok) {
      tags.add('completed');
      add(compare({ state, draft, preview, saved: done.state, blank: fixed.blank }));
    } else tags.add(fixed ? 'completed-rejected' : 'preview-only');
  }
  // previewState()、saveRoute() 與推導都不改變 state 與 Draft
  expect(state).toStrictEqual(stateBefore);
  expect(draft).toStrictEqual(draftBefore);
  return tags;
}

/** 設定 ITINERARY_PREVIEW_STATS 時印出各情況的次數。 */
function report(title, seen) {
  if (!process.env.ITINERARY_PREVIEW_STATS) return;
  const lines = [...seen].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, n]) => `  ${tag}: ${n}`);
  console.log(`Property 10 ${title}\n${lines.join('\n')}`);
}

/** 以 numRuns 組 state 與 Draft 檢查屬性，回傳各情況出現的次數。generated 為 true 時 state 必須通過驗證（本檔的產生器）。 */
function runProperty(title, arbitrary, numRuns, { generated = false } = {}) {
  const seen = new Map();
  fc.assert(fc.property(arbitrary, fc.gen(), (state, g) => {
    if (generated) expect(isValidState(state)).toBe(true);
    else fc.pre(isValidState(state));
    for (const tag of checkDraft(state, makeDraft(g, state))) seen.set(tag, (seen.get(tag) ?? 0) + 1);
  }), bounded(numRuns));
  report(title, seen);
  return seen;
}

// ---- 採買用的 Trip_State ----
const SHOP_DATES = Object.freeze(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
const SHOP_PEOPLE = Object.freeze(['小安', '阿哲', '小雨', '阿森', '米米', '大海']);
const SHOP_CARS = Object.freeze(['第一車', '第二車', '第三車・採買組', '第四車']);
const SHOP_PLACES = Object.freeze([['pl-a', '出發地點 A'], ['pl-shop', '超市／賣場'], ['pl-hw', '五金行'], ['pl-tp', '台北'], ['pl-camp', '營位']]);
// 「高麗菜」與「 高麗菜 」處理後相同、空白的名稱不列出，所以 Shopping_Summary 的名稱可能少於品項數（需求 6.9）。
const SHOP_ITEMS = Object.freeze(['五花肉片', '鮮蝦', '高麗菜', ' 高麗菜 ', '運動飲料', '', '冰塊', 'A&B']);

/**
 * 1 到 4 天、6 位旅伴、1 到 4 台車（駕駛兩成待分配，0 到 3 位乘客，同一位旅伴常在多台車上，D29）、1 到 5 個地點；每台車
 * 每天六成有路線，每條 0 到 4 個 Stop，一半是採買；1 到 10 個品項，七成由車上的旅伴負責，其他由不在車上的旅伴負責或待分配，
 * 兩成五已買齊；旅行目的地兩成空白；三成的日子把 Day_Location 設為一個 Place（新路線的預設終點，需求 5.6）。
 */
function buildShoppingTrip(g) {
  const dates = SHOP_DATES.slice(0, int(g, 1, SHOP_DATES.length));
  const destination = chance(g, 20) ? '' : '夕淞度日營區';
  const people = SHOP_PEOPLE.map((name, i) => ({ id: `p${i + 1}`, name, color: COLORS[i % COLORS.length], role: '' }));
  const ids = people.map(person => person.id);
  const vehicles = range(int(g, 1, SHOP_CARS.length)).map(i => {
    const driver = chance(g, 20) ? '' : pick(g, ids);
    const passengers = shuffle(g, ids.filter(id => id !== driver)).slice(0, int(g, 0, 3));
    return { id: `v${i + 1}`, name: SHOP_CARS[i], driver, seats: 4, passengers, meeting: chance(g, 30) ? '08:00 · 台北車站' : '' };
  });
  const places = SHOP_PLACES.slice(0, int(g, 1, SHOP_PLACES.length)).map(([id, name]) => ({ id, name }));
  const refs = [...places.map(place => place.id), ...(destination ? [DESTINATION_REF] : [])];
  let serial = 0;
  const routes = [];
  for (const date of dates) {
    for (const vehicle of vehicles) {
      if (!chance(g, 60)) continue;
      const route = { id: `rt-${date}-${vehicle.id}`, date, vehicleId: vehicle.id, from: pick(g, refs), to: pick(g, refs), time: pick(g, ['', '08:00', '09:30']) };
      route.stops = range(int(g, 0, 4)).map(() => ({ id: `st${++serial}`, place: pick(g, refs), kind: chance(g, 50) ? 'shop' : pick(g, OTHER_KINDS) }));
      routes.push(route);
    }
  }
  const onCar = [...new Set(vehicles.flatMap(vehicle => [vehicle.driver, ...vehicle.passengers]).filter(Boolean))];
  const offCar = ids.filter(id => !onCar.includes(id));
  const shopping = range(int(g, 1, 10)).map(i => {
    const mode = int(g, 0, 9);
    const assignee = mode < 7 && onCar.length ? pick(g, onCar) : mode < 9 && offCar.length ? pick(g, offCar) : '';
    return { id: `s${i + 1}`, name: pick(g, SHOP_ITEMS), quantity: '1 份', category: pick(g, SHOPPING_CATEGORIES), assignee, done: chance(g, 25), source: 'manual' };
  });
  const daySettings = dates.flatMap(date => (chance(g, 30) ? [{ date, place: pick(g, places).id }] : []));
  return {
    schema: 1, revision: 0, currentUser: 'p1', joined: true,
    trip: { title: '採買小旅行', destination, startDate: dates[0], endDate: dates.at(-1), description: '', note: '' },
    people, activities: [], meals: [], shopping, gear: [], vehicles, events: [], departed: [],
    places, routes: shuffle(g, routes), daySettings
  };
}

/**
 * 把一部分既有的識別碼改成 previewState() 優先使用的識別碼：一條路線改為 'new:route'；最多 6 個 Stop 依序改為 'new:stop:1'
 * 至 'new:stop:6'，先是各車的 First_Shopping_Stop（最早一天的路線中第一個採買 Stop），再來是其他採買 Stop 與其他 Stop；
 * 最多 2 個地點改為 'new:1'、'new:2'（同時改掉路線、Stop 與每日設定中的引用值）。
 */
function withPreviewIds(g, source) {
  const state = structuredClone(source);
  const routes = state.routes ?? [];
  if (routes.length && chance(g, 70)) pick(g, routes).id = 'new:route';
  const firsts = new Set(firstShoppingRoutes(state).map(route => route.stops.find(stop => stop.kind === 'shop')));
  const stops = shuffle(g, routes.flatMap(route => route.stops ?? []));
  const rank = stop => (firsts.has(stop) ? 0 : stop.kind === 'shop' ? 1 : 2);
  [0, 1, 2].flatMap(level => stops.filter(stop => rank(stop) === level))
    .slice(0, 6).forEach((stop, i) => { stop.id = `new:stop:${i + 1}`; });
  const renamed = new Map(shuffle(g, state.places ?? []).slice(0, int(g, 1, 2)).map((place, i) => [place.id, `new:${i + 1}`]));
  const swap = ref => renamed.get(ref) ?? ref;
  for (const place of state.places ?? []) place.id = swap(place.id);
  for (const route of routes) {
    route.from = swap(route.from);
    route.to = swap(route.to);
    for (const stop of route.stops ?? []) stop.place = swap(stop.place);
  }
  for (const setting of state.daySettings ?? []) if (setting.place) setting.place = swap(setting.place);
  return state;
}
const shoppingTrip = () => fc.gen().map(g => {
  const state = buildShoppingTrip(g);
  return chance(g, 40) ? withPreviewIds(g, state) : state;
});

// ---- 範例（確認本檔組成的預覽） ----
/** state 套用 draft 後，Draft 路線每個 Stop 的預覽。 */
function previewOf(state, draft) {
  const preview = previewState(state, draft);
  const route = draftRouteOf(preview, state, draft);
  return stopPreviews(preview, shoppingPlan(preview), route, draft.vehicleId, labeler(preview, route));
}
/** draft 儲存後的對應結果；blank 見 complete()。 */
function savedOf(state, draft, blank = new Set()) {
  const result = saveRoute(state, draft, { uid: counter('saved') });
  expect(result).toMatchObject({ ok: true });
  const route = draftRouteOf(result.state, state, draft);
  return stopPreviews(result.state, shoppingPlan(result.state), route, draft.vehicleId, labeler(result.state, route, blank));
}
const shopStop = (key, place) => ({ stopId: null, key, place, kind: 'shop', note: '' });

describe('Property 10: 品項預覽與儲存後的結果相同', () => {
  test('本檔組成的預覽符合需求 6.6、9.5 與 D29 的範例（Example_Trip）', () => {
    const state = exampleTrip();
    const names = ['五花肉片', '鮮蝦', '高麗菜', '運動飲料', '洋芋片', '瓦斯', '衛生紙', '免洗餐具'];
    const items = names.map((name, i) => ({ id: `s${i + 1}`, name, done: false }));
    const summary = names.join('、');
    const listing = { first: true, items, summary, nobody: false, elsewhere: [] };

    // 需求 6.6：第 1 天第三車・採買組在超市／賣場的預覽依序列出八個品項
    const day1 = routeDraft(state, 'rt-1-v3');
    expect(previewOf(state, day1)).toEqual([{ index: 0, kind: 'shop', place: '超市／賣場', ...listing }]);
    expect(savedOf(state, day1)).toEqual(previewOf(state, day1));

    // 新增一個還沒選地點的採買 Stop 並上移到最前面：它成為 First_Shopping_Stop，以「第 1 個途中任務」代替地點；超市／賣場
    // 改為說明品項列在第 1 天的第 1 個途中任務。選了地點並儲存後，同一個位置有相同的品項
    const blankFirst = routeDraft(state, 'rt-1-v3');
    blankFirst.stops.unshift(shopStop('k1', ''));
    const views = previewOf(state, blankFirst);
    expect(views).toEqual([
      { index: 0, kind: 'shop', place: '第 1 個途中任務', ...listing },
      { index: 1, kind: 'shop', place: '超市／賣場', first: false, listedAt: { n: 1, place: '第 1 個途中任務' } }
    ]);
    const chosen = structuredClone(blankFirst);
    chosen.stops[0].place = 'pl-a';
    expect(savedOf(state, chosen, new Set([0]))).toEqual(views);

    // 需求 9.5 的範例：第 3 天第三車・採買組的路線加上超市／賣場的採買 Stop 時，品項列在第 1 天的超市／賣場；第四車加上
    // 同樣的 Stop 時，第四車的駕駛與乘客都沒有負責買的品項
    const day3 = routeDraft(state, 'rt-3-v3');
    day3.stops.push(shopStop('k1', 'pl-shop'));
    expect(previewOf(state, day3)).toEqual([{ index: 0, kind: 'shop', place: '超市／賣場', first: false, listedAt: { n: 1, place: '超市／賣場' } }]);
    expect(savedOf(state, day3)).toEqual(previewOf(state, day3));
    const fourth = routeDraft(state, 'rt-3-v4');
    fourth.stops.push(shopStop('k1', 'pl-shop'));
    expect(previewOf(state, fourth)).toEqual([{ index: 0, kind: 'shop', place: '超市／賣場', first: true, items: [], summary: '', nobody: true, elsewhere: [] }]);

    // D29：小雨也是第一車的乘客時，她負責的三個品項算在排在前面的第一車，第三車・採買組的預覽說明這件事
    const shared = exampleTrip();
    shared.vehicles[0].passengers.push('p3');
    expect(isValidState(shared)).toBe(true);
    expect(previewOf(shared, routeDraft(shared, 'rt-1-v3'))).toEqual([{
      index: 0, kind: 'shop', place: '超市／賣場', first: true, items: items.slice(3), summary: names.slice(3).join('、'),
      nobody: false, elsewhere: [['小雨', '第一車']]
    }]);
  });

  // 各測試的組數依實測的比例決定（每種產生器 1,000 到 3,000 組）：以實測比例的 95% 信賴區間下限計算，列出的情況在該測試的
  // 組數中都沒出現的機率低於百萬分之一；儲存成功的組數低於門檻的機率也低於百萬分之一。
  test('shoppingTrip()：預覽與儲存後的品項與說明相同，含與預覽識別碼相同的既有識別碼', () => {
    // 800 組，約 1 秒。最少見的是 First_Shopping_Stop 從 Draft 的路線移到另一天（每組約 2.7%）；約六成的 Draft 直接儲存，
    // 三成補上不影響採買的欄位後儲存
    const seen = runProperty('shoppingTrip()', shoppingTrip(), 800, { generated: true });
    expect(missing(seen, [
      'base:route', 'base:new', 'base:legacy', 'saved', 'completed', 'preview-only',
      'first-in-draft', 'first-with-items', 'first-not-leading', 'bought', 'summary-cleaned', 'nobody', 'd29',
      'listed-in-same-route', 'listed-on-other-day', 'blank-first', 'blank-first-with-items', 'listed-at-blank', 'new-place-stop',
      'car-changed', 'first-created', 'first-taken-from-other-day', 'first-removed', 'first-moved-to-other-day', 'first-moved-within-route',
      'item-between-stops', 'item-to-unassigned', 'item-from-unassigned',
      'collision:route', 'collision:stop', 'collision:first-stop', 'collision:both-first', 'collision:place'
    ])).toEqual([]);
    expect(seen.get('saved')).toBeGreaterThanOrEqual(400);
  }, TIMEOUT);

  test('itineraryState()：預覽與儲存後的品項與說明相同', () => {
    // 400 組，約 2 秒。最少見的是 First_Shopping_Stop 有品項（每組約 4.9%）；約四成四直接儲存，兩成二補上欄位後儲存，其餘
    // 多半是沒有車或當天每台車都已有路線
    const seen = runProperty('itineraryState()', itineraryState(), 400);
    expect(missing(seen, [
      'base:route', 'base:new', 'base:legacy', 'saved', 'completed', 'preview-only', 'first-in-draft', 'first-with-items',
      'first-not-leading', 'nobody', 'listed-in-same-route', 'listed-on-other-day', 'blank-first', 'new-place-stop', 'first-created'
    ])).toEqual([]);
    expect(seen.get('saved')).toBeGreaterThanOrEqual(120);
  }, TIMEOUT);

  test('legacyState()：本功能之前的 Trip_State（沒有 routes 與 places 鍵）', () => {
    // 200 組。最少見的是 First_Shopping_Stop 有品項（每組約 11%）；約四成二直接儲存，三成六補上欄位後儲存
    const seen = runProperty('legacyState()', legacyState(), 200);
    expect(missing(seen, [
      'base:new', 'base:legacy', 'saved', 'completed', 'preview-only', 'first-in-draft', 'first-created', 'first-with-items',
      'item-from-unassigned', 'nobody', 'new-place-stop'
    ])).toEqual([]);
    expect(seen.get('saved')).toBeGreaterThanOrEqual(45);
  }, TIMEOUT);
});
