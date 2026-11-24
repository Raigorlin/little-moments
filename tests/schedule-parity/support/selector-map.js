// Executable Selector_Map of the schedule-tab-css-parity spec (design "Selector_Map" and section 6.4).
//
// ENTRIES has one entry per selector string of the design's Match and Unreachable tables. A table row
// that lists several selectors (for example 82 or 138) becomes one entry per selector, all with the
// row's `id`. `lines` are physical lines of src/styles.css in the design's notation (`@≤N` is
// `@media(max-width:Npx)`, `@≥N` `@media(min-width:Npx)`, `@print`, `@reduce`, `@forced`).
//
// ROLES locate each entry's target elements without the class under test: by ARIA names and
// relations, ids, headings, element types, data attributes and text. They run inside the page, so
// every role and helper below may use only DOM globals, the helpers in HELPERS and ROLES itself.
// Inject them with `page.evaluateHandle(rolesScript())`. `root` is the `.workspace` element; a role
// returns the elements that the paired selector may match, so the check
//   matched.length > 0 && matched.every((el) => role(root).includes(el))
// holds for Match entries, where `matched` is `queryWithin(root, evaluatedSelector(selector))`.
//
// STATES drive LM_Web from a freshly loaded Comparison_Fixture page (the Trip_Page schedule tab,
// before any interaction) into each Selector_Map state. S5–S7 need the parity-mobile project.

/** Specific Planner_Classes (design "Planner classes"). */
export const PLANNER_CLASSES = [
  'workspace', 'workspace-main', 'sidebar', 'crew-panel', 'avatar-stack', 'avatar', 'progress-line',
  'yellow-progress', 'unassigned-link', 'side-footnote', 'schedule-plan', 'section-title', 'schedule-bar',
  'date-tabs', 'vehicle-departures', 'vehicle-departures-heading', 'departure-vehicle', 'departure-vehicles',
  'departure-vehicles-empty', 'departure-vehicle-top', 'departure-vehicle-name', 'vehicle-swipe-actions',
  'departure-vehicle-time', 'departure-vehicle-place', 'day-settings-form', 'route-form', 'route-stops',
  'activity-form', 'activity-vehicle-choices', 'activity-card', 'timeline', 'empty', 'timeline-stamp',
  'activity-top', 'activity-actions', 'activity-edit', 'activity-location', 'map-link', 'map-link-icon',
  'activity-bottom', 'mini-check', 'event-list', 'shopping-list', 'shopping-category', 'shopping-row',
  'shopping-where', 'is-unrouted', 'quantity', 'vehicle-card', 'vehicle-title', 'passenger-list', 'form-grid',
  'field', 'form-actions', 'form-error', 'notice', 'editor-stack', 'editor-stack-row', 'editor-avatar',
  'editor-avatar-more', 'swipe-row', 'swipe-actions', 'swipe-action', 'swipe-action-danger', 'swipe-toggle',
  'swipe-open', 'swipe-dragging', 'swipe-settling',
];

/** Shared classes: alone they do not make a selector a Planner_Selector (design "Data Models"). */
export const SHARED_CLASSES = ['button', 'small', 'primary', 'full', 'icon-button', 'danger', 'text-button', 'help',
  'eyebrow', 'tag', 'coral', 'blue', 'green', 'selected', 'wide', 'done', 'icon'];

/** @typedef {{ id: string, selector: string, lines: string, role?: string, states: string[], status: 'match'|'unreachable', reason?: string }} Entry */

/** Every state of design section 6.4, in evaluation order. */
export const ALL_STATES = ['S0', 'S0d', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
/** States that need Touch_Layout (the parity-mobile project). */
export const MOBILE_STATES = ['S5', 'S6', 'S7'];

/** @returns {Entry} */
const m = (id, selector, lines, role, states) => ({ id, selector, lines, role, states, status: 'match' });
// Unreachable entries must match nothing in the Planner_Body in every state (Decision D4).
/** @returns {Entry} */
const u = (id, selector, lines, reason) => ({ id, selector, lines, states: ALL_STATES, status: 'unreachable', reason });

/** @type {Entry[]} */
export const ENTRIES = [
  m('1', '.workspace', '8, 16@≤1020, 17@≤760, 20@print, 34, 41@≤1020', 'workspace', ['S0']),
  m('2', '.workspace-main', '8', 'workspace-main', ['S0']),
  m('3', '.sidebar', '8, 17@≤760, 18@≤480, 20@print, 41@≤1020, 43@≤480', 'sidebar', ['S0']),
  m('4', '.crew-panel', '8, 16@≤1020, 17@≤760, 18@≤480, 345@≤600', 'crew-panel', ['S0']),
  m('5', '.crew-panel .eyebrow', '18@≤480, 33, 346@≤600', 'crew-eyebrow', ['S0']),
  m('6', '.crew-panel h2', '8, 16@≤1020, 18@≤480, 32, 43@≤480, 347@≤600', 'crew-heading', ['S0']),
  m('7', '.crew-panel>p', '8, 18@≤480, 35, 350@≤600', 'crew-summary', ['S0']),
  m('8', '.crew-panel>.button', '8, 18@≤480, 35, 353@≤600', 'checklist-link', ['S0']),
  m('9', '.button.full', '5', 'checklist-link', ['S0']),
  m('10', '.avatar', '6', 'sidebar-avatar', ['S0']),
  m('11', '.avatar-stack', '8, 35, 348@≤600', 'avatar-row', ['S0']),
  m('12', '.avatar-stack>.avatar', '8, 16@≤1020, 17@≤760, 18@≤480, 349@≤600', 'sidebar-avatar', ['S0']),
  m('13', '.progress-line', '8, 35, 351@≤600', 'progress-label-row', ['S0']),
  m('14', '.progress-line b', '8', 'progress-count', ['S0']),
  m('15', '.progress-line b>span', '8', 'progress-total', ['S0']),
  m('16', '.yellow-progress::-webkit-progress-value', '8', 'gear-progress', ['S0']),
  m('17', '.unassigned-link', '8, 352@≤600', 'unassigned-gear-button', ['S0']),
  m('18', '.unassigned-link .icon', '8', 'unassigned-gear-icon', ['S0']),
  m('19', '.unassigned-link .icon:last-child', '8', 'unassigned-gear-arrow', ['S0']),
  m('20', '.side-footnote', '8, 17@≤760, 18@≤480, 357@≤600', 'side-footnote', ['S0']),
  m('21', '.side-footnote .icon', '8', 'side-footnote-icon', ['S0']),
  m('22', '.section-title', '9, 18@≤480, 33, 43@≤480', 'section-title-row', ['S0']),
  m('23', '.section-title .eyebrow', '18@≤480, 33', 'section-title-eyebrow', ['S0']),
  m('24', '.section-title h2', '9, 17@≤760, 18@≤480, 32, 42@≤760, 43@≤480', 'section-title-heading', ['S0']),
  m('25', '.section-title>.button', '9, 18@≤480, 29, 43@≤480', 'copy-text-button', ['S0']),
  m('26', '.schedule-bar', '9, 17@≤760, 18@≤480, 43@≤480, 219@≤600', 'day-picker-row', ['S0']),
  m('27', '.date-tabs', '9, 16@≤1020, 18@≤480, 43@≤480, 220@≤600', 'day-picker', ['S0']),
  m('28', '.date-tabs>button', '9, 16@≤1020, 17@≤760, 18@≤480, 21@≤480, 43@≤480, 221@≤600', 'day-button', ['S0']),
  m('29', '.date-tabs button.selected', '9', 'selected-day-button', ['S0']),
  m('30', '.date-tabs small', '9, 31, 43@≤480', 'day-button-ordinal', ['S0']),
  m('31', '.date-tabs b', '9, 16@≤1020, 43@≤480', 'day-button-date', ['S0']),
  m('32', '.date-tabs span', '9, 21@≤480, 31, 43@≤480', 'day-button-weekday', ['S0']),
  m('33', '.vehicle-departures', '193, 212@print, 215', 'planner-section', ['S0']),
  m('34', '.vehicle-departures-heading', '194', 'planner-section-heading', ['S0']),
  m('35', '.vehicle-departures-heading>div', '195', 'planner-section-title-block', ['S0']),
  m('36', '.vehicle-departures-heading .eyebrow', '196, 211@≤600', 'planner-section-eyebrow', ['S0']),
  m('37', '.vehicle-departures-heading h2', '197, 211@≤600', 'planner-section-title', ['S0']),
  m('38', '.vehicle-departures-heading h2>span', '197', 'planner-section-count', ['S0']),
  m('39', '.vehicle-departures-heading>.button', '195, 211@≤600, 212@print', 'planner-section-button', ['S0']),
  m('40', '.vehicle-departures>.help', '198', 'planner-section-help', ['S0']),
  m('41', '.departure-vehicles', '199, 211@≤600', 'card-grid', ['S0']),
  m('42', '.departure-vehicles-empty', '208', 'no-routes-message', ['S3']),
  m('43', '.departure-vehicle', '200, 211@≤600, 212@print', 'departure-card', ['S0']),
  m('44', '.departure-vehicle dl', '206', 'departure-card-list', ['S0']),
  m('45', '.departure-vehicle dl>div', '206', 'departure-card-list-row', ['S0']),
  m('46', '.departure-vehicle dt', '206', 'departure-card-term', ['S0']),
  m('47', '.departure-vehicle dd', '206', 'departure-card-value', ['S0']),
  m('48', '.departure-vehicle-top', '201', 'card-top-row', ['S0']),
  m('49', '.departure-vehicle-name', '202', 'card-name-block', ['S0']),
  m('50', '.departure-vehicle-name>.icon', '202', 'card-name-icon', ['S0']),
  m('51', '.departure-vehicle-name h3', '203', 'card-name', ['S0']),
  m('52', '.vehicle-swipe-actions', '65', 'card-actions', ['S0']),
  m('53', '.departure-vehicle-time', '204', 'route-departure-row', ['S0']),
  m('54', '.departure-vehicle-time time', '204', 'route-departure-time', ['S0']),
  m('55', '.departure-vehicle-time>span', '204', 'route-departure-label', ['S0']),
  m('56', '.departure-vehicle-place', '205', 'route-endpoints', ['S0']),
  m('57', '.departure-vehicle-place>.icon', '205', 'route-endpoints-icon', ['S0']),
  m('58', '.activity-vehicle-choices', '260', 'activity-presets', ['S0']),
  m('59', '.activity-vehicle-choices>label', '262, 269@≤600', 'preset-label', ['S0']),
  m('60', '.activity-vehicle-choices input', '263', 'preset-checkbox', ['S0']),
  m('61', '.activity-vehicle-choices label>span', '264', 'preset-text', ['S0']),
  m('62', '.activity-vehicle-choices strong', '265', 'preset-title', ['S0']),
  m('63', '.activity-vehicle-choices small', '266', 'preset-kind', ['S0']),
  m('64', '.form-actions', '14, 18@≤480, 36, 43@≤480', 'form-action-row', ['S0', 'S1']),
  m('65', '.form-actions>.button', '18@≤480, 29, 36, 43@≤480', 'form-action-button', ['S0', 'S1']),
  m('66', '.timeline', '9, 18@≤480, 43@≤480', 'activity-list', ['S0']),
  m('67', '.timeline:before', '9, 18@≤480', 'activity-list', ['S0']),
  m('68', '.activity-card', '9, 16@≤1020, 18@≤480, 20@print, 43@≤480', 'activity-card', ['S0']),
  m('69', '.activity-card.done', '9', 'done-activity-card', ['S0']),
  m('70', '.done h3', '9', 'done-activity-title', ['S0']),
  m('71', '.activity-card h3', '9, 16@≤1020, 17@≤760, 18@≤480, 32, 43@≤480', 'activity-title', ['S0']),
  m('72', '.activity-card>p', '9, 18@≤480, 28, 43@≤480', 'activity-note', ['S0']),
  m('73', '.timeline-stamp', '9, 18@≤480, 43@≤480', 'activity-stamp', ['S0']),
  m('74', '.timeline-stamp .icon', '9, 18@≤480', 'activity-stamp-icon', ['S0']),
  m('75', '.activity-top', '9, 17@≤760, 18@≤480, 43@≤480', 'activity-top-row', ['S0']),
  m('76', '.activity-top time', '9, 18@≤480', 'activity-time', ['S0']),
  m('77', '.tag', '9', 'kind-tag', ['S0']),
  m('78', '.activity-actions', '65', 'activity-actions', ['S0']),
  m('79', '.activity-edit', '9', 'activity-edit-button', ['S0']),
  m('80', '.activity-location', '9, 18@≤480, 31, 43@≤480, 247', 'activity-location', ['S0']),
  m('81', '.activity-location .icon', '9', 'activity-location-icon', ['S0']),
  m('82', '.map-link', '244, 248@print', 'map-link', ['S0']),
  m('82', '.map-link:hover', '245', 'map-link', ['S0']),
  // The design table lists only line 245; src/styles.css line 248 (print) also hides the icon.
  m('83', '.map-link-icon', '245, 248@print', 'map-link-icon', ['S0']),
  m('84', '.activity-bottom', '9, 18@≤480', 'activity-bottom-row', ['S0']),
  m('85', '.activity-bottom .icon', '9', 'activity-participant-icon', ['S0']),
  m('86', '.activity-bottom>span', '9, 18@≤480, 31, 43@≤480, 267', 'activity-participants', ['S0']),
  m('87', '.activity-bottom>span>.icon', '267', 'activity-participant-icon', ['S0']),
  m('88', '.activity-bottom>span>span', '268', 'activity-participant-text', ['S0']),
  m('89', '.mini-check', '9, 18@≤480, 20@print, 31, 43@≤480', 'done-check', ['S0']),
  m('90', '.mini-check input', '9, 18@≤480', 'done-checkbox', ['S0']),
  m('91', '.empty', '11', 'empty-day', ['S4']),
  m('92', '.empty>.icon', '11', 'empty-day-icon', ['S4']),
  m('93', '.empty h3', '11', 'empty-day-heading', ['S4']),
  m('94', '.empty p', '11', 'empty-day-hint', ['S4']),
  m('95', '.event-list', '11', 'meal-list', ['S0']),
  m('96', '.event-list li', '11, 18@≤480', 'meal-row', ['S0']),
  m('97', '.event-list time', '11', 'meal-time', ['S0']),
  m('98', '.event-list b', '11', 'meal-title', ['S0']),
  m('99', '.field', '14, 28', 'field-label', ['S0', 'S1']),
  m('100', '.field>span', '30', 'field-caption', ['S0', 'S1']),
  m('101', '.field input', '14, 30', 'field-input', ['S0', 'S1']),
  m('102', '.form-grid', '14, 18@≤480, 36, 42@≤760', 'form-grid', ['S1']),
  m('103', '.field select', '14, 30, 76, 100@forced, 139@reduce', 'field-select', ['S1']),
  m('103', '.field select:focus-visible', '85', 'field-select', ['S1']),
  m('103', '.field select:hover:not(:disabled)', '84', 'field-select', ['S1']),
  m('104', '.field textarea', '14, 30', 'field-textarea', ['S1']),
  m('105', '.field.wide', '14, 18@≤480', 'wide-field', ['S1']),
  m('106', '.wide', '14, 18@≤480', 'wide-field', ['S1']),
  m('107', '.form-actions>.text-button', '14, 18@≤480', 'remove-item-button', ['S1']),
  m('108', '.form-error', '14, 31', 'form-error', ['S0', 'S1']),
  m('109', '.form-error:not(:empty)', '14', 'place-name-error', ['S2']),
  m('110', '.shopping-list', '10', 'unassigned-list', ['S0']),
  m('111', '.shopping-category h3', '10, 32', 'unassigned-category-heading', ['S0']),
  m('112', '.shopping-category h3>span', '10, 32', 'unassigned-category-count', ['S0']),
  m('113', '.shopping-row', '10, 18@≤480, 20@print, 35, 43@≤480, 70, 71@≤580, 98, 99@≤580, 275, 278@≤580', 'unassigned-row', ['S0']),
  m('114', '.shopping-row+.shopping-row', '10', 'unassigned-row-after-first', ['S0']),
  m('115', '.shopping-row>label', '10, 18@≤480, 43@≤480, 70, 71@≤580', 'unassigned-name-block', ['S0']),
  m('116', '.shopping-row>label>span', '23', 'unassigned-name-text', ['S0']),
  m('117', '.shopping-row b', '10, 18@≤480, 32, 43@≤480', 'unassigned-name', ['S0']),
  m('118', '.shopping-row small', '10, 31, 35', 'unassigned-reason', ['S0']),
  m('119', '.shopping-where.is-unrouted', '380', 'unassigned-reason', ['S0']),
  m('120', '.shopping-row .quantity', '10, 18@≤480, 31, 35, 43@≤480', 'unassigned-quantity', ['S0']),
  m('121', '.shopping-row>.quantity', '70, 71@≤580', 'unassigned-quantity', ['S0']),
  m('122', '.shopping-row.done', '10', 'purchased-row', ['S0']),
  m('123', '.shopping-row.done b', '9', 'purchased-name', ['S0']),
  m('124', '.shopping-row.done>label', '10', 'purchased-name-block', ['S0']),
  m('125', '.vehicle-card', '11', 'schedule-vehicle-card', ['S0']),
  m('126', '.vehicle-title', '11', 'vehicle-title-row', ['S0']),
  m('127', '.vehicle-title h3', '11', 'vehicle-name', ['S0']),
  m('128', '.vehicle-title .icon-button', '11', 'vehicle-title-button', ['S0']),
  m('129', '.vehicle-card>p', '11', 'vehicle-summary', ['S0']),
  m('130', '.vehicle-card>p span', '11', 'vehicle-summary-separator', ['S0']),
  m('131', '.passenger-list', '11', 'passenger-row', ['S0']),
  m('132', '.passenger-list>span', '11', 'passenger-chip', ['S0']),
  m('133', '.swipe-row', '48, 56', 'swipe-row', ['S0']),
  m('134', '.swipe-row>.swipe-actions', '49, 58@≤760, 63@≥761, 64@reduce', 'swipe-panel', ['S0']),
  m('135', '.swipe-row>.swipe-toggle', '63@≥761', 'swipe-toggle', ['S0']),
  m('136', '.swipe-toggle', '59, 62@≤760', 'swipe-toggle', ['S0']),
  m('137', '.swipe-row>:not(.swipe-actions):not(.swipe-toggle)', '58@≤760, 64@reduce', 'swipe-row-content', ['S0']),
  m('138', '.swipe-actions>.swipe-action', '51', 'swipe-copy', ['S0']),
  m('138', '.swipe-actions>.swipe-action:focus-visible', '58@≤760', 'swipe-copy', ['S0']),
  m('138', '.swipe-actions>.swipe-action:hover:not(:disabled)', '55', 'swipe-copy', ['S0']),
  m('139', '.swipe-action::after', '52', 'swipe-copy', ['S0']),
  m('140', '.swipe-actions>.swipe-action-danger', '53', 'swipe-copy-danger', ['S0']),
  m('141', ':root[data-theme=dark] .swipe-actions>.swipe-action-danger', '54', 'swipe-copy-danger', ['S0d']),
  m('142', '.swipe-row.swipe-open', '57', 'first-activity-card', ['S5']),
  m('143', '.swipe-row.swipe-open>.swipe-actions', '50, 58@≤760', 'first-activity-panel', ['S5']),
  m('144', '.swipe-row.swipe-open>.swipe-toggle', '60', 'first-activity-toggle', ['S5']),
  m('145', '.swipe-row.swipe-dragging>:not(.swipe-actions):not(.swipe-toggle)', '58@≤760', 'first-activity-content', ['S6']),
  m('146', '.swipe-row.swipe-dragging>.swipe-actions', '58@≤760', 'first-activity-panel', ['S6']),
  m('147', '.swipe-row.swipe-settling>:not(.swipe-actions):not(.swipe-toggle)', '58@≤760', 'first-activity-content', ['S7']),
  u('U1', '.schedule-bar>.button', '9, 18@≤480, 21@≤480, 222@≤600', "Bun's 「新增一站」 was removed by trip-planning-workflow-enhance Requirement 1.6. LM_Web's 「＋自訂活動」 stays in the activities heading, where entry 39 styles it."),
  u('U2', '.departure-vehicle-top>.icon-button', '203', "Bun's own template puts these buttons inside `.vehicle-swipe-actions`, so this selector matches nothing in Bun either."),
  u('U3', '.departure-vehicle-name[data-person-color=unassigned]>.icon', '214', 'LM_Web colors the icon with an inline `--assignee-color` from the vehicle color. There is no unassigned state.'),
  u('U4', '.activity-vehicle-choices[hidden]', '261', 'LM_Web removes the choices fieldset instead of hiding it.'),
  u('U5', '.avatar.small', '6', 'The Planner_Body has no small avatars.'),
  u('U6', '.tag.paper', '9', 'The Planner_Body has no paper tags.'),
  u('U7', '.section-title>.button .icon', '18@≤480', "「複製文字」 has no icon. Bun's template had no button there."),
  u('U8', '.notice', '10, 18@≤480, 31', 'Editing_Notice appears only while a second account edits the same item. The single-account fixture never shows it.'),
  u('U8', '.notice>.icon', '10', 'Editing_Notice appears only while a second account edits the same item. The single-account fixture never shows it.'),
  u('U9', '.field select:disabled', '95', 'No planner select is ever disabled.'),
  u('U10', '.field select#gear-preset', '253@forced', 'The `#gear-preset` select exists only in the gear form.'),
  u('U11', '.vehicle-card .help', '11', 'LM_Web vehicle cards have no departure-line paragraph. Routes replaced the vehicle meeting point.'),
  u('U11', '.vehicle-card .help .map-link', '247', 'LM_Web vehicle cards have no departure-line paragraph. Routes replaced the vehicle meeting point.'),
  u('U12', '.shopping-row .icon-button', '35', 'Unassigned rows are read-only. They have no buttons, no checkbox and no hidden children.'),
  u('U12', '.shopping-row>.icon-button', '43@≤480, 71@≤580', 'Unassigned rows are read-only. They have no buttons, no checkbox and no hidden children.'),
  u('U12', '.shopping-row>label input', '43@≤480', 'Unassigned rows are read-only. They have no buttons, no checkbox and no hidden children.'),
  u('U12', '.shopping-row>[hidden]', '70', 'Unassigned rows are read-only. They have no buttons, no checkbox and no hidden children.'),
];

/**
 * The evaluated selector (design 6.4): user-action pseudo-classes and pseudo-elements removed;
 * structural pseudo-classes (`:not()`, `:empty`, `:last-child`, `:disabled`) stay.
 */
export function evaluatedSelector(selector) {
  return selector
    .replace(/::?(?:-webkit-progress-value|after|before)(?![\w-])/g, '')
    .replace(/:(?:hover|focus-visible|focus|active)(?![\w-])/g, '');
}

// ── In-page helpers (serialized by rolesScript; keep them self-contained) ──

function all(root, selector) {
  return root ? Array.from(root.querySelectorAll(selector)) : [];
}
function kids(element, tag) {
  return element ? Array.from(element.children).filter((child) => !tag || child.localName === tag) : [];
}
function words(element) {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}
function flat(list, pick) {
  return uniq(list.flatMap(pick));
}
function byId(root, id) {
  return id ? root.ownerDocument.getElementById(id) : null;
}
function sectionOf(root, titleId) {
  return root.querySelector(`section[aria-labelledby="${titleId}"]`);
}
function gridAfter(root, heading) {
  const h3 = kids(sectionOf(root, 'places-cars-title'), 'h3').find((el) => words(el) === heading);
  return h3?.nextElementSibling ?? null;
}
function isPanel(element) {
  return element.getAttribute('role') === 'group' && element.getAttribute('aria-label') === '滑動操作';
}
function isToggle(element) {
  return element.localName === 'button' && element.getAttribute('aria-label') === '顯示編輯與刪除操作';
}
function label(element) {
  return element.getAttribute('aria-label') ?? '';
}

const HELPERS = [all, kids, words, uniq, flat, byId, sectionOf, gridAfter, isPanel, isToggle, label];

/** Section title ids of the Planner_Body's `.vehicle-departures` sections (entry 33). */
const PLANNER_SECTION_IDS = ['day-settings-title', 'day-routes-title', 'day-activities-title', 'day-meals-title',
  'places-cars-title', 'unassigned-shopping-title'];

/** @type {Record<string, (root: Element) => Element[]>} */
export const ROLES = {
  // ── Workspace and sidebar ──
  'workspace': (root) => uniq([root.ownerDocument.querySelector('nav[aria-label="旅行內容"]')?.nextElementSibling]),
  'workspace-main': (root) => all(root, ':scope > section[aria-label="行程表"]'),
  'sidebar': (root) => all(root, ':scope > aside'),
  'crew-panel': (root) => all(root, ':scope > aside > section').slice(0, 1),
  'crew-eyebrow': (root) => all(root, 'aside span').filter((el) => words(el) === 'OUR TRAVEL CREW'),
  'crew-heading': (root) => all(root, 'aside h2').filter((el) => words(el) === '小隊準備好了嗎？'),
  'crew-summary': (root) => all(root, 'aside p').filter((el) => words(el).endsWith('位旅伴，一起收集回憶。')),
  'checklist-link': (root) => all(root, 'aside a').filter((el) => words(el) === '看看我的行前清單'),
  'sidebar-avatar': (root) => all(root, 'aside > section > div > span[aria-label]'),
  'avatar-row': (root) => uniq(ROLES['sidebar-avatar'](root).map((el) => el.parentElement)),
  'progress-label-row': (root) => all(root, 'aside > section > div')
    .filter((el) => ['食材採買', '裝備準備'].includes(words(el.firstElementChild))),
  'progress-count': (root) => flat(ROLES['progress-label-row'](root), (row) => all(row, 'b')),
  'progress-total': (root) => flat(ROLES['progress-label-row'](root), (row) => all(row, 'b > span')),
  'gear-progress': (root) => all(root, 'progress[aria-label="裝備準備進度"]'),
  'unassigned-gear-button': (root) => all(root, 'aside button').filter((el) => words(el).includes('項裝備還在等主人')),
  'unassigned-gear-icon': (root) => flat(ROLES['unassigned-gear-button'](root), (button) => all(button, 'svg')),
  'unassigned-gear-arrow': (root) => ROLES['unassigned-gear-button'](root)
    .map((button) => button.lastElementChild).filter((el) => el?.localName === 'svg'),
  'side-footnote': (root) => all(root, 'aside > div').filter((el) => words(el).includes('把垃圾帶走，把風景留下。')),
  'side-footnote-icon': (root) => flat(ROLES['side-footnote'](root), (el) => all(el, 'svg')),

  // ── Section titles and the day picker ──
  'section-title-heading': (root) => uniq(['schedule-plan-title', 'itinerary-text-title'].map((id) => byId(root, id))),
  'section-title-row': (root) => uniq(ROLES['section-title-heading'](root).map((h2) => h2.parentElement?.parentElement)),
  'section-title-eyebrow': (root) => uniq(ROLES['section-title-heading'](root).map((h2) => h2.previousElementSibling)),
  'copy-text-button': (root) => all(sectionOf(root, 'itinerary-text-title'), 'button')
    .filter((el) => ['複製文字', '已複製', '複製失敗'].includes(words(el))),
  'day-picker': (root) => all(root, '[role="group"][aria-label="選擇行程日期"]'),
  'day-picker-row': (root) => uniq(ROLES['day-picker'](root).map((el) => el.parentElement)),
  'day-button': (root) => flat(ROLES['day-picker'](root), (group) => kids(group, 'button')),
  'selected-day-button': (root) => ROLES['day-button'](root).filter((el) => el.getAttribute('aria-pressed') === 'true'),
  'day-button-ordinal': (root) => flat(ROLES['day-button'](root), (el) => kids(el, 'small')),
  'day-button-date': (root) => flat(ROLES['day-button'](root), (el) => kids(el, 'b')),
  'day-button-weekday': (root) => flat(ROLES['day-button'](root), (el) => kids(el, 'span')),

  // ── Planner sections (「這一天的設定」, routes, activities, meals, 地點與車, unassigned shopping) ──
  'planner-section': (root) => uniq(PLANNER_SECTION_IDS.map((id) => sectionOf(root, id))),
  'planner-section-title': (root) => uniq(PLANNER_SECTION_IDS.map((id) => byId(root, id))),
  'planner-section-title-block': (root) => uniq(ROLES['planner-section-title'](root).map((h2) => h2.parentElement)),
  'planner-section-heading': (root) => uniq(ROLES['planner-section-title'](root).map((h2) => h2.parentElement?.parentElement)),
  'planner-section-eyebrow': (root) => uniq(ROLES['planner-section-title'](root).map((h2) => h2.previousElementSibling)),
  'planner-section-count': (root) => flat(ROLES['planner-section-title'](root), (h2) => kids(h2, 'span')),
  'planner-section-button': (root) => flat(ROLES['planner-section-heading'](root), (row) => kids(row, 'button')),
  'planner-section-help': (root) => flat(ROLES['planner-section'](root), (section) => kids(section, 'p')),

  // ── Day settings, route cards, place rows and schedule vehicle cards ──
  'day-setting-summary': (root) => kids(sectionOf(root, 'day-settings-title'), 'div')
    .filter((el) => kids(el, 'dl').length > 0),
  'route-card': (root) => all(sectionOf(root, 'day-routes-title'), 'article'),
  'place-row': (root) => kids(gridAfter(root, '地點'), 'article'),
  'schedule-vehicle-card': (root) => kids(gridAfter(root, '車輛'), 'article'),
  'card-grid': (root) => uniq([...ROLES['route-card'](root), ...ROLES['place-row'](root),
    ...ROLES['schedule-vehicle-card'](root)].map((el) => el.parentElement)),
  'no-routes-message': (root) => kids(sectionOf(root, 'day-routes-title'), 'div')
    .filter((el) => words(el) === '這一天還沒有路線。'),
  'departure-card': (root) => uniq([...ROLES['day-setting-summary'](root), ...ROLES['route-card'](root),
    ...ROLES['place-row'](root)]),
  'departure-card-list': (root) => flat([...ROLES['day-setting-summary'](root), ...ROLES['route-card'](root)],
    (el) => all(el, 'dl')),
  'departure-card-list-row': (root) => flat(ROLES['departure-card-list'](root), (dl) => kids(dl, 'div')),
  'departure-card-term': (root) => flat(ROLES['departure-card-list'](root), (dl) => all(dl, 'dt')),
  'departure-card-value': (root) => flat(ROLES['departure-card-list'](root), (dl) => all(dl, 'dd')),
  'card-top-row': (root) => flat([...ROLES['route-card'](root), ...ROLES['place-row'](root)],
    (card) => kids(card, 'div').filter((el) => el.querySelector(':scope > div > h3'))),
  // Vehicle cards reuse the name block (`VehicleCard` in vehicle_form.rs), so they are targets too.
  'card-name-block': (root) => flat([...ROLES['route-card'](root), ...ROLES['place-row'](root),
    ...ROLES['schedule-vehicle-card'](root)], (card) => all(card, 'h3').map((h3) => h3.parentElement)),
  'card-name-icon': (root) => flat(ROLES['card-name-block'](root), (el) => kids(el, 'svg')),
  'card-name': (root) => flat(ROLES['card-name-block'](root), (el) => kids(el, 'h3')),
  // Originals keep `data-row-action`; the Swipe_Panel copies do not.
  'card-actions': (root) => flat([...ROLES['route-card'](root), ...ROLES['place-row'](root)],
    (card) => all(card, '[data-row-action]').map((el) => el.parentElement)),
  'route-departure-time': (root) => flat(ROLES['route-card'](root), (card) => all(card, 'time')),
  'route-departure-row': (root) => uniq(ROLES['route-departure-time'](root).map((el) => el.parentElement)),
  'route-departure-label': (root) => flat(ROLES['route-departure-row'](root),
    (row) => kids(row, 'span').filter((el) => words(el) === '出發')),
  'route-endpoints': (root) => flat(ROLES['route-card'](root), (card) => kids(card, 'p').filter((el) => words(el).includes('→'))),
  'route-endpoints-icon': (root) => flat(ROLES['route-endpoints'](root), (el) => kids(el, 'svg')),

  // ── Activities ──
  'activity-presets': (root) => all(sectionOf(root, 'day-activities-title'), 'fieldset')
    .filter((el) => words(el.querySelector(':scope > legend')) === '常用活動'),
  'preset-label': (root) => flat(ROLES['activity-presets'](root), (el) => kids(el, 'label')),
  'preset-checkbox': (root) => flat(ROLES['preset-label'](root), (el) => all(el, 'input')),
  'preset-text': (root) => flat(ROLES['preset-label'](root), (el) => kids(el, 'span')),
  'preset-title': (root) => flat(ROLES['preset-label'](root), (el) => all(el, 'strong')),
  'preset-kind': (root) => flat(ROLES['preset-label'](root), (el) => all(el, 'small')),
  'activity-list': (root) => {
    const title = byId(root, 'day-activities-title');
    return kids(sectionOf(root, 'day-activities-title'), 'div').filter((el) => !el.contains(title));
  },
  'activity-card': (root) => all(sectionOf(root, 'day-activities-title'), 'article'),
  'done-checkbox': (root) => flat(ROLES['activity-card'](root),
    (card) => all(card, 'input[type="checkbox"]').filter((el) => label(el).endsWith('已完成'))),
  'done-check': (root) => uniq(ROLES['done-checkbox'](root).map((el) => el.closest('label'))),
  'done-activity-card': (root) => ROLES['activity-card'](root)
    .filter((card) => ROLES['done-checkbox'](root).some((input) => input.checked && card.contains(input))),
  'done-activity-title': (root) => flat(ROLES['done-activity-card'](root), (card) => kids(card, 'h3')),
  'activity-title': (root) => flat(ROLES['activity-card'](root), (card) => kids(card, 'h3')),
  'activity-note': (root) => flat(ROLES['activity-card'](root), (card) => kids(card, 'p')),
  'activity-stamp': (root) => flat(ROLES['activity-card'](root), (card) => kids(card, 'span')),
  'activity-stamp-icon': (root) => flat(ROLES['activity-stamp'](root), (el) => all(el, 'svg')),
  'activity-top-row': (root) => flat(ROLES['activity-card'](root),
    (card) => kids(card, 'div').filter((el) => kids(el, 'time').length > 0)),
  'activity-time': (root) => flat(ROLES['activity-top-row'](root), (row) => all(row, 'time')),
  // Activity kind tags, and the 「已買」 tag of purchased unassigned items.
  'kind-tag': (root) => uniq([...ROLES['activity-top-row'](root).flatMap((row) => kids(row, 'span')),
    ...ROLES['unassigned-row'](root).flatMap((row) => kids(row, 'span').filter((el) => words(el) === '已買'))]),
  'activity-actions': (root) => flat(ROLES['activity-card'](root),
    (card) => all(card, '[data-row-action]').map((el) => el.parentElement)),
  // Includes the Swipe_Panel copies, which keep the original's classes and `aria-label`.
  'activity-edit-button': (root) => flat(ROLES['activity-card'](root),
    (card) => all(card, 'button').filter((el) => label(el).startsWith('編輯 '))),
  'map-link': (root) => all(root, 'a[aria-label^="在 Google Maps 開啟"]'),
  'map-link-icon': (root) => flat(ROLES['map-link'](root), (el) => all(el, 'svg')),
  'activity-location': (root) => flat(ROLES['activity-card'](root),
    (card) => kids(card, 'div').filter((el) => el.querySelector(':scope > a[aria-label^="在 Google Maps 開啟"]'))),
  'activity-location-icon': (root) => flat(ROLES['activity-location'](root), (el) => kids(el, 'svg')),
  'activity-bottom-row': (root) => flat(ROLES['activity-card'](root),
    (card) => kids(card, 'div').filter((el) => el.querySelector(':scope > label > input[type="checkbox"]'))),
  'activity-participants': (root) => flat(ROLES['activity-bottom-row'](root), (row) => kids(row, 'span')),
  'activity-participant-icon': (root) => flat(ROLES['activity-participants'](root), (el) => kids(el, 'svg')),
  'activity-participant-text': (root) => flat(ROLES['activity-participants'](root), (el) => kids(el, 'span')),
  'empty-day': (root) => flat(ROLES['activity-list'](root),
    (list) => kids(list, 'div').filter((el) => words(el.querySelector(':scope > h3')) === '這一天，留給新的故事。')),
  'empty-day-icon': (root) => flat(ROLES['empty-day'](root), (el) => kids(el, 'svg')),
  'empty-day-heading': (root) => flat(ROLES['empty-day'](root), (el) => kids(el, 'h3')),
  'empty-day-hint': (root) => flat(ROLES['empty-day'](root), (el) => kids(el, 'p')),

  // ── Meals ──
  'meal-list': (root) => all(sectionOf(root, 'day-meals-title'), 'ul'),
  'meal-row': (root) => flat(ROLES['meal-list'](root), (ul) => kids(ul, 'li')),
  'meal-time': (root) => flat(ROLES['meal-list'](root), (ul) => all(ul, 'time')),
  'meal-title': (root) => flat(ROLES['meal-list'](root), (ul) => all(ul, 'b')),

  // ── Fields and forms ──
  // Meal-time labels, and every form label that wraps its control.
  'field-label': (root) => uniq([...ROLES['meal-row'](root).flatMap((li) => kids(li, 'label')),
    ...all(root, 'form label').filter((el) => el.querySelector(':scope > input, :scope > select, :scope > textarea'))]),
  'field-caption': (root) => flat(ROLES['field-label'](root), (el) => kids(el, 'span')),
  'field-input': (root) => flat(ROLES['field-label'](root), (el) => all(el, 'input')),
  'field-select': (root) => flat(ROLES['field-label'](root), (el) => all(el, 'select')),
  'field-textarea': (root) => flat(ROLES['field-label'](root), (el) => all(el, 'textarea')),
  'wide-field': (root) => ROLES['field-label'](root)
    .filter((el) => el.closest('form') && ['活動名稱', '備註', '這一站誰參加'].includes(words(kids(el, 'span')[0]))),
  'form-grid': (root) => all(root, 'form > fieldset > div').filter((el) => kids(el, 'label').length > 0),
  'form-action-button': (root) => all(root, 'button')
    .filter((el) => /^加入 \d+ 個活動$/.test(words(el)) || ['取消', '儲存'].includes(words(el))),
  'form-action-row': (root) => uniq(ROLES['form-action-button'](root).map((el) => el.parentElement)),
  'remove-item-button': (root) => all(root, 'button').filter((el) => words(el) === '移除項目'),
  'form-error': (root) => all(root, 'p[role="alert"]'),
  // The message element that the 「地點名稱」 input names in `aria-describedby`.
  'place-name-error': (root) => uniq(ROLES['field-label'](root)
    .filter((el) => words(kids(el, 'span')[0]) === '地點名稱')
    .map((el) => byId(root, el.querySelector('input')?.getAttribute('aria-describedby')))),

  // ── Unassigned shopping ──
  'unassigned-list': (root) => {
    const title = byId(root, 'unassigned-shopping-title');
    return kids(sectionOf(root, 'unassigned-shopping-title'), 'div').filter((el) => !el.contains(title));
  },
  'unassigned-category': (root) => flat(ROLES['unassigned-list'](root), (el) => kids(el, 'section')),
  'unassigned-category-heading': (root) => flat(ROLES['unassigned-category'](root), (el) => kids(el, 'h3')),
  'unassigned-category-count': (root) => flat(ROLES['unassigned-category-heading'](root), (el) => kids(el, 'span')),
  'unassigned-row': (root) => flat(ROLES['unassigned-category'](root), (el) => kids(el, 'div')),
  'unassigned-row-after-first': (root) => ROLES['unassigned-row'](root)
    .filter((el) => el.previousElementSibling?.localName === 'div'),
  'unassigned-name-block': (root) => flat(ROLES['unassigned-row'](root), (row) => kids(row, 'label')),
  'unassigned-name-text': (root) => flat(ROLES['unassigned-name-block'](root), (el) => kids(el, 'span')),
  'unassigned-name': (root) => flat(ROLES['unassigned-row'](root), (row) => all(row, 'b')),
  'unassigned-reason': (root) => flat(ROLES['unassigned-row'](root), (row) => all(row, 'small')),
  'unassigned-quantity': (root) => flat(ROLES['unassigned-row'](root),
    (row) => kids(row, 'span').filter((el) => words(el) !== '已買')),
  'purchased-row': (root) => ROLES['unassigned-row'](root)
    .filter((row) => kids(row, 'span').some((el) => words(el) === '已買')),
  'purchased-name': (root) => flat(ROLES['purchased-row'](root), (row) => all(row, 'b')),
  'purchased-name-block': (root) => flat(ROLES['purchased-row'](root), (row) => kids(row, 'label')),

  // ── Schedule vehicle cards ──
  'vehicle-title-row': (root) => flat(ROLES['schedule-vehicle-card'](root),
    (card) => kids(card, 'div').filter((el) => el.querySelector(':scope > div > h3'))),
  'vehicle-name': (root) => flat(ROLES['vehicle-title-row'](root), (row) => all(row, 'h3')),
  'vehicle-title-button': (root) => flat(ROLES['vehicle-title-row'](root), (row) => all(row, 'button')),
  'vehicle-summary': (root) => flat(ROLES['schedule-vehicle-card'](root), (card) => kids(card, 'p')),
  'vehicle-summary-separator': (root) => flat(ROLES['vehicle-summary'](root), (p) => all(p, 'span')),
  'passenger-row': (root) => uniq(ROLES['vehicle-summary'](root).map((p) => p.nextElementSibling)
    .filter((el) => el?.localName === 'div')),
  'passenger-chip': (root) => flat(ROLES['passenger-row'](root), (el) => kids(el, 'span')),

  // ── Swipe rows (by `data-swipe-row` and the ARIA names the Swipe_Controller gives the panel and toggle) ──
  'swipe-row': (root) => all(root, '[data-swipe-row]'),
  'swipe-panel': (root) => flat(ROLES['swipe-row'](root), (row) => kids(row).filter(isPanel)),
  'swipe-toggle': (root) => flat(ROLES['swipe-row'](root), (row) => kids(row).filter(isToggle)),
  'swipe-row-content': (root) => flat(ROLES['swipe-row'](root),
    (row) => kids(row).filter((el) => !isPanel(el) && !isToggle(el))),
  'swipe-copy': (root) => flat(ROLES['swipe-panel'](root), (panel) => kids(panel, 'button')),
  'swipe-copy-danger': (root) => ROLES['swipe-copy'](root)
    .filter((el) => ['刪除', '移除'].includes(el.getAttribute('data-swipe-label'))),
  'first-activity-card': (root) => ROLES['activity-card'](root).slice(0, 1),
  'first-activity-panel': (root) => flat(ROLES['first-activity-card'](root), (row) => kids(row).filter(isPanel)),
  'first-activity-toggle': (root) => flat(ROLES['first-activity-card'](root), (row) => kids(row).filter(isToggle)),
  'first-activity-content': (root) => flat(ROLES['first-activity-card'](root),
    (row) => kids(row).filter((el) => !isPanel(el) && !isToggle(el))),
};

/**
 * A JavaScript expression that evaluates, in the page, to an object with the same keys as ROLES.
 * Use it as `const roles = await page.evaluateHandle(rolesScript())`.
 */
export function rolesScript() {
  const helpers = HELPERS.map((fn) => fn.toString()).join('\n');
  const roles = Object.entries(ROLES).map(([name, fn]) => `${JSON.stringify(name)}: ${fn.toString()}`).join(',\n');
  return `(() => {\n${helpers}\nconst PLANNER_SECTION_IDS = ${JSON.stringify(PLANNER_SECTION_IDS)};\n`
    + `const ROLES = {\n${roles}\n};\nreturn ROLES;\n})()`;
}

/**
 * In-page: the elements matched by `selector` within `root`, including `root` itself (entry 1 is
 * `.workspace`). Serializable; pass it to `page.evaluate` or call it inside an evaluated function.
 */
export function queryWithin(root, selector) {
  return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
}

// ── States (design 6.4) ──

const ACTIVITIES = 'section[aria-labelledby="day-activities-title"]';
const DAY_BUTTONS = '[role="group"][aria-label="選擇行程日期"] > button';

function requireTouchLayout(page, state) {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width > 760) {
    throw new Error(`${state} needs Touch_Layout (the parity-mobile project); viewport is ${viewport?.width ?? '?'} px wide`);
  }
}

/** Waits until the schedule tab shows day 1 and every Schedule_Row has been prepared. */
async function loaded(page) {
  await page.locator('#schedule-plan-title').waitFor();
  await page.locator(`${ACTIVITIES} article`).first().waitFor({ state: 'attached' });
  try {
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-swipe-row]')];
      return rows.length > 0 && rows.every((row) => row.hasAttribute('data-swipe-ready'));
    }, null, { timeout: 10_000 });
  } catch {
    throw new Error('S0: the Swipe_Controller did not prepare every [data-swipe-row] within 10 s');
  }
}

async function selectDay(page, n) {
  const button = page.locator(DAY_BUTTONS, { hasText: `第 ${n} 天` });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.locator(`${DAY_BUTTONS}[aria-pressed="true"]`, { hasText: `第 ${n} 天` }).waitFor();
}

// Row_Actions are hidden in Touch_Layout ([data-swipe-original]), so they are activated with click().
async function activate(page, selector) {
  await page.locator(selector).evaluate((element) => element.click());
}

/** Synthetic touch drag of 30 px leftward on the first activity card's title (not interactive). */
async function dragFirstActivity(page, release) {
  await page.evaluate(({ activities, release }) => {
    const target = document.querySelector(`${activities} article > h3`);
    if (!target) throw new Error('the first activity card has no title to drag');
    const box = target.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const init = (clientX) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'touch',
      isPrimary: true, clientX, clientY: y });
    target.dispatchEvent(new PointerEvent('pointerdown', init(x)));
    target.dispatchEvent(new PointerEvent('pointermove', init(x - 30)));
    if (release) target.dispatchEvent(new PointerEvent('pointerup', init(x - 30)));
  }, { activities: ACTIVITIES, release });
}

/** @type {Record<string, (page: import('@playwright/test').Page) => Promise<void>>} */
export const STATES = {
  // Fixture loaded, 第 1 天 selected, no form open.
  S0: async (page) => {
    await loaded(page);
    await selectDay(page, 1);
  },
  S0d: async (page) => {
    await STATES.S0(page);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  },
  // 「編輯 搭帳・營地佈置」 clicked: the activity form is open.
  S1: async (page) => {
    await STATES.S0(page);
    await activate(page, 'button[data-row-action][aria-label="編輯 搭帳・營地佈置"]');
    await page.locator(`${ACTIVITIES} form`).filter({ has: page.getByRole('heading', { name: '編輯活動' }) }).waitFor();
  },
  // 「改名 出發地點 A」 submitted as 「出發地點 B」: the duplicate-name error is shown.
  S2: async (page) => {
    await STATES.S0(page);
    await activate(page, 'button[data-row-action][aria-label="改名 出發地點 A"]');
    const form = page.locator('section[aria-labelledby="places-cars-title"] form');
    await form.getByLabel('地點名稱').fill('出發地點 B');
    await form.evaluate((element) => element.requestSubmit());
    try {
      await page.waitForFunction(() => {
        const input = [...document.querySelectorAll('section[aria-labelledby="places-cars-title"] form input')]
          .find((el) => el.closest('label')?.textContent.includes('地點名稱'));
        const message = input && document.getElementById(input.getAttribute('aria-describedby') ?? '');
        return Boolean(message?.textContent.trim());
      }, null, { timeout: 5_000 });
    } catch {
      throw new Error('S2: no duplicate-name error appeared under 「地點名稱」');
    }
  },
  // 第 2 天 has no routes.
  S3: async (page) => {
    await STATES.S0(page);
    await selectDay(page, 2);
    await page.locator('section[aria-labelledby="day-routes-title"]').getByText('這一天還沒有路線。', { exact: true }).waitFor();
  },
  // 第 4 天 has no activities.
  S4: async (page) => {
    await STATES.S0(page);
    await selectDay(page, 4);
    await page.locator(ACTIVITIES).getByText('這一天，留給新的故事。', { exact: true }).waitFor();
  },
  // The first activity card's Swipe_Toggle clicked.
  S5: async (page) => {
    requireTouchLayout(page, 'S5');
    await STATES.S0(page);
    const toggle = page.locator(`${ACTIVITIES} article`).first().locator(':scope > button[aria-label="顯示編輯與刪除操作"]');
    // Activated with click(): the LM page is wider than the mobile viewport (the 「文字版」 <pre> does not
    // wrap), so the isMobile page is zoomed out and Playwright's pointer hit test misses the toggle.
    await toggle.evaluate((element) => element.click());
    await page.locator(`${ACTIVITIES} article`).first()
      .locator(':scope > button[aria-label="顯示編輯與刪除操作"][aria-expanded="true"]').waitFor({ state: 'attached' });
  },
  // Touch pointerdown and a 30 px leftward pointermove on the first activity card, not released.
  S6: async (page) => {
    requireTouchLayout(page, 'S6');
    await STATES.S0(page);
    await dragFirstActivity(page, false);
  },
  // S6 followed by pointerup, evaluated before the 320 ms settle fallback. The clock is paused so the
  // fallback timer cannot fire, and reduced motion removes the transform transition so no
  // `transitionend` ends the settle either.
  S7: async (page) => {
    requireTouchLayout(page, 'S7');
    await STATES.S0(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1_000);
    await dragFirstActivity(page, true);
  },
};
