// Feature: trip-planning-workflow-enhance, Property 22: 終點組的推導
// **Validates: Requirements 11.5, 11.6, 12.10, 14.12**
//
// 以 tests/support/itinerary-arb.js 的 endMixState() 產生通過驗證的 Trip_State：至少一天的同一個路線區塊有 1 到 12 條
// 路線，終點從 1 到 4 個地點中隨機選取（同一組的路線之間夾著其他組的路線、只有一條路線的組、全部同一組、各組彼此
// 相連，以及混入 First_Day 舊出發資料的 Arrival 區塊）。對每一天 dayModel() 的每個路線區塊 block，endGroups(block.lines)
// 滿足：
// (a) 區塊中每個不同的終點引用值（Route 的 to）恰有一組，每條路線行恰好屬於一組，舊出發資料不屬於任何組；同一組的
//     路線終點相同，不同組的終點不同（需求 11.5(c)、11.6：每組一條道路與一個終點插畫）。
// (b) 組依各終點在 lines 中第一次出現的順序排列，組內的索引由小到大。
// (c) block.ends 與終點組一一對應且順序相同：ref 與 lines 相同，count 是組內的路線數（需求 12.10 停在該終點旁的車子
//     圖示數），name 是終點名稱（cleanText()，與組內每條路線行的 to 相同），endKind 依需求 11.6：終點是 Day_Location 時
//     為 camp，Last_Day 的其他終點為 house，其他為 landmark。Last_Day 的 Other 區塊中 house 項目的名稱依序等於返程行的
//     終點清單，而這份清單依需求 14.12 直接由路線行算出：依路線行的順序列出不是 Day_Location 的終點，同一地點只列一次；
//     清單是空的、不是 Last_Day 或不是 Other 區塊時沒有返程行。
// (d) 對同一個 lines 與它的深拷貝各執行兩次 endGroups()，四次結果相同；深拷貝先凍結，修改輸入會丟出錯誤；執行後
//     lines 與 Trip_State 都不變。
// 預期的終點組、名稱、Day_Location 與返程行都在本檔依需求與詞彙表直接算出（終點組以「不重複的終點依第一次出現的順序
// 排列，再篩出每個終點的路線行索引」組成，不同於 endGroups() 的單次走訪），不使用 endGroups() 與 dayLocation() 的結果。
// 另外確認 endMixState() 標示的區塊（date 那一天、kind 的區塊）各行的終點依序等於 refs，所以 pattern 描述的排列確實
// 出現在被檢查的區塊中；以下特徵都至少出現一次：五種 pattern、兩種區塊、camp、house、landmark、返程行、同一區塊中的
// camp 與 house（返程行不列出 Day_Location）、舊出發資料與路線交錯的區塊、只有舊出發資料的區塊（沒有終點組）、
// 夾著其他組路線的終點組，以及多組中只有一條路線的終點組。依產生器的機率，200 組中最少見的特徵（同一區塊中的 camp
// 與 house，每組約 7%）都沒有出現的機率低於百萬分之一，各 pattern（每組至少約一成）低於十億分之一。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { dayModel, endGroups, shoppingPlan } from '../src/itinerary-derive.js';
import { DESTINATION_REF, cleanText } from '../src/itinerary-model.js';
import { dateRange, isValidState } from '../src/model.js';
import { endMixState } from './support/itinerary-arb.js';

// 200 組通常約 3 秒（每組檢查每一天的每個路線區塊）。fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，
// 而 bun test 無法中斷同步執行的測試，所以 30 秒後停止縮小並回報目前的反例；尚未跑完 200 組就到時間也算失敗
// （failOnInterrupt）。
const BOUNDED = { numRuns: 200, plugins: [fc.interruptAfterTimeLimit(30000, { failOnInterrupt: true })] };
const TIMEOUT = 60000;
const PATTERNS = ['same', 'single', 'contiguous', 'interleaved', 'random'];

// ---- 依需求直接算出的預期值 ----
const isBlank = text => String(text).replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') === '';
/** Day_Location 的引用值（詞彙表）：Day_Settings 中的 Place；未設定時為 Destination_Place，旅行目的地也空白時為 null。 */
function dayLocationRef(state, date) {
  const place = (state.daySettings ?? []).find(setting => setting.date === date)?.place;
  if (place) return place;
  return isBlank(state.trip.destination) ? null : DESTINATION_REF;
}
/** 地點引用值的顯示名稱：旅行目的地或 Place 的名稱，經 cleanText()（需求 14.16）。 */
function placeName(state, ref) {
  return cleanText(ref === DESTINATION_REF ? state.trip.destination : state.places.find(place => place.id === ref).name);
}
/** 路線行（不含舊出發資料）在 lines 中的索引。 */
const routeIndices = lines => lines.flatMap((line, index) => (line.type === 'route' ? [index] : []));
/** 終點組的參考答案：不重複的終點依第一次出現的順序排列，每組再列出終點為它的所有路線行索引（由小到大）。 */
function expectedGroups(lines) {
  const routes = routeIndices(lines);
  return [...new Set(routes.map(index => lines[index].route.to))]
    .map(ref => ({ ref, lines: routes.filter(index => lines[index].route.to === ref) }));
}
/** 返程行的終點清單（需求 14.12）：依路線行的順序列出不是 Day_Location 的終點，同一地點只列一次。 */
function returnRefs(lines, location) {
  return [...new Set(routeIndices(lines).map(index => lines[index].route.to).filter(ref => ref !== location))];
}
const ascending = list => list.every((value, i) => i === 0 || list[i - 1] < value);
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ---- 屬性 ----
/** 檢查一個路線區塊；location 是當天 Day_Location 的引用值（沒有時為 null）。回傳區塊的特徵，供涵蓋範圍的檢查。 */
function checkBlock(state, block, { location, lastDay }) {
  const { lines } = block;
  expect(lines.every(line => line.type === 'route' || line.type === 'legacy')).toBe(true);
  const before = structuredClone(lines);
  const routes = routeIndices(lines);
  const groups = endGroups(lines);

  // (a) 每條路線行恰好屬於一組，舊出發資料不屬於任何組；每組至少一條路線，同一組的終點相同，不同組的終點不同
  expect(groups.flatMap(group => group.lines).sort((a, b) => a - b)).toEqual(routes);
  expect(groups.every(group => group.lines.length > 0)).toBe(true);
  expect(groups.map(group => group.lines.map(index => lines[index].route.to)))
    .toEqual(groups.map(group => group.lines.map(() => group.ref)));
  expect(new Set(groups.map(group => group.ref)).size).toBe(groups.length);
  // (b) 組依各終點第一次出現的順序排列，組內的索引由小到大
  expect(groups.every(group => ascending(group.lines))).toBe(true);
  expect(groups.map(group => group.lines[0]))
    .toEqual(groups.map(group => lines.findIndex(line => line.type === 'route' && line.route.to === group.ref)));
  expect(ascending(groups.map(group => group.lines[0]))).toBe(true);
  // 結果恰為 [{ ref, lines }]，與參考答案相同
  const expected = expectedGroups(lines);
  expect(groups).toStrictEqual(expected);

  // (c) ends 與終點組一一對應且順序相同，名稱、路線數與終點種類（需求 11.6、12.10）
  const endKind = ref => (ref === location ? 'camp' : lastDay ? 'house' : 'landmark');
  expect(block.ends).toStrictEqual(expected.map(({ ref, lines: indices }) => ({
    ref, name: placeName(state, ref), endKind: endKind(ref), count: indices.length, lines: indices
  })));
  // 組內每條路線行的終點名稱（文字版與行程圖顯示的 to）與該組的名稱相同
  expect(block.ends.map(end => end.lines.map(index => lines[index].to)))
    .toEqual(block.ends.map(end => end.lines.map(() => end.name)));
  // 返程行（需求 14.12）只在 Last_Day 的 Other 區塊；其終點清單等於 house 項目的名稱，順序相同
  if (lastDay && block.kind === 'other') {
    const returning = returnRefs(lines, location).map(ref => placeName(state, ref));
    expect(block.ends.filter(end => end.endKind === 'house').map(end => end.name)).toEqual(returning);
    expect(block.returnLine).toBe(returning.length ? `平安返回${returning.join('、')}・不預估返抵時間` : null);
  } else {
    expect(block.returnLine).toBeNull();
  }

  // (d) 對同一個 lines 與它的（凍結的）深拷貝各執行兩次，結果相同，輸入不變
  const copy = deepFreeze(structuredClone(lines));
  for (const result of [endGroups(lines), endGroups(copy), endGroups(copy)]) expect(result).toStrictEqual(groups);
  expect(lines).toStrictEqual(before);

  const tags = [`block:${block.kind}`, ...block.ends.map(end => `end:${end.endKind}`)];
  if (block.returnLine !== null) tags.push('return line');
  // Last_Day 的區塊同時有營地與房屋：返程行不列出 Day_Location
  if (block.ends.some(end => end.endKind === 'camp') && block.ends.some(end => end.endKind === 'house')) tags.push('camp and house');
  if (routes.length < lines.length) tags.push(routes.length ? 'legacy line' : 'legacy lines only');
  if (groups.length >= 2) tags.push('several groups');
  if (groups.length >= 2 && groups.some(group => group.lines.length === 1)) tags.push('single-route group');
  // 同一組的兩條路線之間夾著其他組的路線（例如台北、新竹、台北）
  const interleaved = groups.some(group => group.lines.some((index, k) =>
    k > 0 && routes.some(other => other > group.lines[k - 1] && other < index)));
  if (interleaved) tags.push('interleaved group');
  return tags;
}
/** required 中沒有出現在 seen 的特徵。 */
const missing = (seen, required) => required.filter(tag => !seen.has(tag));

describe('Property 22: 終點組的推導', () => {
  test('每一天每個路線區塊：終點組依第一次出現的順序分組，ends 與返程行與它一致，結果只由 lines 決定', () => {
    const seen = new Set();
    fc.assert(fc.property(endMixState(), ({ state, date, kind, refs, pattern }) => {
      // Property 22 的前提：通過驗證的 Trip_State
      expect(isValidState(state)).toBe(true);
      const before = structuredClone(state);
      const plan = shoppingPlan(state);
      const dates = dateRange(state.trip.startDate, state.trip.endDate);
      dates.forEach((day, index) => {
        const model = dayModel(state, day, plan);
        expect(model?.date).toBe(day);
        const context = { location: dayLocationRef(state, day), lastDay: index === dates.length - 1 };
        for (const block of model.blocks) {
          if (block.type === 'routes') for (const tag of checkBlock(state, block, context)) seen.add(tag);
        }
        if (day === date) {
          // endMixState() 標示的區塊：各行的終點依序等於 refs（舊出發資料為 null）
          const target = model.blocks.find(block => block.type === 'routes' && block.kind === kind);
          expect(target?.lines.map(line => (line.type === 'route' ? line.route.to : null))).toEqual(refs);
        }
      });
      // dayModel() 與 endGroups() 都不修改 Trip_State
      expect(state).toStrictEqual(before);
      seen.add(`pattern:${pattern}`).add(`kind:${kind}`);
    }), BOUNDED);
    expect(missing(seen, [
      ...PATTERNS.map(pattern => `pattern:${pattern}`), 'kind:arrival', 'kind:other', 'block:arrival', 'block:other',
      'end:camp', 'end:house', 'end:landmark', 'return line', 'camp and house', 'legacy line', 'legacy lines only',
      'several groups', 'single-route group', 'interleaved group'
    ])).toEqual([]);
  }, TIMEOUT);
});
