// Itinerary_Editor markup (design 「規劃行程」). Pure functions that return HTML strings; app.js owns `planner`,
// the events and the focus. Nothing here reads the DOM, writes state or calls the network.
//
// editorHtml(state, planner, ctx)
//   ctx: { icon(name), mapLink(location, options), plan (shoppingPlan(state)), models (dayModel() of every Trip_Day:
//          a Map by date, an object by date or an array), warnings (planningWarnings() result, Map<date, string[]>),
//          canDeleteVehicle, accountSaving }
//   `models`, `warnings` and `plan` are derived here when missing, so a caller may pass only `icon`.
// Every user value goes through escape() exactly once. ids come from one counter per call (plan-1, plan-2…); only
// data-focus and data-id carry record ids. Native controls only (no data-swipe-row).
import { escape, weekday } from './model.js';
import { dayModel, placeLabel, placeRouteCounts, planningWarnings, shoppingPlan, sortedRoutes, tripDays, vehicleRouteDays } from './itinerary-derive.js';
import { ACTIVITY_CATEGORIES, DESTINATION_REF, LIMITS, STOP_KINDS, categoryLabel, cleanText, presetsFor, trimWhite } from './itinerary-model.js';
import { activityDraft, legacyRouteDraft, newActivityDraft, newRouteDraft, previewState, routeDraft } from './itinerary-edits.js';
import { SHOPPING_CATEGORIES } from './ingredients.js';

const list = value => (Array.isArray(value) ? value : []);
const rec = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Place_List size plus the new places of the open card's Draft (requirement 2.8). */
export function placeCount(state, planner) {
  return list(state?.places).length + list(planner?.card?.draft?.newPlaces).length;
}
export const placeLimitReached = (state, planner) => placeCount(state, planner) >= LIMITS.places;

function modelFor(ctx, date) {
  const { models } = ctx;
  if (models instanceof Map) return models.get(date) ?? null;
  if (Array.isArray(models)) return models.find(model => model?.date === date) ?? null;
  if (rec(models)) return models[date] ?? null;
  return null;
}

/**
 * Shared per-call helpers: the id counter, escaping, icon, disabled flag and the disclosure markup. Passed to the
 * segment helpers so that their ids continue the same sequence.
 */
function makeKit(state, planner, ctx) {
  let counter = 0;
  const kit = {
    state, planner, ctx,
    e: escape,
    icon: ctx.icon ?? (() => ''),
    saving: Boolean(ctx.accountSaving),
    id: () => `plan-${++counter}`,
    /** ' disabled' while an account save is in flight (requirement 10.6), otherwise ''. */
    off: (extra = false) => (kit.saving || extra ? ' disabled' : ''),
    /** Expand/collapse button attributes (requirement 16.4); `panelId` is only needed when expanded. */
    toggle(key, expanded, panelId, disabled = false) {
      return `data-plan-toggle="${escape(key)}" aria-expanded="${expanded ? 'true' : 'false'}"${expanded && panelId ? ` aria-controls="${panelId}"` : ''}${kit.off(disabled)}`;
    },
    /** A labelled field: returns { id, errorId, attrs, error } pieces for the caller's control. */
    field(name, label, control, { error = '', hint = '' } = {}) {
      const id = kit.id(), errorId = error ? kit.id() : '', hintId = hint ? kit.id() : '';
      const describedby = [errorId, hintId].filter(Boolean).join(' ');
      const attrs = `id="${id}" name="${escape(name)}"${error ? ' aria-invalid="true"' : ''}${describedby ? ` aria-describedby="${describedby}"` : ''}`;
      return `<div class="field"><label for="${id}">${escape(label)}</label>${control(attrs)}`
        + `${error ? `<p class="field-error" id="${errorId}">${escape(error)}</p>` : ''}`
        + `${hint ? `<p class="help" id="${hintId}">${escape(hint)}</p>` : ''}</div>`;
    }
  };
  return kit;
}

// ---- Places_And_Cars (requirements 3.1 to 3.5, 3.11, 3.12; design row 1) ----

function placeRow(kit, place, count, placeNotice) {
  const { state, planner, e } = kit;
  const key = `place:${place.id}`;
  const open = planner.card?.key === key;
  const panelId = open ? kit.id() : '';
  const name = e(place.name);
  const notice = placeNotice?.key === key ? `<p class="plan-notice" role="note">${e(placeNotice.text)}</p>` : '';
  return `<li class="plan-place" data-id="${e(place.id)}"><div class="plan-row">
    <span class="plan-row-name">${name}</span><span class="plan-row-meta">${count} 條路線</span>
    <button class="button small" type="button" ${kit.toggle(key, open, panelId)} data-focus="plan-${e(key)}" aria-label="改名 ${name}">改名</button>
    <button class="button small danger" type="button" data-action="plan-delete" data-kind="place" data-id="${e(place.id)}" aria-label="刪除 ${name}"${kit.off()}>刪除</button>
  </div>${notice}${open ? placeCardHtml(kit, panelId, place) : ''}</li>`;
}

/** The place card (new or rename): 「地點名稱」 and 「儲存」. Draft: { name }; errors: { name }. */
function placeCardHtml(kit, panelId, place) {
  const { planner, e } = kit;
  const card = planner.card, draft = card.draft ?? {};
  const value = draft.name ?? place?.name ?? '';
  return `<form class="plan-card" id="${panelId}" data-plan-card="${e(card.key)}" novalidate>
    ${card.formError ? `<p class="field-error" role="alert" tabindex="-1">${e(card.formError)}</p>` : ''}
    ${kit.field('name', '地點名稱', attrs => `<input type="text" ${attrs} value="${e(value)}" autocomplete="off" data-focus="plan-field-name">`, { error: card.errors?.name })}
    <button class="button small" type="button" data-action="plan-save"${kit.off(card.sending)}>儲存</button>
  </form>`;
}

function placesAndCarsHtml(kit) {
  const { state, planner, ctx, e, icon } = kit;
  const places = list(state.places).filter(rec), vehicles = list(state.vehicles).filter(rec);
  const open = Boolean(planner.placesOpen);
  const panelId = open ? kit.id() : '';
  const destination = cleanText(state.trip?.destination ?? '');
  const counts = placeRouteCounts(state);
  let body = '';
  if (open) {
    const dest = destination
      ? `<li class="plan-place plan-destination"><div class="plan-row"><span class="plan-row-name">${e(destination)}</span>
          <span class="plan-row-meta">${counts.get(DESTINATION_REF) ?? 0} 條路線</span>
          <button class="button small" type="button" data-action="trip-settings">在編輯旅行修改</button></div></li>`
      : `<li class="plan-place plan-destination"><div class="plan-row"><span class="plan-row-name">還沒有旅行目的地</span>
          <button class="button small" type="button" data-action="trip-settings">在編輯旅行修改</button></div></li>`;
    const full = placeLimitReached(state, planner);
    const newOpen = planner.card?.key === 'place:new';
    const newPanel = newOpen ? kit.id() : '';
    const limitId = full ? kit.id() : '';
    const rows = places.map(place => placeRow(kit, place, counts.get(place.id) ?? 0, planner.notice)).join('');
    const cars = vehicles.map(vehicle => {
      const driver = list(state.people).find(person => person?.id === vehicle.driver);
      const riders = list(vehicle.passengers).length + (driver ? 1 : 0);
      const days = vehicleRouteDays(state, vehicle.id);
      const name = e(vehicle.name);
      return `<li class="plan-car" data-id="${e(vehicle.id)}"><div class="plan-row">
        <span class="plan-row-name">${icon('car')}${name}</span>
        <span class="plan-row-meta">${driver ? e(driver.name) : '待分配'}</span>
        <span class="plan-row-meta">${riders} / ${e(vehicle.seats)} 人</span>
        <span class="plan-row-meta">${days.length ? e(days.map(n => `第 ${n} 天`).join('、')) : '還沒有路線'}</span>
        <button class="button small" type="button" data-action="vehicle" data-id="${e(vehicle.id)}" aria-label="編輯 ${name}"${kit.off()}>編輯 ${name}</button>
      </div></li>`;
    }).join('');
    body = `<div class="plan-section-body" id="${panelId}">
      <ul class="plan-list plan-places-list" aria-label="地點">${dest}${rows}</ul>
      <div class="plan-actions"><button class="button small" type="button" ${kit.toggle('place:new', newOpen, newPanel, full)} data-focus="plan-place:new"${full ? ` aria-describedby="${limitId}"` : ''}>＋新增地點</button>
        ${full ? `<span class="help" id="${limitId}">地點最多 100 個</span>` : ''}</div>
      ${newOpen ? placeCardHtml(kit, newPanel, null) : ''}
      <ul class="plan-list plan-cars-list" aria-label="車輛">${cars}</ul>
      <div class="plan-actions"><button class="button small" type="button" data-action="vehicle"${kit.off()}>新增車輛</button></div>
    </div>`;
  }
  return `<section class="plan-section plan-places">
    <h3 class="plan-section-title"><button class="plan-section-toggle" type="button" ${kit.toggle('places', open, panelId)} data-focus="plan-places">
      <span>地點與車</span><span class="plan-row-meta">${places.length} 個地點・${vehicles.length} 台車</span></button></h3>${body}
  </section>`;
}

// ---- Day buttons, summary, warnings, day settings, segments (design rows 2 to 6) ----

function dayButtons(kit, days, warnings) {
  const { planner, e } = kit;
  const buttons = days.map((day, index) => {
    const count = list(warnings.get(day.date)).length;
    const [, month, dom] = day.date.split('-').map(Number);
    return `<button class="date-tab${index === planner.dayIndex ? ' selected' : ''}" type="button" data-plan-nav="day" data-day="${index}" data-focus="plan-day-${index}" aria-pressed="${index === planner.dayIndex}"${kit.off()}>`
      + `<span>第 ${day.n} 天</span><span>${month}/${dom}</span><span>${e(weekday(day.date))}</span>`
      + `${count ? `<b class="date-tab-count">${count}</b><span class="visually-hidden"> 則提醒</span>` : ''}</button>`;
  }).join('');
  const labelId = kit.id();
  return `<div class="plan-days" role="group" aria-labelledby="${labelId}"><span class="plan-days-label" id="${labelId}">編輯哪一天</span><div class="date-tabs">${buttons}</div></div>`;
}

function summaryHtml(kit, model) {
  const { state, e } = kit;
  const routes = model.arrivalRoutes.length + model.otherRoutes.length;
  const items = list(state.activities).filter(item => item?.date === model.date).length
    + list(state.meals).filter(item => item?.date === model.date).length;
  return `<p class="plan-summary">${e(model.heading)}・${routes} 條路線 / ${items} 個活動</p>`;
}

function warningsHtml(kit, items) {
  if (!items.length) return '';
  return `<ul class="plan-warnings" aria-label="規劃提醒">${items.map(text => `<li>${kit.icon('warning')}<span>${kit.e(text)}</span></li>`).join('')}</ul>`;
}

/** Options of a place select (requirement 2.3): the unset option (if any), Destination_Place, the Place_List,
 * then the Draft's new places. */
export function placeOptions(state, selected, { unset = '', newPlaces = [] } = {}) {
  const destination = cleanText(state.trip?.destination ?? '');
  const option = (value, label) => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`;
  return [
    unset ? option('', unset) : '',
    destination ? option(DESTINATION_REF, destination) : '',
    ...list(state.places).filter(rec).map(place => option(place.id, place.name)),
    ...list(newPlaces).filter(rec).map(place => option(place.id ?? place.ref, place.name))
  ].join('');
}

/** The 「＋新增地點」 row of a card (requirement 2.5): the button, or the inline name input with 確認 and 取消.
 * card.inlinePlace: { name, error, target } when the input is open. */
export function addPlaceHtml(kit, target = '') {
  const { state, planner, e } = kit;
  const inline = planner.card?.inlinePlace;
  const full = placeLimitReached(state, planner);
  if (inline && (inline.target ?? '') === target) {
    return kit.field('inlinePlace', '地點名稱', attrs => `<input type="text" ${attrs} value="${e(inline.name ?? '')}" autocomplete="off" data-focus="plan-inline-place">`, { error: inline.error })
      + `<div class="plan-actions"><button class="button small" type="button" data-plan-op="confirm-place" data-target="${e(target)}"${kit.off()}>確認</button>`
      + `<button class="button small" type="button" data-plan-op="cancel-place" data-target="${e(target)}"${kit.off()}>取消</button></div>`;
  }
  const limitId = full ? kit.id() : '';
  return `<div class="plan-actions"><button class="button small" type="button" data-plan-op="add-place" data-target="${e(target)}" data-focus="plan-add-place-${e(target || 'day')}"${full ? ` disabled aria-describedby="${limitId}"` : kit.off()}>＋新增地點</button>`
    + `${full ? `<span class="help" id="${limitId}">地點最多 100 個</span>` : ''}</div>`;
}

function daySettingsHtml(kit, day, model) {
  const { state, planner, e } = kit;
  const open = planner.card?.key === 'day';
  const panelId = open ? kit.id() : '';
  let body = '';
  if (open) {
    const card = planner.card, draft = card.draft ?? {};
    const setting = list(state.daySettings).find(item => item?.date === day.date);
    const destination = cleanText(state.trip?.destination ?? '');
    const title = draft.title ?? (typeof setting?.title === 'string' ? setting.title : '');
    const place = draft.place ?? model.location?.ref ?? '';
    const [, month, dom] = day.date.split('-').map(Number);
    body = `<form class="plan-card" id="${panelId}" data-plan-card="day" novalidate>
      <p class="plan-card-title">第 ${day.n} 天・${month}/${dom}（${e(weekday(day.date))}）</p>
      ${card.formError ? `<p class="field-error" role="alert" tabindex="-1">${e(card.formError)}</p>` : ''}
      ${kit.field('title', '標題', attrs => `<input type="text" ${attrs} value="${e(title)}" autocomplete="off" data-focus="plan-field-title">`, { error: card.errors?.title })}
      ${kit.field('place', '地點', attrs => `<select ${attrs}>${placeOptions(state, place, { unset: destination ? '' : '不指定地點', newPlaces: draft.newPlaces })}</select>`, { error: card.errors?.place })}
      ${addPlaceHtml(kit, 'day')}
      <div class="plan-actions"><button class="button small" type="button" data-action="trip-settings"${kit.off()}>調整旅行日期與天數</button>
        <button class="button small" type="button" data-action="plan-save"${kit.off(card.sending)}>儲存</button></div>
    </form>`;
  }
  return `<section class="plan-section plan-day-settings"><h3 class="plan-section-title"><button class="plan-section-toggle" type="button" ${kit.toggle('day', open, panelId)} data-focus="plan-day-settings"><span>這一天的設定</span></button></h3>${body}</section>`;
}

function segmentButtons(kit) {
  const { planner } = kit;
  const button = (segment, label) => `<button class="button small" type="button" data-plan-nav="segment" data-segment="${segment}" data-focus="plan-segment-${segment}" aria-pressed="${planner.segment === segment}"${kit.off()}>${label}</button>`;
  return `<div class="plan-segments" role="group" aria-label="分段">${button('routes', '路線')}${button('activities', '活動')}</div>`;
}

// ---- Segment bodies: placeholders filled in by tasks 9.3 and 9.4 ----

const text = value => (typeof value === 'string' ? value : '');
const errorOf = (card, field) => {
  const errors = card?.errors;
  if (Array.isArray(errors)) return text(errors.find(item => item?.field === field)?.message);
  return rec(errors) ? text(errors[field]) : '';
};
/** Key that names a Draft Stop's fields (same rule as saveRoute()). */
const stopKeyOf = (stop, index) => {
  const key = stop?.key;
  if (typeof key === 'string' && key) return key;
  return Number.isFinite(key) ? String(key) : String(index + 1);
};
const carMembers = vehicle => [vehicle?.driver, ...list(vehicle?.passengers)].filter(Boolean);

/** Draft of the open Route card: the card's own Draft, else the one built from the saved values. */
function routeDraftOf(state, card, date) {
  if (card.draft) return card.draft;
  if (card.key === 'route:new') return newRouteDraft(state, date);
  if (card.key.startsWith('route:legacy:')) return legacyRouteDraft(state, card.key.slice('route:legacy:'.length));
  return routeDraft(state, card.key.slice('route:'.length));
}

/** The 要買的品項 preview of one 採買 Stop (requirement 6.6, D31); '' while no car is chosen. */
function shopPreviewHtml(kit, draft, preview, plan, route, stop, index, label) {
  const { state, e } = kit;
  const vehicle = list(state.vehicles).find(item => rec(item) && item.id === draft.vehicleId);
  const first = vehicle ? plan.firstStop.get(vehicle.id) : null;
  if (!vehicle || !first) return '';
  const vname = cleanText(text(vehicle.name));
  const stopId = route?.stops?.[index]?.id;
  let body = '';
  if (first.stop.id !== stopId) {
    const where = cleanText(placeLabel(preview, first.stop.place)) || `第 ${first.route.stops.indexOf(first.stop) + 1} 個途中任務`;
    body = `<p class="help">${e(`${vname}的採買品項列在第 ${first.n} 天的${where}`)}</p>`;
  } else {
    const items = list(plan.stopItems.get(stopId));
    const members = carMembers(vehicle);
    const shopping = list(state.shopping).filter(rec);
    if (items.length) {
      body += `<ul class="plan-preview-items" aria-label="${e(`${label}要買的品項`)}">${items.map(item => `<li>${e(item.name)}${item.done ? ' <span class="plan-bought">已買</span>' : ''}</li>`).join('')}</ul>`;
    } else if (!shopping.some(item => members.includes(item.assignee))) {
      body += `<p class="help">${e(`沒有品項由${vname}的駕駛或乘客負責買`)}</p>`;
    }
    for (const person of members) {
      if (!shopping.some(item => item.assignee === person)) continue;
      const buyer = plan.buyerCar.get(person);
      if (buyer === undefined || buyer === vehicle.id) continue;
      const other = cleanText(text(list(state.vehicles).find(item => rec(item) && item.id === buyer)?.name));
      const name = cleanText(text(list(state.people).find(item => rec(item) && item.id === person)?.name));
      body += `<p class="help">${e(`${name}也在${other}，負責買的品項算在${other}`)}</p>`;
    }
  }
  return `<div class="plan-preview"><p class="plan-preview-title">要買的品項</p>${body}
    <button class="button small" type="button" data-plan-nav="shopping" data-focus="plan-shopping-${e(stopKeyOf(stop, index))}" aria-label="${e(`到採買清單調整負責人 ${label}`)}">到採買清單調整負責人</button></div>`;
}

function stopHtml(kit, draft, stop, index, count, preview, plan, route) {
  const { state, planner, e } = kit;
  const card = planner.card;
  const key = stopKeyOf(stop, index);
  const place = cleanText(placeLabel(preview, stop.place));
  const label = place || `第 ${index + 1} 個途中任務`;
  const kind = text(stop.kind);
  const op = (name, text2, aria, disabled, focus) => `<button class="button small${name === 'remove-stop' ? ' danger' : ''}" type="button" data-plan-op="${name}" data-stop="${e(key)}" data-focus="plan-stop-${e(key)}-${focus}" aria-label="${e(aria)}"${kit.off(disabled)}>${text2}</button>`;
  return `<li class="plan-stop" data-stop="${e(key)}">
    ${kit.field(`stop-${key}-place`, '停在哪裡', attrs => `<select ${attrs} data-plan-field="stop-place" data-stop="${e(key)}" data-focus="plan-stop-${e(key)}-place">${placeOptions(state, text(stop.place), { unset: '選擇地點', newPlaces: draft.newPlaces })}</select>`, { error: errorOf(card, `stop-${key}-place`) })}
    ${addPlaceHtml(kit, `stop-${key}`)}
    ${kit.field(`stop-${key}-kind`, '要做什麼', attrs => `<select ${attrs} data-plan-field="stop-kind" data-stop="${e(key)}">${STOP_KINDS.map(entry => `<option value="${entry.kind}"${entry.kind === kind ? ' selected' : ''}>${e(entry.label)}</option>`).join('')}</select>`, { error: errorOf(card, `stop-${key}-kind`) })}
    ${kind === 'shop' ? shopPreviewHtml(kit, draft, preview, plan, route, stop, index, label)
      : kit.field(`stop-${key}-note`, '備註', attrs => `<input type="text" ${attrs} value="${e(text(stop.note))}" autocomplete="off" data-stop="${e(key)}">`, { error: errorOf(card, `stop-${key}-note`) })}
    <div class="plan-actions">
      ${op('stop-up', '上移', `上移${place ? ` ${place}` : `第 ${index + 1} 個途中任務`}`, index === 0, 'up')}
      ${op('stop-down', '下移', `下移${place ? ` ${place}` : `第 ${index + 1} 個途中任務`}`, index === count - 1, 'down')}
      ${op('remove-stop', '移除', place ? `移除途中任務 ${place}` : `移除第 ${index + 1} 個途中任務`, false, 'remove')}
    </div></li>`;
}

/** The expanded Route card (requirements 5.3, 5.4, 6.1–6.7, 6.14, 19.9). */
function routeCardHtml(kit, panelId, date) {
  const { state, planner, e } = kit;
  const card = planner.card;
  const draft = routeDraftOf(state, card, date) ?? newRouteDraft(state, date);
  const stops = list(draft.stops).filter(rec);
  const preview = previewState(state, draft);
  const plan = shoppingPlan(preview);
  const route = list(preview.routes).find(item => rec(item) && item.id === draft.routeId) ?? list(preview.routes).at(-1);
  const busy = new Set(list(state.routes).filter(item => rec(item) && item.date === date && item.id !== draft.routeId).map(item => item.vehicleId));
  const vehicles = list(state.vehicles).filter(item => rec(item) && !busy.has(item.id));
  const vehicle = list(state.vehicles).find(item => rec(item) && item.id === draft.vehicleId);
  const firstDay = tripDays(state)[0]?.date === date;
  const legacy = firstDay && vehicle && trimWhite(text(vehicle.meeting)) !== '';
  const vehicleOptions = [
    draft.vehicleId ? '' : `<option value="" selected>選擇哪一台車</option>`,
    ...vehicles.map(item => `<option value="${e(item.id)}"${item.id === draft.vehicleId ? ' selected' : ''}>${e(item.name)}</option>`)
  ].join('');
  const full = stops.length >= LIMITS.stops;
  const limitId = full ? kit.id() : '';
  const stopsHtml = stops.length
    ? `<p class="plan-card-title">途中任務</p><ol class="plan-stops">${stops.map((stop, index) => stopHtml(kit, draft, stop, index, stops.length, preview, plan, route)).join('')}</ol>`
    : `<p class="plan-card-title">途中任務（無）</p><p class="help">直接前往終點。需要採買、接送或取還裝備時再新增。</p>`;
  return `<form class="plan-card" id="${panelId}" data-plan-card="${e(card.key)}" novalidate>
    ${card.formError ? `<p class="field-error" role="alert" tabindex="-1">${e(card.formError)}</p>` : ''}
    ${kit.field('vehicle', '哪一台車', attrs => `<select ${attrs} data-plan-field="vehicle" data-focus="plan-field-vehicle">${vehicleOptions}</select>`, { error: errorOf(card, 'vehicle') })}
    ${kit.field('from', '從哪裡出發', attrs => `<select ${attrs} data-plan-field="from">${placeOptions(state, text(draft.from), { unset: '選擇地點', newPlaces: draft.newPlaces })}</select>`, { error: errorOf(card, 'from') })}
    ${draft.legacyText ? `<p class="help">${e(`舊出發地點：${draft.legacyText}。請選擇或新增起點。`)}</p>` : ''}
    ${addPlaceHtml(kit, 'from')}
    ${kit.field('to', '最後到哪裡', attrs => `<select ${attrs} data-plan-field="to">${placeOptions(state, text(draft.to), { unset: '選擇地點', newPlaces: draft.newPlaces })}</select>`, { error: errorOf(card, 'to') })}
    ${addPlaceHtml(kit, 'to')}
    ${kit.field('time', '幾點出發', attrs => `<input type="text" ${attrs} value="${e(text(draft.time))}" autocomplete="off" placeholder="例如 08:30">`, { error: errorOf(card, 'time') })}
    ${legacy ? `<p class="help">這台車的舊出發資料會改由這條路線記錄</p>` : ''}
    ${stopsHtml}
    <div class="plan-actions"><button class="button small" type="button" data-plan-op="add-stop" data-focus="plan-add-stop"${full ? ` disabled aria-describedby="${limitId}"` : kit.off()}>新增途中任務</button>
      ${full ? `<span class="help" id="${limitId}">每台車最多 6 個停靠點</span>` : ''}</div>
    <div class="plan-actions">
      ${draft.routeId ? `<button class="button small danger" type="button" data-action="plan-delete" data-kind="route" data-id="${e(draft.routeId)}"${kit.off(card.sending)}>刪除這條路線</button>` : ''}
      <button class="button small" type="button" data-action="plan-save"${kit.off(card.sending)}>儲存</button></div>
  </form>`;
}

function routeRowsHtml(kit, model) {
  const { state, planner, e } = kit;
  const date = model.date;
  const rows = sortedRoutes(state, date).map(route => {
    const key = `route:${route.id}`;
    const open = planner.card?.key === key;
    const panelId = open ? kit.id() : '';
    const vehicle = list(state.vehicles).find(item => rec(item) && item.id === route.vehicleId);
    const count = list(route.stops).length;
    const line = `${route.time || '時間待定'} ${cleanText(text(vehicle?.name))} / ${cleanText(placeLabel(state, route.from))} → ${cleanText(placeLabel(state, route.to))}・${count ? `${count} 個停靠點` : '直達'}`;
    return `<li class="plan-route" data-id="${e(route.id)}"><div class="plan-row">
      <button class="plan-row-button" type="button" ${kit.toggle(key, open, panelId)} data-focus="plan-${e(key)}"><span class="plan-row-name">${e(line)}</span></button>
    </div>${open ? routeCardHtml(kit, panelId, date) : ''}</li>`;
  });
  const legacy = model.legacy.map(entry => {
    const key = `route:legacy:${entry.vehicle.id}`;
    const open = planner.card?.key === key;
    const panelId = open ? kit.id() : '';
    const name = cleanText(text(entry.vehicle.name));
    const line = `${name}・${entry.time || '時間待定'} / ${cleanText(entry.location) || '出發地點待定'}`;
    return `<li class="plan-route plan-legacy" data-id="${e(entry.vehicle.id)}"><div class="plan-row">
      <span class="plan-row-meta">舊的出發資料</span><span class="plan-row-name">${e(line)}</span>
      <button class="button small" type="button" ${kit.toggle(key, open, panelId)} data-focus="plan-${e(key)}" aria-label="${e(`轉成路線 ${name}`)}">${e(`轉成路線 ${name}`)}</button>
      <button class="button small" type="button" data-action="plan-clear-legacy" data-id="${e(entry.vehicle.id)}" aria-label="${e(`不使用舊資料 ${name}`)}"${kit.off()}>不使用舊資料</button>
    </div>${open ? routeCardHtml(kit, panelId, date) : ''}</li>`;
  });
  return rows.concat(legacy).join('');
}

function addRouteHtml(kit, model) {
  const { state, planner } = kit;
  const vehicles = list(state.vehicles).filter(rec);
  const busy = new Set(sortedRoutes(state, model.date).map(route => route.vehicleId));
  const none = !vehicles.length;
  const allBusy = !none && vehicles.every(item => busy.has(item.id));
  const reason = none ? '還沒有車輛，新增車輛後就能安排路線' : allBusy ? '每台車這一天都已有路線' : '';
  const open = planner.card?.key === 'route:new';
  const panelId = open ? kit.id() : '';
  const reasonId = reason ? kit.id() : '';
  return `<div class="plan-actions"><button class="button small" type="button" ${kit.toggle('route:new', open, panelId, Boolean(reason))} data-focus="plan-route:new"${reason ? ` aria-describedby="${reasonId}"` : ''}>＋新增路線</button>`
    + `${reason ? `<span class="help" id="${reasonId}">${kit.e(reason)}</span>` : ''}`
    + `${none ? `<button class="button small" type="button" data-action="vehicle"${kit.off()}>新增車輛</button>` : ''}</div>`
    + (open ? routeCardHtml(kit, panelId, model.date) : '');
}

function arrivalHtml(kit, model) {
  const { planner, e } = kit;
  if (!model.arrivalRoutes.length && !model.arrival) return '';
  const open = planner.card?.key === 'arrival';
  const panelId = open ? kit.id() : '';
  const where = model.location ? cleanText(model.location.name) : '';
  const label = `預計幾點抵達${where}`;
  let body = '';
  if (open) {
    const card = planner.card, draft = card.draft ?? {};
    const value = draft.arrival ?? model.arrival ?? '';
    body = `<form class="plan-card" id="${panelId}" data-plan-card="arrival" novalidate>
      ${card.formError ? `<p class="field-error" role="alert" tabindex="-1">${e(card.formError)}</p>` : ''}
      ${kit.field('arrival', label, attrs => `<input type="text" ${attrs} value="${e(value)}" autocomplete="off" placeholder="例如 08:30" data-focus="plan-field-arrival">`, { error: errorOf(card, 'arrival') })}
      <button class="button small" type="button" data-action="plan-save"${kit.off(card.sending)}>儲存</button></form>`;
  }
  return `<div class="plan-arrival"><div class="plan-row"><button class="plan-row-button" type="button" ${kit.toggle('arrival', open, panelId)} data-focus="plan-arrival">`
    + `<span class="plan-row-name">${e(`${label}：${model.arrival || '未填'}`)}</span></button></div>${body}</div>`;
}

function unassignedHtml(kit, plan) {
  const { state, planner, e } = kit;
  if (!list(state.shopping).length) return '';
  const entries = list(plan.unassigned);
  const n = entries.length;
  const open = n > 0 && Boolean(planner.unassignedOpen);
  const panelId = open ? kit.id() : '';
  let body = '';
  if (open) {
    const groups = SHOPPING_CATEGORIES.map(category => {
      const rows = entries.filter(entry => entry.item?.category === category);
      return rows.length
        ? `<li><p class="plan-card-title">${e(category)}</p><ul class="plan-list">${rows.map(entry => `<li>${e(entry.item.name)} <span class="help">${e(entry.reason)}</span>${entry.item.done ? ' <span class="plan-bought">已買</span>' : ''}</li>`).join('')}</ul></li>`
        : '';
    }).join('');
    body = `<ul class="plan-list plan-unassigned-list" id="${panelId}">${groups}</ul>`;
  }
  return `<section class="plan-section plan-unassigned"><h3 class="plan-section-title"><button class="plan-section-toggle" type="button" ${kit.toggle('unassigned', open, panelId, n === 0)} data-focus="plan-unassigned">`
    + `<span>${e(`未分配採買清單・${n} 項`)}</span><span class="plan-row-meta">${n ? '還沒決定哪台車去買' : '每個採買品項都已安排停靠點'}</span></button></h3>${body}</section>`;
}

/** 「路線」 segment body (requirements 4.8, 5, 6, 19.4): `kit` gives ids, escape, icon and disabled state. */
export function routesSegmentHtml(state, planner, ctx, model, kit) {
  const plan = ctx?.plan ?? shoppingPlan(state);
  const rows = routeRowsHtml(kit, model);
  return `<div class="plan-segment-body" data-plan-segment="routes">
    <p class="help">每台車可安排 6 個停靠點，時間可稍後填。</p>
    ${rows ? `<ul class="plan-list plan-routes-list" aria-label="路線">${rows}</ul>` : ''}
    ${addRouteHtml(kit, model)}
    ${arrivalHtml(kit, model)}
    ${unassignedHtml(kit, plan)}
  </div>`;
}

// ---- 「活動」 segment (requirements 7, 8; design rows 7 to 9) ----

const dayLabel = day => {
  const [, month, dom] = day.date.split('-').map(Number);
  return `第 ${day.n} 天・${month}/${dom}（週${weekday(day.date).replace(/^週/, '')}）`;
};

/** The day's moments (Activities and Meal_Moments) in Day_Sequence order (requirement 14.13). */
const momentsOf = model => list(model.blocks).flatMap(block => (block.type === 'moments' ? list(block.items) : []));

function activityCardHtml(kit, panelId, date) {
  const { state, planner, e } = kit;
  const card = planner.card;
  const adding = card.key === 'activity:new';
  const saved = adding ? null : list(state.activities).find(item => rec(item) && `activity:${item.id}` === card.key);
  const draft = card.draft ?? (adding ? newActivityDraft(state, date) : activityDraft(state, saved?.id)) ?? newActivityDraft(state, date);
  const vehicles = list(state.vehicles).filter(rec);
  const checked = new Set(list(draft.vehicleIds));
  const participation = text(draft.participation) || 'all';
  const legacy = Boolean(saved) && saved.vehicleIds === undefined && list(saved.people).length > 0;
  const names = legacy
    ? list(saved.people).map(id => cleanText(text(list(state.people).find(person => rec(person) && person.id === id)?.name))).filter(Boolean)
    : [];
  const radio = (value, label, extra = '', disabled = false) => {
    const id = kit.id();
    return `<div class="plan-choice"><input type="radio" id="${id}" name="participation" value="${value}" data-plan-field="participation"${participation === value ? ' checked' : ''}${kit.off(disabled)}${extra}><label for="${id}">${label}</label></div>`;
  };
  const noCars = !vehicles.length;
  const noCarsId = noCars ? kit.id() : '';
  const carBoxes = vehicles.map(vehicle => {
    const id = kit.id();
    return `<div class="plan-choice"><input type="checkbox" id="${id}" name="vehicleIds" value="${e(vehicle.id)}" data-plan-field="vehicle-check"${checked.has(vehicle.id) ? ' checked' : ''}${kit.off(participation !== 'vehicles')}><label for="${id}">${e(vehicle.name)}</label></div>`;
  }).join('');
  const vehicleError = errorOf(card, 'vehicles');
  const errorId = vehicleError ? kit.id() : '';
  const participationError = errorOf(card, 'participation');
  const dayOptions = tripDays(state).map(day => `<option value="${e(day.date)}"${day.date === draft.date ? ' selected' : ''}>${e(dayLabel(day))}</option>`).join('');
  return `<form class="plan-card" id="${panelId}" data-plan-card="${e(card.key)}" novalidate>
    ${card.formError ? `<p class="field-error" role="alert" tabindex="-1">${e(card.formError)}</p>` : ''}
    ${kit.field('title', '標題', attrs => `<input type="text" ${attrs} value="${e(text(draft.title))}" autocomplete="off" data-focus="plan-field-title">`, { error: errorOf(card, 'title') })}
    ${kit.field('date', '日期', attrs => `<select ${attrs} data-plan-field="date">${dayOptions}</select>`, { error: errorOf(card, 'date') })}
    ${kit.field('time', '時間', attrs => `<input type="text" ${attrs} value="${e(text(draft.time))}" autocomplete="off" placeholder="例如 08:30">`, { error: errorOf(card, 'time') })}
    ${kit.field('type', '類別', attrs => `<select ${attrs} data-plan-field="type">${ACTIVITY_CATEGORIES.map(category => `<option value="${category.type}"${category.type === draft.type ? ' selected' : ''}>${e(category.label)}</option>`).join('')}</select>`, { error: errorOf(card, 'type') })}
    <fieldset class="plan-fieldset"><legend>參加方式</legend>
      ${radio('all', '全體旅伴')}
      ${legacy ? radio('legacy', names.length ? `保留原旅伴名單：${e(names.join('、'))}` : '保留原旅伴名單') : ''}
      ${radio('vehicles', '指定車輛', noCars ? ` aria-describedby="${noCarsId}"` : '', noCars)}
      ${participationError ? `<p class="field-error">${e(participationError)}</p>` : ''}
      ${noCars ? `<p class="help" id="${noCarsId}">還沒有車輛，新增車輛後才能指定車輛</p>` : `<fieldset class="plan-fieldset"${vehicleError ? ` aria-describedby="${errorId}"` : ''}><legend>指定的車輛</legend>${carBoxes}${vehicleError ? `<p class="field-error" id="${errorId}">${e(vehicleError)}</p>` : ''}</fieldset>`}
    </fieldset>
    ${kit.field('location', '地點', attrs => `<input type="text" ${attrs} value="${e(text(draft.location))}" autocomplete="off">`, { error: errorOf(card, 'location') })}
    ${kit.field('note', '備註', attrs => `<textarea ${attrs} rows="3">${e(text(draft.note))}</textarea>`, { error: errorOf(card, 'note') })}
    <div class="plan-actions">
      ${saved ? `<button class="button small danger" type="button" data-action="plan-delete" data-kind="activity" data-id="${e(saved.id)}"${kit.off(card.sending)}>刪除這個活動</button>` : ''}
      <button class="button small" type="button" data-action="plan-save"${kit.off(card.sending)}>儲存</button></div>
  </form>`;
}

function mealCardHtml(kit, panelId, item) {
  const { planner, e } = kit;
  const card = planner.card, draft = card.draft ?? {};
  const value = draft.time ?? (typeof item.meal.time === 'string' ? item.meal.time : '');
  const hint = `不填時使用預設時間 ${item.time}`;
  return `<form class="plan-card" id="${panelId}" data-plan-card="${e(card.key)}" novalidate>
    ${card.formError ? `<p class="field-error" role="alert" tabindex="-1">${e(card.formError)}</p>` : ''}
    ${kit.field('time', '時間', attrs => `<input type="text" ${attrs} value="${e(value)}" autocomplete="off" placeholder="例如 12:00" data-focus="plan-field-time">`, { error: errorOf(card, 'time'), hint })}
    ${item.ingredients.length ? `<p class="plan-card-title">食材</p><p class="plan-ingredients">${e(item.ingredients.map(entry => (typeof entry === 'string' ? entry : text(entry?.name))).filter(Boolean).join('、'))}</p>` : ''}
    <div class="plan-actions"><button class="button small" type="button" data-plan-nav="meal" data-id="${e(item.meal.id)}"${kit.off()}>到料理菜單編輯</button>
      <button class="button small" type="button" data-action="plan-save"${kit.off(card.sending)}>儲存</button></div>
  </form>`;
}

function momentRowsHtml(kit, model) {
  const { planner, e } = kit;
  return momentsOf(model).map(item => {
    if (item.type === 'activity') {
      const activity = item.activity;
      const key = `activity:${activity.id}`;
      const open = planner.card?.key === key;
      const panelId = open ? kit.id() : '';
      const checkId = kit.id();
      return `<li class="plan-moment plan-activity" data-id="${e(activity.id)}"><div class="plan-row">
        <label class="plan-done-check" for="${checkId}"><input type="checkbox" id="${checkId}" data-activity-check="${e(activity.id)}" data-focus="plan-activity-done:${e(activity.id)}"${item.done ? ' checked' : ''} aria-label="${e(`${item.title}已完成`)}"${kit.off()}><span class="visually-hidden">完成</span></label>
        <button class="plan-row-button" type="button" ${kit.toggle(key, open, panelId)} data-focus="plan-${e(key)}"><span class="plan-row-meta">${e(item.time || '時間待定')}</span> <span class="plan-row-name">${e(item.title)}</span> <span class="plan-row-meta">${e(item.category)}</span></button>
      </div>${open ? activityCardHtml(kit, panelId, model.date) : ''}</li>`;
    }
    const key = `meal:${item.meal.id}`;
    const open = planner.card?.key === key;
    const panelId = open ? kit.id() : '';
    return `<li class="plan-moment plan-meal" data-id="${e(item.meal.id)}"><div class="plan-row">
      <button class="plan-row-button" type="button" ${kit.toggle(key, open, panelId)} data-focus="plan-${e(key)}"><span class="plan-row-meta">${e(item.time)}</span> <span class="plan-row-name">${e(item.title)}</span> <span class="plan-row-meta">${e(item.label)}</span> <span class="plan-row-meta">來自料理菜單</span></button>
    </div>${open ? mealCardHtml(kit, panelId, item) : ''}</li>`;
  }).join('');
}

function presetsHtml(kit, model) {
  const { state, planner, e } = kit;
  const day = tripDays(state).find(entry => entry.date === model.date);
  const presets = presetsFor(day?.kind);
  if (!presets.length) return '';
  const have = new Set(list(state.activities).filter(item => rec(item) && item.date === model.date).map(item => item.type));
  const picked = planner.presets instanceof Set ? planner.presets : new Set(list(planner.presets));
  let n = 0;
  const boxes = presets.map(([type, time, title]) => {
    const id = kit.id();
    const added = have.has(type);
    const on = !added && picked.has(type);
    if (on) n++;
    return `<div class="plan-choice"><input type="checkbox" id="${id}" value="${type}" data-plan-preset="${type}"${added || on ? ' checked' : ''}${kit.off(added)}>`
      + `<label for="${id}">${e(`${time} ${title}（${categoryLabel(type)}）`)}${added ? ' <span class="plan-added">已加入</span>' : ''}</label></div>`;
  }).join('');
  return `<fieldset class="plan-fieldset plan-presets"><legend>常用活動</legend>${boxes}
    <button class="button small" type="button" data-action="plan-add-presets" data-focus="plan-add-presets"${kit.off(n === 0)}>${`加入 ${n} 個活動`}</button></fieldset>`;
}

/** 「活動」 segment body (requirements 7.1–7.3, 7.5–7.7, 7.9, 7.11, 8.2, 8.5, 8.7, 8.8, 8.13, 16.5). */
export function activitiesSegmentHtml(state, planner, ctx, model, kit) {
  const rows = momentRowsHtml(kit, model);
  const open = planner.card?.key === 'activity:new';
  const panelId = open ? kit.id() : '';
  return `<div class="plan-segment-body" data-plan-segment="activities">
    ${rows ? `<ul class="plan-list plan-activities-list" aria-label="活動">${rows}</ul>` : '<p class="plan-empty">這一天還沒有活動</p>'}
    ${presetsHtml(kit, model)}
    <div class="plan-actions"><button class="button small" type="button" ${kit.toggle('activity:new', open, panelId)} data-focus="plan-activity:new">＋自訂活動</button></div>
    ${open ? activityCardHtml(kit, panelId, model.date) : ''}
  </div>`;
}

// ---- Entry point ----

export function editorHtml(state, planner, ctx = {}) {
  const kit = makeKit(state, planner, ctx);
  const days = tripDays(state);
  if (!days.length) return `<div class="itinerary-editor"></div>`;
  const plan = ctx.plan ?? shoppingPlan(state);
  const context = { ...ctx, plan, warnings: ctx.warnings ?? planningWarnings(state, plan) };
  kit.ctx = context;
  const index = Math.min(Math.max(Number(planner.dayIndex) || 0, 0), days.length - 1);
  const view = index === planner.dayIndex ? planner : { ...planner, dayIndex: index };
  kit.planner = view;
  const day = days[index];
  const model = modelFor(context, day.date) ?? dayModel(state, day.date, plan);
  const segment = view.segment === 'activities' ? 'activities' : 'routes';
  kit.planner = segment === view.segment ? view : { ...view, segment };
  const segmentBody = segment === 'routes'
    ? routesSegmentHtml(state, kit.planner, context, model, kit)
    : activitiesSegmentHtml(state, kit.planner, context, model, kit);
  return `<div class="itinerary-editor" data-day-kind="${day.kind}">`
    + placesAndCarsHtml(kit)
    + dayButtons(kit, days, context.warnings)
    + summaryHtml(kit, model)
    + warningsHtml(kit, list(context.warnings.get(day.date)))
    + daySettingsHtml(kit, day, model)
    + segmentButtons(kit)
    + segmentBody
    + `</div>`;
}


