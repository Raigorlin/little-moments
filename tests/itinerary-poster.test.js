// Example tests of the itinerary poster (trip-planning-workflow-enhance task 11.17; requirements 1.8, 1.9,
// 11.2 to 11.15, 13.3, 17.2, 17.3).
import { describe, expect, test } from 'bun:test';

import { dayModel } from '../src/itinerary-derive.js';
import { posterHtml, routeMapLayout } from '../src/itinerary-poster.js';
import { exampleTrip } from './fixtures/example-trip.js';

const DAY_1 = '2026-10-20', DAY_3 = '2026-10-22';
const strip = html => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
const textOf = html => strip(html).replace(/<[^>]*>/g, '');
const routeBlock = (state, date) => dayModel(state, date).blocks.find(block => block.type === 'routes');

/** The number of elements matching `selector` inside each `.route-map`, plus the late-line flags. */
async function mapStats(html) {
  const maps = [];
  const rewriter = new HTMLRewriter()
    .on('.route-map', { element() { maps.push({ roads: 0, ends: 0, late: 0 }); } })
    .on('.route-map .rm-road', { element() { maps[maps.length - 1].roads += 1; } })
    .on('.route-map .rm-end', { element() { maps[maps.length - 1].ends += 1; } })
    .on('.route-map .rm-h', { element(el) { if (/--late:1/.test(el.getAttribute('style') ?? '')) maps[maps.length - 1].late += 1; } });
  await rewriter.transform(new Response(html)).text();
  return maps;
}

// The Last_Day of the design 「路線圖的格線」: car 1 to 台北 (12:00), car 2 to 新竹 (12:00), car 3 to 台北 (12:30).
function lastDayState() {
  const state = exampleTrip();
  state.places.push({ id: 'pl-hsinchu', name: '新竹' });
  state.routes = state.routes.filter(route => route.id !== 'rt-3-v4');
  const second = state.routes.find(route => route.id === 'rt-3-v2');
  second.to = 'pl-hsinchu';
  state.routes.find(route => route.id === 'rt-3-v3').time = '12:30';
  return state;
}

describe('Example_Trip poster text', () => {
  const html = posterHtml(exampleTrip());
  const text = textOf(html);

  test('summary, day headings, badges, tones and captions', () => {
    expect(text).toContain('三天兩夜・四台車・10/20（週二）至 10/22（週四）');
    expect(html.match(/data-poster-day/g).length).toBe(3);
    expect(html.match(/<h3 id="poster-day-\d"/g).length).toBe(3);
    for (const title of ['向山裡出發', '住進慢慢的日子', '把快樂一起帶回家']) expect(text).toContain(title);
    expect(html).toContain('<span class="day-badge" aria-hidden="true">01</span>');
    expect(html).toContain('<span class="day-badge" aria-hidden="true">03</span>');
    expect(html).toContain('poster-day day-tone-0');
    expect(html).toContain('poster-day day-tone-1');
    expect(html).toContain('poster-day day-tone-2');
    expect(text).toContain('四車出發・採買・會合');
    expect(text).toContain('今天，留在夕淞度日營區');
  });

  test('route lines, shopping stop, arrival, caption and return lines', () => {
    expect(text).toContain('08:00 第一車：出發地點 A');
    expect(text).toContain('09:30 第四車：出發地點 D');
    expect(text).toContain('超市／賣場（採買：五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具）');
    expect(text).toContain('預計 12:00 抵達・四車會合');
    expect(text).toContain('第三車・採買組先採買，其他三車直達');
    expect(text).toContain('平安返回台北・不預估返抵時間');
    expect(text).toContain('路線僅為示意，非導航或即時位置；不預估返抵時間。');
    expect(html.match(/class="rm-space car-\d"/g).length).toBe(8);
  });

  test('activity and meal cards', () => {
    expect(html.match(/<li class="moment-card /g).length).toBe(15);
    expect(html.match(/data-line="activity"/g).length).toBe(10);
    expect(html.match(/data-line="meal"/g).length).toBe(5);
    for (const part of ['搭帳・營地佈置', '晚餐：烤肉派對', '星空夜聊・自由活動', '培根、炒蛋、吐司、咖啡', '晚餐：豪華火鍋', '環境清潔、裝車', '四車集合、返程']) expect(text).toContain(part);
    expect(text).toContain('四台車，三天兩夜，一整頁的小小快樂。');
  });

  test('the poster has the Motion_Toggle, motion style and Text_Panel', () => {
    expect(html).toContain('data-scene-motion-toggle');
    expect(html).toContain('data-motion-reduced-note');
    expect(html).toContain('<style>');
    expect(html).toContain('itinerary-text-panel');
    expect(html).not.toContain('id="text-panel-body"');
  });
});

describe('empty poster and canEdit', () => {
  const empty = () => {
    const state = exampleTrip();
    return { ...state, routes: [], activities: [], meals: [], vehicles: state.vehicles.map(vehicle => ({ ...vehicle, departure: undefined })) };
  };

  test('shows the empty message without day sections, and 「開始規劃」 only when canEdit', () => {
    const viewer = posterHtml(empty());
    expect(textOf(viewer)).toContain('這趟旅行還沒有行程');
    expect(viewer).not.toContain('data-poster-day');
    expect(viewer).not.toContain('開始規劃');
    expect(viewer).not.toContain('data-plan-nav');
    const editor = posterHtml(empty(), { canEdit: true });
    expect(editor).toContain('<button type="button" class="btn primary" data-plan-nav="view">開始規劃</button>');
    expect(posterHtml(exampleTrip(), { canEdit: true })).not.toContain('開始規劃');
  });
});

describe('print copy', () => {
  test('has no Motion_Toggle, <style> or Text_Panel, but keeps the cover and the days', () => {
    const html = posterHtml(exampleTrip(), { print: true });
    expect(html).not.toContain('data-scene-motion-toggle');
    expect(html).not.toContain('data-motion-reduced-note');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('itinerary-text-panel');
    expect(html).toContain('poster-print-cover');
    expect(html.match(/data-poster-day/g).length).toBe(3);
    expect(html).toContain('aria-labelledby="print-poster-title"');
  });
});

describe('route maps of the Example_Trip', () => {
  test('day 1 and day 3 each have one road, one end and no merge column', async () => {
    const state = exampleTrip();
    const maps = await mapStats(posterHtml(state));
    expect(maps).toEqual([{ roads: 1, ends: 1, late: 0 }, { roads: 1, ends: 1, late: 0 }]);
    expect(routeMapLayout(routeBlock(state, DAY_1)).cw).toBe(0);
    expect(routeMapLayout(routeBlock(state, DAY_3)).cw).toBe(0);
  });

  test('vertical branches: only 第三車・採買組 on day 1, none on day 3', () => {
    const state = exampleTrip();
    const day1 = routeMapLayout(routeBlock(state, DAY_1));
    expect(day1.lines.map(line => line.v.lane !== null)).toEqual([false, false, true, false]);
    const day3 = routeMapLayout(routeBlock(state, DAY_3));
    expect(day3.lines.every(line => line.v.lane === null)).toBe(true);
  });
});

describe('Last_Day with two destinations', () => {
  const state = lastDayState();
  const block = routeBlock(state, DAY_3);

  test('groups are 台北 (cars 1 and 3) and 新竹 (car 2)', () => {
    expect(block.ends.map(end => [end.name, end.lines])).toEqual([['台北', [0, 2]], ['新竹', [1]]]);
  });

  test('horizontal: two roads and one line that doubles back (the third car)', async () => {
    const layout = routeMapLayout(block);
    expect(layout.lines.map(line => line.h.late)).toEqual([false, false, true]);
    expect(layout.lines[2].h.target).toBe(1);
    expect(layout.cw).toBeGreaterThan(0);
    const html = posterHtml(state);
    const maps = await mapStats(html);
    expect(maps[maps.length - 1]).toEqual({ roads: 2, ends: 2, late: 1 });
    expect(textOf(html)).toContain('平安回到新竹');
  });

  test('vertical: 新竹 uses the left road, both 台北 lines have branches', () => {
    const layout = routeMapLayout(block);
    expect(layout.ends[1].v.roadFrom).toBe(2);
    expect(layout.lines[1].v.lane).toBeNull();
    expect(layout.lines[0].v.lane).not.toBeNull();
    expect(layout.lines[2].v.lane).not.toBeNull();
    expect(layout.lines[0].v.lane).toBeLessThan(layout.lines[2].v.lane);
    expect(layout.lines[0].v.lastRow).toBe(layout.ends[0].v.row);
    expect(layout.lines[2].v.lastRow).toBe(layout.ends[0].v.row);
  });
});
