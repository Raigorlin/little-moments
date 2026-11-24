# Implementation Plan: schedule-tab-css-parity

## Overview

LM_Web (`crates/web`, Rust/Leptos) keeps its form-based planner on the Schedule_Tab and adopts Bun_App's CSS rules, page chrome structure and left-swipe rows. The work runs in this order: copy the stylesheets and add the rule-parity check, rebuild the Page_Chrome markup, mark up the planner rows, port `src/mobile-swipe.js` to `crates/web/src/swipe/`, and mount the Swipe_Controller on `.workspace`. The JavaScript test harness comes after that: the Comparison_Fixture, the executable Selector_Map, the chrome, style and selector Playwright checks, and the fast-check swipe properties. Rust code compiles on the native target so `cargo clippy --workspace` keeps passing.

The required checks are the ones that Requirements 1.8, 3.4 and 7 name as deliverables: the rule-parity test, the selector check, the Chrome_Comparison_Test and the Style_Comparison_Check. Property-based tests and the extra example tests are marked optional with `*`.

## Tasks

- [x] 1. Restore stylesheet parity
  - [x] 1.1 Copy Bun's stylesheets into LM_Web and fix the link order
    - Replace `crates/web/styles/styles.css` with a byte copy of `src/styles.css`. This restores Bun lines 47–64, `.vehicle-swipe-actions` at line 65, the dark `.motion-settings` rules at line 210 and `.trip-menu .motion-settings` at line 281
    - Create `crates/web/styles/scene-motion-layout.css` with the four Scene_Motion_Layout_Rules copied verbatim in Bun's order, plus a comment naming the source lines in `src/scene-motion.css`
    - In `crates/web/index.html`, set the `data-trunk rel="css"` link order to `styles.css`, `accounts.css`, `scene-motion-layout.css`, `expenses.css`, `presence.css`. Replace the "always light" comment with one that cites this feature's Requirement 6. Do not set `data-theme`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 6.1, 6.3_

  - [x] 1.2 Implement the CSS rule parser and parity checker
    - Create `tests/schedule-parity/support/css-rules.js` exporting `parseRules(text, file)` → `{file, index, media, selector, declarations}[]` and `checkParity(bunStyles, rustSheets)` → `{kind: 'missing'|'different'|'out-of-order', rule}[]`
    - `checkParity` compares `styles.css` rule by rule with Bun_Styles and checks that the Scene_Motion_Layout_Rules appear after every `styles.css` and `accounts.css` rule, in Bun's relative order
    - _Requirements: 1.8_

  - [x] 1.3 Write the stylesheet rule-parity test
    - Create `tests/schedule-css-parity.test.js` (`bun test`). Assert that `crates/web/styles/styles.css` is byte-identical to `src/styles.css`, and that `checkParity` returns an empty list for the Rust_Stylesheets read in `crates/web/index.html` link order. On failure, print every reported rule with its kind
    - **Property 1: Stylesheet rule parity**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**

  - [ ]* 1.4 Write property test for the parity checker
    - In `tests/schedule-css-parity.test.js`, use fast-check (`numRuns: 100`) with `fc.array(fc.oneof(remove, alterDecl, alterSelector, swap, moveSceneRuleEarly), {minLength: 1, maxLength: 5})` over the parsed real Rust_Stylesheets. Assert that every mutated rule is reported with the matching kind, and that the unmutated sheets report nothing
    - Tag: `// Feature: schedule-tab-css-parity, Property 2: The parity checker reports exactly the broken rules`
    - **Property 2: The parity checker reports exactly the broken rules**
    - **Validates: Requirements 1.8**

- [x] 2. Rebuild the Page_Chrome to Bun's structure
  - [x] 2.1 Add the header and toolbar icons
    - In `crates/web/src/views/icons.rs`, add `MOON`, `SUN` and `D_DOWNLOAD`, copied from the `icons` table in `src/app.js` lines 127–130
    - _Requirements: 2.1_

  - [x] 2.2 Add `HeaderKind` and `TripHeader` to the shell
    - In `crates/web/src/app.rs`, add `enum HeaderKind { Account (default), Trip }` and an optional `header` prop on `Shell`. `Account` renders the existing `Header`; `Trip` renders `TripHeader`
    - `TripHeader` emits Bun's `accountHeader()` tree: `header.topbar > .topbar-inner > (a.brand, .header-actions > (button.icon-button.header-theme, button.icon-button.header-menu-toggle > span.header-avatar-mark, #header-menu.header-collapse > (a.text-link.header-home, button.text-button.header-logout)))`. Omit `.header-admin`
    - The theme button reads root `data-theme` once at mount to pick the moon or sun icon and `aria-label`, and shows the toast 「這個版本還不能切換深色模式」 (Decision D1). The menu toggle drives `aria-expanded` and `.header-collapse.open`, and closes on an outside click outside `#header-menu, .header-menu-toggle`. 「登出」 uses the existing logout flow
    - _Requirements: 2.1, 2.5, 6.3_

  - [x] 2.3 Update the Trip_Page chrome in `pages/trip.rs`
    - Pass `header=HeaderKind::Trip` to `Shell`; keep `class="page"` on `main`
    - Change the hero `div.illustration` to `div.scene-motion.illustration.scene-motion--camp`, with the camp SVG first and `.countdown` after it
    - Add `button.button.quiet` 「匯出手冊」 (`D_DOWNLOAD` icon, `aria-label` and `title` 「匯出手冊」) as the first child of `.toolbar-actions`. It shows the toast 「這個版本還不能匯出手冊」 (Decision D1)
    - Add `data-tab=item.key()` to every section-tab button. Keep labels, icons, the badge, `aria-current` and the handlers
    - Keep `.workspace` directly after `.section-tabs`, and add a `NodeRef::<html::Div>` on it for task 4.6
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 3. Mark up the planner for Bun's selectors and swipe rows
  - [x] 3.1 Restructure the unassigned shopping row
    - In `crates/web/src/views/schedule/shopping_plan.rs` `unassigned_row`, change `div.shopping-row > span > (b, small)` to `div.shopping-row > label > span > (b, small.shopping-where.is-unrouted)`. The quantity span and the 「已買」 tag stay direct children of the row
    - _Requirements: 3.2, 3.3_

  - [x] 3.2 Make activity cards swipe rows
    - In `crates/web/src/views/schedule/events.rs` `ActivityCard`, replace `class=move || …` with `class="activity-card" class:done=move || done() && editing().is_none()`
    - Add `data-swipe-row` while not editing (`editing().is_none().then_some("")`), `data-row-action="edit"` on the edit button and `data-row-action="delete"` on the remove button
    - _Requirements: 3.2, 3.3, 4.1_

  - [x] 3.3 Make route cards swipe rows
    - In `crates/web/src/views/schedule/routes.rs` `RouteCard`, use `class="departure-vehicle" class:wide=move || editing().is_some()`, add `data-swipe-row` while not editing, and add `data-row-action` to the edit and delete buttons
    - _Requirements: 3.2, 3.3, 4.1_

  - [x] 3.4 Make place rows swipe rows
    - In `crates/web/src/views/schedule/places.rs` `PlaceRow`, apply the same pattern as `RouteCard`. The rename button gets `data-row-action="edit"` and the delete button `data-row-action="delete"`
    - _Requirements: 3.2, 3.3, 4.1_

  - [x] 3.5 Add the `swipe` prop to the vehicle list
    - In `crates/web/src/views/vehicle_form.rs`, add `#[prop(optional)] swipe: bool` to `VehicleList` and pass it to `VehicleCard`. When true, each `article.vehicle-card` gets `data-swipe-row` while not editing, and its edit and remove buttons get `data-row-action`
    - In `crates/web/src/views/schedule/places.rs` `PlacesAndCars`, pass `swipe=true`. The Trip_Menu call in `trip_menu.rs` stays unchanged
    - _Requirements: 3.2, 4.1_

- [x] 4. Port the Swipe_Controller
  - [x] 4.1 Create the swipe module skeleton and dependencies
    - Add `mod swipe;` to `crates/web/src/main.rs`
    - Create `crates/web/src/swipe/mod.rs` declaring `physics`, `rows` and `controller`, and re-exporting `SwipeController`. Create the three files with minimal compiling stubs that later tasks fill in
    - Add the web-sys features listed in design section 4.3 to `crates/web/Cargo.toml`
    - Code must compile on the native target for `cargo clippy --workspace`
    - _Requirements: 4.2, 5.1_

  - [x] 4.2 Implement `physics.rs`
    - Port the constants and pure functions of `src/mobile-swipe.js` line by line: `resolve_axis`, `track_offset`, `sample_velocity`, `release_velocity`, `prune_samples`, `resolve_release`, `should_suppress_click`, plus `swipe_label` and `is_danger`, with the `Axis`, `Sample`, `Release` and `ActionRole` types from design section 4.1. No `web_sys`
    - _Requirements: 4.3, 4.4, 5.2, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.12_

  - [ ]* 4.3 Write Rust example tests for `physics.rs`
    - Add `#[cfg(test)]` examples that pin Bun's constants and a few known outcomes (axis tie goes horizontal, rubber band capped at 48, reduced motion holds End_Stop, legacy open at −56 and close at 42, label mapping for 「編輯」「移除」「刪除」)
    - _Requirements: 4.3, 5.2, 5.5, 5.6, 5.9_

  - [x] 4.4 Implement `rows.rs`
    - Add the `ROW`, `ROW_ACTION` and `INTERACTIVE` selector constants and `ActionSpec { label, role, danger, disabled }`
    - Implement the idempotent `reconcile(root)` in the six steps of design section 4.2: un-prepare stale rows, collect Row_Actions outside `.swipe-actions`, rebuild the panel only when the copies differ, clone each copy keeping only `svg` children, keep exactly one `.swipe-actions` and one `.swipe-toggle`, set `data-swipe-original`, `--swipe-count`, `swipe-row` and `data-swipe-ready`. Write an attribute or class only when its value changes
    - Implement `unprepare(row)`, `set_open(row, open)` (toggles `swipe-open`, panel `aria-hidden` and toggle `aria-expanded` together) and `close_rows(root, except)`, which reads the rows from the DOM on each call
    - `web_sys` errors are treated as no match; never panic
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 5.10_

  - [x] 4.5 Implement `controller.rs`
    - Implement `SwipeController::mount(root)` with `State`, `Gesture`, `FrameWriter` and settle tracking as in design section 4.3. Run `reconcile`, observe `root` with the listed `MutationObserver` options, and reconcile once per batch
    - Register the listeners from the design table: `pointerdown` (capture), `pointermove` (capture, `passive: false`), `pointerup`, `pointercancel`, root `click` (capture: toggle, suppression window, copy delegation through `click()` on the original at `data-swipe-index`, outside-click close), and the `(max-width: 760px)` `change` handler
    - Settle batch in Bun's `settleGesture` order, with `swipe-settling` ended by a `transform` `transitionend` on a direct child or a 320 ms `gloo_timers` `Timeout`, whichever comes first
    - If `matchMedia` or `performance` is unavailable, prepare rows but register no gesture listeners
    - `Drop` disconnects the observer, removes every listener, abandons the gesture, ends every settle, and removes `swipe-dragging` and `--swipe-x`
    - _Requirements: 4.7, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15, 5.16, 5.17_

  - [x] 4.6 Mount the Swipe_Controller on the workspace
    - In `crates/web/src/pages/trip.rs` `TripLoaded`, mount `SwipeController` on the `.workspace` `NodeRef` from task 2.3 with an `Effect` and `StoredValue::new_local`, and drop it in `on_cleanup`, as shown in design section 4.3
    - _Requirements: 4.2, 5.17_

- [x] 5. Checkpoint - Ensure all tests pass
  - Run `cargo clippy --workspace`, `cargo test --workspace` and `bun test tests/schedule-css-parity.test.js`. Ensure all tests pass, ask the user if questions arise.

- [x] 6. Build the parity test harness
  - [x] 6.1 Register the parity Playwright projects
    - In `playwright.config.js`, add `testIgnore: 'schedule-parity/**'` to the `desktop` and `mobile` projects, and add `parity-desktop` (1280×900) and `parity-mobile` (390×844, `hasTouch`, `isMobile`) with `testDir: './tests/schedule-parity'`, `testMatch: '**/*.e2e.js'`, `deviceScaleFactor: 1` and `snapshotPathTemplate: 'test-results/schedule-parity-snapshots/{projectName}/{arg}{ext}'`
    - In `package.json`, add `"test:schedule-parity": "playwright test --project=parity-desktop --project=parity-mobile"`
    - _Requirements: 7.12_

  - [x] 6.2 Implement the Comparison_Fixture loaders
    - Create `tests/schedule-parity/support/fixture.js` with `comparisonFixture()` (the `exampleTrip()` changes in design section 6.1), `fakeBunAccount(page, state)` (routes `/api/session`, `GET /api/trips/qa-trip`, JSON 404 for other `/api/**`), and `loadLmTrip(request, state)` (signup, create trip, post `Command` JSON values, verify the snapshot entity counts, return the Trip_Page path and session)
    - Read `BUN_BASE_URL` and `LM_BASE_URL` with the design defaults, and export a `beforeAll` helper that fails with the unreachable URL
    - Failures report the command index, the response status and body, or the expected and actual counts
    - _Requirements: 7.1_

  - [x] 6.3 Implement the capture helpers
    - Create `tests/schedule-parity/support/capture.js` with `prepareCapture` (theme init script, Bun `ggc-local-theme` and `storybook-editor-hidden-v2` handling, reduced motion, fixed clock, font wait, Bun editor-collapsed and `.sync-status[hidden]` waits with a named failure), `chromeTree`, `chromeClip`, `plannerSnapshot` and `styleHarness`, as described in design sections 6.2 and 6.3
    - `styleHarness` serves `http://parity.test/` via `page.route`: `/bun/bun.css` (concatenated `styles.css`, `accounts.css`, `scene-motion.css`), `/bun/expenses.css`, `/rust/*.css` in `index.html` link order, and the fonts. Both pages use the same `main#main.page` parent
    - _Requirements: 7.3, 7.4, 7.5, 7.8_

  - [x] 6.4 Implement the executable Selector_Map
    - Create `tests/schedule-parity/support/selector-map.js` exporting `PLANNER_CLASSES`, `SHARED_CLASSES`, `ENTRIES` (entries 1–147 and U1–U12 of the design's Selector_Map, with `lines`, `role`, `states`, `status` and `reason`), `ROLES` (role queries by ARIA names, ids, headings, element types and text, never by the class under test) and `STATES` (S0–S7 from design section 6.4)
    - _Requirements: 3.1, 3.2, 3.4_

  - [ ]* 6.5 Write the Selector_Map completeness test
    - In `tests/schedule-css-parity.test.js`, split every Bun_Styles selector on commas, keep those whose classes (outside attribute selectors) are all in `PLANNER_CLASSES ∪ SHARED_CLASSES` with at least one Planner_Class, and assert each has an `ENTRIES` entry with the exact text
    - **Property 4: Selector_Map completeness**
    - **Validates: Requirements 3.1**

- [x] 7. Implement the parity checks
  - [x] 7.1 Write the Chrome_Comparison_Test
    - Create `tests/schedule-parity/chrome.e2e.js`. For each project and Theme (light, dark), open Bun_App and LM_Web in separate contexts, deep-compare `chromeTree` output, and assert `.hero-art>.scene-motion.illustration.scene-motion--camp>svg+.countdown`, `main#main.page` and `.section-tabs+.workspace` in LM_Web
    - Write the masked Bun capture to `testInfo.snapshotPath('chrome-{project}-{theme}.png')` and compare the LM capture with `toMatchSnapshot(name, { threshold: 0.2, maxDiffPixelRatio: 0.01 })`. The test title carries the combination name
    - Mobile: a CDP touch swipe (120 px leftward over 8 steps) on the first activity card; assert `swipe-open` and that every `.swipe-action` in its panel is visible
    - Desktop: Requirement 2.5 checks (tab clicks update `?tab=`, breadcrumb goes to the Home_Page, 「出發模式」 goes to `/go`, 「邀請旅伴」 opens the Trip_Menu, countdown shows 「距離出發」「19」「天」)
    - **Property 3: Page_Chrome structure equivalence**
    - **Property 14: Page_Chrome pixel parity**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 6.1, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.11**

  - [x] 7.2 Write the Style_Comparison_Check
    - Create `tests/schedule-parity/styles.e2e.js`. Capture the Planner_Snapshot in state S0, load it through `styleHarness` against Bun_Stylesheets and Rust_Stylesheets for each Theme, collect Key_Elements (Match entry selectors, `[data-swipe-row]`, `.swipe-actions`, `.swipe-toggle`, excluding `.editor-stack`), and compare the Compared_Properties with shorthands expanded to longhands
    - Report each difference as `{combination, path, property, bun, rust}`; a missing Rust element reports `<missing>`
    - Include the examples: dark `.swipe-action-danger` computes `rgb(157, 62, 50)` on `rgb(255, 255, 255)` text, and the live LM page without an init script has no `data-theme` and a `:root` background of `rgb(255, 252, 246)`
    - **Property 13: Planner computed-style parity**
    - **Validates: Requirements 6.1, 6.2, 6.3, 7.8, 7.9, 7.10**

  - [x] 7.3 Write the selector check
    - Create `tests/schedule-parity/selectors.e2e.js`. For each state in `STATES`, drive the state and evaluate each assigned entry inside `.workspace` with user-action pseudo-classes and pseudo-elements stripped. A Match entry needs at least one element and every element in its role set; an Unreachable entry needs zero. Failures report `{state, selector, matched, outside}`
    - Add the self-test with one wrong-role entry that must fail, and the Requirement 4.1 check that every element of the `activity-card`, `route-card`, `place-row` and `schedule-vehicle-card` roles has `data-swipe-row`
    - **Property 5: Selector_Map conformance**
    - **Validates: Requirements 3.2, 3.3, 3.4, 4.1**

  - [ ]* 7.4 Write the schedule behavior flows
    - In `tests/schedule-parity/selectors.e2e.js`, add one flow per behavior: switch days, edit and save a route, toggle 「完成」, change a meal time, add a place, read the unassigned list, check that the text version contains the Itinerary_Text, and press 「複製文字」
    - _Requirements: 3.5_

  - [ ]* 7.5 Write the swipe example tests
    - Create `tests/schedule-parity/swipe.e2e.js`: a 「編輯」 copy on a route card opens the route form and a 「刪除」 copy removes the route (mobile); at 1280 px every original Row_Action is visible and every panel and toggle has `display: none`; after navigating to the Home_Page, an injected `[data-swipe-row]` gets no panel and pointer events add no classes
    - _Requirements: 4.7, 5.16, 5.17_

- [ ] 8. Write the swipe property tests
  - [ ]* 8.1 Write property test for panel mirroring
    - Create `tests/schedule-parity/swipe-props.e2e.js` (mobile project, fast-check `numRuns: 100`, paused `page.clock`). Add helpers that inject `<article data-swipe-row>` rows with generated `data-row-action` buttons into `.workspace`, dispatch synthetic `PointerEvent`s and `MouseEvent`s, and record `--swipe-x` writes with a `MutationObserver`. Import the reference functions from `src/mobile-swipe.js`
    - Generate rows with 0–4 Row_Actions and 1–8 changes; after the observer settles, assert the panel, toggle, copy and row attributes listed in Property 6
    - Tag: `// Feature: schedule-tab-css-parity, Property 6: Swipe_Panel mirrors the Row_Actions`
    - **Property 6: Swipe_Panel mirrors the Row_Actions**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9**

  - [ ]* 8.2 Write property test for copy delegation
    - Assert that activating a copy delivers exactly one click to the enabled original at the same index and none to any other Row_Action; a disabled copy delivers none
    - **Property 7: Copy activation delegates to the original**
    - **Validates: Requirements 4.7**

  - [ ]* 8.3 Write property test for gesture outcomes
    - Generate pointer type, start target, start open state, 0–20 timed moves, release or cancel, Reduced_Motion and a 0–900 ms click delay. Compare tracked, `swipe-dragging` added, final open state and click suppression with the `src/mobile-swipe.js` reference
    - **Property 8: Gesture outcome matches the reference controller**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.7, 5.8, 5.9, 5.12**

  - [ ]* 8.4 Write property test for drag offset writes
    - For horizontal traces with random `runFor(16)` frame boundaries, assert at most one `--swipe-x` write per frame, each equal to `trackOffset` for the newest move and within `[End_Stop − 48, 0]`, and equal to End_Stop under Reduced_Motion past End_Stop
    - **Property 9: Drag offset writes**
    - **Validates: Requirements 5.4, 5.5, 5.6**

  - [ ]* 8.5 Write property test for open-state consistency
    - Generate two to four rows and 1–15 operations (gesture, toggle click, copy click, outside click). After each operation assert `swipe-open`, panel `aria-hidden` and toggle `aria-expanded` agree, at most one row is open, a toggle flips its row and closes the others, and an unsuppressed outside click closes all
    - **Property 10: Open state stays consistent**
    - **Validates: Requirements 5.10, 5.13, 5.14**

  - [ ]* 8.6 Write property test for settle timing
    - For completed traces, assert `swipe-settling` is present right after the end and gone after 320 ms; with Reduced_Motion, present after 319 ms and gone after 320 ms
    - **Property 11: Settling ends within 320 ms**
    - **Validates: Requirements 5.11**

  - [ ]* 8.7 Write property test for Touch_Layout changes
    - Run an operation prefix, optionally leave a gesture unfinished, then resize to 1280 px or back to 390 px. Assert no row has `swipe-open`, `swipe-dragging`, `swipe-settling` or an inline `--swipe-x`, and no later `--swipe-x` write occurs
    - **Property 12: Leaving or entering Touch_Layout resets every row**
    - **Validates: Requirements 5.15**

- [x] 9. Final checkpoint - Ensure all tests pass
  - Run `cargo clippy --workspace`, `cargo test --workspace`, `bun test tests/schedule-css-parity.test.js`, the existing `tests/schedule-bar.e2e.js` in its projects (Requirement 3.6), and `npm run test:schedule-parity` against manually started Bun_App, LM_Server and Trunk servers. Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. The required checks are the rule-parity test (1.3), the Chrome_Comparison_Test (7.1), the Style_Comparison_Check (7.2) and the selector check (7.3)
- The Playwright suites need Bun_App, LM_Server with Supabase, and Trunk running at `BUN_BASE_URL` and `LM_BASE_URL`. Start them manually; the tests do not start them
- `tests/schedule-bar.e2e.js` exercises Bun_App only and needs no edit (Decision D6)
- Each task references requirements for traceability; property tests carry the tag comment `// Feature: schedule-tab-css-parity, Property N: <title>`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "3.1", "3.2", "3.3", "3.4", "4.1"] },
    { "id": 1, "tasks": ["1.3", "2.2", "3.5", "4.2"] },
    { "id": 2, "tasks": ["1.4", "2.3", "4.3", "4.4"] },
    { "id": 3, "tasks": ["4.5"] },
    { "id": 4, "tasks": ["4.6"] },
    { "id": 5, "tasks": ["5"] },
    { "id": 6, "tasks": ["6.1", "6.2", "6.3", "6.4"] },
    { "id": 7, "tasks": ["6.5", "7.1", "7.2", "7.3", "7.5", "8.1"] },
    { "id": 8, "tasks": ["7.4", "8.2"] },
    { "id": 9, "tasks": ["8.3"] },
    { "id": 10, "tasks": ["8.4"] },
    { "id": 11, "tasks": ["8.5"] },
    { "id": 12, "tasks": ["8.6"] },
    { "id": 13, "tasks": ["8.7"] },
    { "id": 14, "tasks": ["9"] }
  ]
}
```
