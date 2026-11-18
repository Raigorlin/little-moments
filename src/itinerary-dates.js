// Trip date changes (requirement 20). Pure functions: no DOM, and the input Trip_State is never modified.
// retimeByDayIndex() is for Trip_Settings_Dialog; shiftByOffset() is for the server's trip card and import.
import { dateRange } from './model.js';
import { monthDay, trimWhite } from './itinerary-model.js';

const DAY = 86400000;
const asList = value => (Array.isArray(value) ? value : []);

/** Labels of shiftByOffset().categories, in reporting order (requirement 20.4). */
export const SHIFT_CATEGORIES = Object.freeze(['活動', '餐點', '路線', '每日設定']);

// Day_Settings that must not be dropped without asking: a Day_Title that is not blank (a blank title is unset,
// requirement 4.10) or a Day_Location set to a Place. An entry with only Arrival_Time, or nothing, may be dropped.
const hasTitleOrPlace = setting => (typeof setting.title === 'string' && trimWhite(setting.title) !== '')
  || (typeof setting.place === 'string' && setting.place !== '');

// 'YYYY-MM-DD' plus whole days in UTC, the rule server/accounts.js used; a date that cannot be shifted stays as it is.
function addDays(date, days) {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY);
  return Number.isNaN(shifted.getTime()) ? date : shifted.toISOString().slice(0, 10);
}

/**
 * Trip_Settings_Dialog date change (requirements 20.1, 20.2, 20.5–20.7). Every Route and Day_Settings entry stays on
 * its day N (the new start date + N − 1 days). Activities and meals follow the dialog's existing rule: day N stays
 * day N, a larger N becomes the new Last_Day, and a date outside the old range becomes day 1.
 * A removed day (old day N with N > the new day count) blocks the change when it has a Route, a Day_Title that is not
 * blank or a Day_Location set to a Place; its other Day_Settings (only Arrival_Time, or nothing) are dropped.
 * On success the copy also gets the new trip.startDate and trip.endDate. Identifiers, vehicles, route ends, times,
 * stops, Day_Settings values, `meeting` and shopping items do not change, and `state` itself is not modified.
 * `state` is a Trip_State that passes isValidState(); startDate–endDate must give a dateRange() of 1 to 31 days,
 * otherwise this throws a RangeError (Trip_Settings_Dialog checks the dates first).
 * @returns {{ ok: true, state: object } | { ok: false, blocked: { n: number, date: string, routes: boolean, settings: boolean }[] }}
 *   `blocked` lists the removed days that block the change, in day order: day N, its original date, whether it has
 *   a Route and whether its Day_Settings has a Day_Title or Day_Location.
 */
export function retimeByDayIndex(state, startDate, endDate) {
  const dates = dateRange(startDate, endDate);
  if (!dates.length) throw new RangeError('retimeByDayIndex() needs a trip of 1 to 31 days.');
  const oldDates = dateRange(state.trip.startDate, state.trip.endDate);
  const routes = asList(state.routes), settings = asList(state.daySettings);
  const blocked = oldDates.slice(dates.length).map((date, i) => ({
    n: dates.length + i + 1,
    date,
    routes: routes.some(route => route.date === date),
    settings: settings.some(setting => setting.date === date && hasTitleOrPlace(setting))
  })).filter(day => day.routes || day.settings);
  if (blocked.length) return { ok: false, blocked };

  const dayIndex = new Map(oldDates.map((date, i) => [date, i]));
  const last = dates.length - 1;
  const next = structuredClone(state);
  for (const item of [...asList(next.activities), ...asList(next.meals)]) {
    item.date = dates[Math.min(Math.max(dayIndex.get(item.date) ?? -1, 0), last)];
  }
  // No Route is on a removed day at this point. A date outside the old range (only in invalid states) has no day N
  // and stays as it is.
  const keepDay = item => { if (dayIndex.has(item.date)) item.date = dates[dayIndex.get(item.date)]; };
  asList(next.routes).forEach(keepDay);
  if (Array.isArray(next.daySettings)) {
    // The Day_Settings left on removed days have no Day_Title and no Day_Location.
    next.daySettings = next.daySettings.filter(setting => (dayIndex.get(setting.date) ?? -1) <= last);
    next.daySettings.forEach(keepDay);
  }
  next.trip.startDate = startDate;
  next.trip.endDate = endDate;
  return { ok: true, state: next };
}

/**
 * Server date shift for PATCH /api/trips/:id and the POST /api/trips import (requirements 20.3–20.5, 20.7). Every
 * Activity, Meal, Route and Day_Settings entry moves by the new start date minus state.trip.startDate in whole days,
 * the rule applyCardToState() already used for activities and meals. A Day_Settings entry that lands outside the new
 * range is dropped when it has no Day_Title (a blank title counts as none) and no Day_Location; anything else outside
 * the range fails the shift. Only these dates change; the caller sets the trip fields, and `state` is not modified.
 * `state` is a Trip_State that passes isValidState(); a missing routes or daySettings field stays missing.
 * @returns {{ ok: true, state: object } | { ok: false, categories: string[] }}
 *   `categories` holds the SHIFT_CATEGORIES labels with an item outside the new range, in SHIFT_CATEGORIES order.
 */
export function shiftByOffset(state, startDate, endDate) {
  const range = new Set(dateRange(startDate, endDate));
  const offset = Math.round((Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${state.trip.startDate}T00:00:00Z`)) / DAY) || 0;
  const shift = date => (offset ? addDays(date, offset) : date);
  const outside = item => !range.has(shift(item.date));
  const misfit = [
    asList(state.activities).some(outside),
    asList(state.meals).some(outside),
    asList(state.routes).some(outside),
    asList(state.daySettings).some(setting => outside(setting) && hasTitleOrPlace(setting))
  ];
  const categories = SHIFT_CATEGORIES.filter((_, i) => misfit[i]);
  if (categories.length) return { ok: false, categories };

  const next = structuredClone(state);
  for (const item of [...asList(next.activities), ...asList(next.meals), ...asList(next.routes)]) item.date = shift(item.date);
  if (Array.isArray(next.daySettings)) {
    // The Day_Settings that land outside the range have no Day_Title and no Day_Location.
    next.daySettings = next.daySettings.filter(setting => !outside(setting));
    for (const setting of next.daySettings) setting.date = shift(setting.date);
  }
  return { ok: true, state: next };
}

/**
 * Trip_Settings_Dialog error for a blocked retimeByDayIndex() (requirement 20.2). Lists the days in the order given
 * (retimeByDayIndex() gives day order), each marked 路線, 每日設定 or 路線與每日設定, for example
 * 縮短天數前，請先處理：第 4 天（10/23）的路線、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。
 * Returns '' for an empty list.
 */
export function shortenBlockedMessage(blocked) {
  const days = asList(blocked).map(({ n, date, routes, settings }) =>
    `第 ${n} 天（${monthDay(date)}）的${routes && settings ? '路線與每日設定' : routes ? '路線' : '每日設定'}`);
  return days.length ? `縮短天數前，請先處理：${days.join('、')}。刪除這些路線、清除這些每日設定後，才能縮短天數。` : '';
}

/**
 * Server error for a failed shiftByOffset() (requirement 20.4), joining the categories in the order given, for
 * example 新日期範圍放不下既有的活動、路線，請先調整行程或延長日期。 Returns '' for an empty list.
 */
export function outOfRangeMessage(categories) {
  const list = asList(categories);
  return list.length ? `新日期範圍放不下既有的${list.join('、')}，請先調整行程或延長日期。` : '';
}
