# Implementation Plan: Remove Vehicle and Travel Settings Tabs

## Overview

Implementation is in JavaScript (ES modules, `bun test` for unit tests, Playwright for e2e). The work shrinks `TABS` to five entries and adds `resolveTab()`. It adds a pure `tripMenuEntries()` module, then moves the `crew()` and `settings()` content into a Trip_Menu drawer opened from a Menu_Button in the hero. The final step updates the e2e suite to reach relocated actions through the drawer. Stored data, `STORAGE_KEY`, and `src/mobile-swipe.js` do not change.

## Tasks

- [x] 1. Reduce section tabs and add tab resolution
  - [x] 1.1 Update `TABS` and add `resolveTab()` in `src/model.js`
    - Remove the `crew` and `settings` entries so `TABS` is schedule, meals, shopping, gear, expenses in that order
    - Export `resolveTab(value)` that returns `value` when it is a key in `TABS`, otherwise `'schedule'`
    - Leave `STORAGE_KEY` and the state schema unchanged
    - _Requirements: 1.1, 1.3, 4.1, 4.2, 5.1, 5.2, 5.3, 6.1_

  - [x] 1.2 Create `tests/trip-menu.test.js` with tab and storage example tests
    - Add seeded `mulberry32` and `forAll` helpers following `tests/mobile-swipe.test.js`
    - Test `TABS.map(([k]) => k)` equals `['schedule','meals','shopping','gear','expenses']`
    - Test `resolveTab('crew')` and `resolveTab('settings')` return `'schedule'`
    - Test `STORAGE_KEY` keeps its current value
    - _Requirements: 1.1, 1.3, 4.1, 5.1, 6.1, 7.2, 7.3_

  - [x] 1.3 Write property test for `resolveTab()`
    - **Property 1: Tab resolution is identity on Remaining_Tabs and schedule elsewhere**
    - Generator mixes the five keys, `crew`, `settings`, near misses (case, padding, prefixes), the empty string, and arbitrary strings; at least 100 iterations
    - **Validates: Requirements 4.1, 4.2**

- [x] 2. Add the pure Trip_Menu entries module
  - [x] 2.1 Create `src/trip-menu.js` with `tripMenuEntries(state, account)`
    - Return the `trip`, `people`, `addPerson`, `switchIdentity`, `vehicles`, `addVehicle`, `data`, `events`, and `reset` descriptors as specified in the design
    - `people[].canEdit` is `!!(perms?.canEdit && (perms.canManage || p.id === perms.personId))`
    - `vehicles[].canDelete` is `!account || perms?.canDelete === true`
    - `events` is `state.events.slice(0, 8)`
    - No DOM access, so the module loads under `bun test`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.10, 3.11, 6.2_

  - [x] 2.2 Write property test for person entries and add fixed-entry example test
    - **Property 2: Every person gets an entry, with edit rights matching the old crew tab**
    - Example: with `account = null`, entries include `trip-settings`, `person`, `profile`, `vehicle`, `export`, `import`, `print`, `reset`
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 3.10, 3.11**

  - [x] 2.3 Write property test for vehicle entries
    - **Property 3: Every vehicle gets an edit entry, and a delete entry exactly when deletion is allowed**
    - **Validates: Requirements 3.5, 3.6, 3.11**

  - [x] 2.4 Write property test for recent events
    - **Property 4: The menu shows the most recent events in stored order**
    - **Validates: Requirements 6.2**

- [x] 3. Move removed-tab content into the Trip_Menu in `src/app.js`
  - [x] 3.1 Remove the `crew` and `settings` tab rendering
    - Make `tab = resolveTab(tab);` the first statement of `trip()` so content and `aria-current="page"` both fall back to schedule
    - Drop the `crew` and `settings` branches of the content ternary; the final fallback is `schedule()`
    - Delete `crew()` and `settings()` once their markup is no longer referenced (keep the markup available for 3.2)
    - Update the four strings that name the removed tabs: `activityParticipationFields()`, `vehicleDepartureSection()`, the vehicle `editForm` help, and `privacy()`
    - _Requirements: 1.1, 1.2, 1.3, 4.1, 4.2, 4.3_

  - [x] 3.2 Add the Menu_Button and render `tripMenu()`
    - Add `let tripMenuOpen = false;`
    - In the non-compact branch of `hero()`, wrap the `<h1>` in `.trip-title-row` with the Menu_Button (`data-action="trip-menu"`, `data-focus="trip-menu-button"`, `aria-label="旅行選單"`, `aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls="trip-menu"` only while open)
    - Add a `menu` glyph to `icon()` if one does not exist
    - Implement `tripMenu()` from `tripMenuEntries(state, account)`: backdrop, `aside#trip-menu` with heading and close control, trip settings section, companions section with identity note, vehicles section, `sceneMotionSettings()`, data tools, recent events, and reset area
    - Reuse the `member-card`, `vehicle-card`, `map-link`, `passenger-list`, and `event-list` markup without `data-swipe-row`; escape all values with `e()`
    - Append `tripMenu()` inside `<main>` after the workspace when `tripMenuOpen` is true
    - _Requirements: 2.1, 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 6.2_

  - [x] 3.3 Wire open, close, Escape, and entry activation
    - Add `openTripMenu()` (focus `#trip-menu-title`) and `closeTripMenu()` (set `deferredFocus = 'trip-menu-button'`, re-render)
    - Register `actions['trip-menu']` as a toggle and `actions['close-trip-menu']`; add both to the `safe` list in `allowAccountAction`
    - In the main click handler, after the `allowAccountAction` check, close the menu before dispatching any other `data-action` inside `#trip-menu`
    - Add a keydown listener that closes the menu on Escape when the menu is open and `dialog.open` is false
    - Set `tripMenuOpen = false` on `[data-tab]` clicks and route changes
    - _Requirements: 2.3, 2.4, 2.5, 3.11_

- [x] 4. Style the Trip_Menu
  - [x] 4.1 Add drawer and title-row styles in `src/styles.css`
    - `.trip-title-row` flex row; `.trip-menu` right-side drawer (`max-width:420px`, full height, scrollable, below `#dialog`); bottom sheet at `max-width:760px` with `max-height:85vh`
    - `.trip-menu-backdrop` full-screen translucent layer
    - Single-column `.trip-menu .member-card` and `.trip-menu .vehicle-card`
    - Re-scope or remove rules that only targeted the removed panels (`.settings-panel` in `.workspace-main`, `.member-grid`, `.vehicles`)
    - Hide `.trip-menu` and `.trip-menu-backdrop` in `@media print`
    - _Requirements: 2.1_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Update the e2e suite for Trip_Menu navigation
  - [x] 6.1 Update existing flows in `tests/app.e2e.js`
    - Add the `openTripMenu` helper (`getByRole('button', { name: '旅行選單', exact: true })`)
    - Reset, edit trip, import, add companion, and switch identity flows open the menu instead of `nav(page,'crew')` / `nav(page,'settings')`
    - Planning-tabs loop and overflow loop drop `crew` and `settings`; check their headings and overflow inside the open drawer
    - Sticky-tabs test scrolls to `expenses` instead of `settings`
    - _Requirements: 7.1_

  - [x] 6.2 Update account e2e tests
    - In `tests/accounts.e2e.js` and `tests/account-identity.e2e.js`, reach 編輯旅行 through the menu
    - _Requirements: 7.1_

  - [x] 6.3 Update scene motion and daily-life e2e tests
    - In `tests/assignment-motion.e2e.js` and `tests/daily-life.e2e.js`, replace `.workspace-main .motion-settings` with `#trip-menu .motion-settings`, replace `nav(page,'settings')` with `openTripMenu(page)`, and open the menu before editing a companion
    - _Requirements: 3.9, 7.1_

  - [x] 6.4 Update vehicle and map e2e tests
    - In `tests/maps.e2e.js` and `tests/vehicle-departures.e2e.js`, run `.vehicle-card` checks inside the open drawer
    - In `tests/vehicle-itinerary.e2e.js`, expect 請先在「旅行選單」新增車輛
    - _Requirements: 3.5, 7.1_

  - [x] 6.5 Update avatar, ingredients, schedule-bar, and mobile-swipe e2e tests
    - In `tests/avatar-preview.e2e.js`, drop `crew` from the tab loop and check avatars inside the drawer
    - In `tests/ingredients.e2e.js` and `tests/schedule-bar.e2e.js`, reach settings steps through the menu
    - In `tests/mobile-swipe.e2e.js`, update the comment that mentions the crew tab
    - _Requirements: 7.1_

  - [x] 6.6 Add new Trip_Menu e2e cases to `tests/app.e2e.js`
    - Section tabs are exactly the five keys, numbered 01 to 05, with no `crew` or `settings` button
    - Menu_Button sits in `.trip-title-row`, has accessible name 旅行選單, toggles `aria-expanded`, and closes via the close control and Escape with focus back on the button
    - A seeded pre-change state shows the same people, vehicles, trip details, and events in the drawer, and the localStorage value is identical before and after opening and closing
    - In account mode as a non-owner member (in `tests/accounts.e2e.js`, which runs against the account server), no vehicle delete buttons appear, and the import button and `.reset-area` are absent from the drawer because `applyAccountChrome()` removes them as it did on the old settings tab; export and print remain
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 3.6, 3.11, 4.3, 6.1, 6.2, 7.2_

- [x] 7. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Task 1.2 is required because Requirements 7.2 and 7.3 call for those tests
- Tasks 1.2, 1.3, 2.2, 2.3, and 2.4 all write `tests/trip-menu.test.js`, so they run in separate waves
- Tasks 3.1, 3.2, and 3.3 all write `src/app.js`, so they run in separate waves
- `src/mobile-swipe.js` has no tab-level swipe code; Requirement 5 is satisfied by `TABS` alone

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "3.1"] },
    { "id": 2, "tasks": ["1.3", "3.2"] },
    { "id": 3, "tasks": ["2.2", "3.3"] },
    { "id": 4, "tasks": ["2.3", "6.1", "6.2", "6.3", "6.4", "6.5"] },
    { "id": 5, "tasks": ["2.4", "6.6"] }
  ]
}
```
