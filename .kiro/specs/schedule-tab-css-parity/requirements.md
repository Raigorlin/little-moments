# Requirements Document

## Introduction

The Rust web client (`crates/web`, LM_Web) renders the Trip_Page schedule tab (`?tab=schedule`) differently from the Bun app (`src/`). This feature keeps the Rust form-based planner as the schedule tab body and styles it exactly the way Bun's `src/styles.css` styles the same classes. The Bun Story_Studio is not ported.

The work covers four areas:

- Restoring the rules that the Rust copy of `src/styles.css` dropped, and adding the static layout rules of `src/scene-motion.css` that the hero needs.
- Changing the page chrome emitted by `crates/web/src/pages/trip.rs` and `crates/web/src/app.rs` to the element structure and class names of the Bun page chrome.
- Renaming or restructuring the planner markup in `crates/web/src/views/schedule.rs` and `crates/web/src/views/schedule/{days,events,places,routes,shopping_plan,text}.rs` wherever it deviates from the class names and element structure that the selectors of `src/styles.css` target.
- Porting the mobile left-swipe rows from `src/mobile-swipe.js`.

Parity is verified in two ways. A Playwright screenshot comparison checks the page chrome of both apps at desktop and mobile widths in the light and dark themes, with the tab body excluded. A computed-style comparison checks the planner body by rendering the same LM_Web planner elements once against Bun's stylesheets and once against the Rust stylesheets.

Stylesheet differences found between `src/styles.css` (406 lines) and `crates/web/styles/styles.css` (387 lines). `diff` reports no other differences:

- The Rust file lacks the swipe-row rules (Bun lines 47–64, a comment followed by the rules).
- The Rust file drops `.vehicle-swipe-actions` from the `.activity-actions,.vehicle-swipe-actions,.gear-row-actions` rule (Bun line 65).
- The Rust file lacks the dark-theme `.motion-settings` rules (Bun line 210).
- The Rust file drops `.trip-menu .motion-settings` from the `margin-top:18px` rule (Bun line 281).

Bun builds its page stylesheet by concatenating `styles.css`, `accounts.css`, `scene-motion.css` and `storybook-host.css` in that order (`scripts/build.mjs` line 11), and adopts `expenses.css` when the expenses tab opens. The Bun hero renders `<div class="scene-motion illustration scene-motion--camp">` inside `.hero-art` (`src/app.js` line 226), and `src/scene-motion.css` positions the countdown inside that element. The LM_Web hero renders `<div class="illustration">` and loads no scene-motion rules. Because the page chrome must match Bun's classes, LM_Web adopts the `.scene-motion` wrapper and the static scene-motion layout rules. The scene-motion animation rules and the pause toggle stay out of scope.

`src/storybook-host.css`, the Patrick Hand font and every Story_Studio element are out of scope. The rules of `storybook-host.css` style only the Story_Studio host and the `story-schedule-page` and `story-schedule-layout` classes. While the Story_Studio editor is collapsed (its default state), those rules give the Bun page the standard 1220-pixel width and the standard 29-pixel section-tab margin that `src/styles.css` gives every other tab.

This feature overrides two clauses of rust-supabase-rewrite Requirement 32.7 for the schedule tab: the clause that deletes the swipe-gesture and scene-motion selectors from the copied stylesheets, and the clause that renders LM_Web only in the light theme. The user has accepted this override. The theme-toggle button stays out of scope.

## Glossary

- **LM_Web**: The Rust/Leptos web client in `crates/web`, served by Trunk at `http://127.0.0.1:8081` and proxying LM_Server at `127.0.0.1:8080`.
- **Bun_App**: The JavaScript app in `src/`, served by the Bun dev server at `http://127.0.0.1:5173`.
- **Schedule_Tab**: The Trip_Page content shown when the URL has `tab=schedule`, or has no valid `tab` value, together with the Page_Chrome around that content.
- **Page_Chrome**: The parts of the Trip_Page outside the tab body: the site header, the breadcrumb, the hero (including `.hero-art` and the countdown), the trip toolbar and the `.section-tabs` navigation element.
- **Planner_Body**: The LM_Web Schedule_Tab content below `.section-tabs`: the planner rendered by `crates/web/src/views/schedule.rs` and its child modules, together with the sidebar.
- **Story_Studio**: The Bun_App storybook schedule studio mounted into `#story-studio-mount` by `src/storybook-studio.js`. The Story_Studio is out of scope.
- **Bun_Styles**: The file `src/styles.css`.
- **Bun_Stylesheets**: `src/styles.css`, `src/accounts.css` and `src/scene-motion.css`, concatenated in that order as `scripts/build.mjs` does, followed by `src/expenses.css`.
- **Rust_Stylesheets**: The CSS files that `crates/web/index.html` loads through Trunk `data-trunk rel="css"` links, in link order.
- **Scene_Motion_Layout_Rules**: The four rules of `src/scene-motion.css` that set static layout: `.scene-motion{position:relative;display:block;line-height:0}`, `.hero-art>.scene-motion{position:relative}`, `.scene-motion>svg{width:100%}` and `.hero-art .scene-motion>.countdown{left:50%;top:50%;bottom:auto;transform:translate(-50%,-50%) rotate(-6deg);line-height:1.5;z-index:1}`.
- **Planner_Selector**: A selector in a rule of Bun_Styles that names a class which LM_Web renders, or must render under Requirement 3, in the Planner_Body. Examples are selectors containing `.schedule-bar`, `.date-tabs`, `.activity-card`, `.departure-vehicle`, `.vehicle-departures`, `.timeline`, `.event-list` or `.shopping-category`.
- **Selector_Map**: The table in the design document that pairs each Planner_Selector with the Planner_Body element that the selector is meant to style, and records any rename or restructure that LM_Web needs for the selector to match that element.
- **Schedule_Row**: A list row or card in the Planner_Body that contains at least one Row_Action, such as an activity card, a route card, a place row or a shopping-plan row.
- **Row_Action**: An edit or delete button inside a Schedule_Row.
- **Swipe_Controller**: The LM_Web module that prepares Schedule_Rows for left-swipe and handles the swipe gesture, ported from `src/mobile-swipe.js`.
- **Swipe_Panel**: The `.swipe-actions` element that Swipe_Controller appends to a Schedule_Row. The Swipe_Panel holds one `.swipe-action` copy of each Row_Action.
- **Swipe_Toggle**: The `.swipe-toggle` button that Swipe_Controller appends to a Schedule_Row to open or close the Swipe_Panel without a gesture.
- **Touch_Layout**: The state in which the viewport width is 760 CSS pixels or less, matching the media query `(max-width:760px)`.
- **End_Stop**: The open offset of a Schedule_Row: −68 CSS pixels multiplied by the number of `.swipe-action` buttons in the Swipe_Panel (the `--swipe-count` value).
- **Drag_Offset**: The horizontal translation written to the `--swipe-x` custom property of a Schedule_Row during a gesture.
- **Release_Velocity**: The horizontal pointer speed in CSS pixels per millisecond, measured over the final 100 ms before pointer release. Negative values mean leftward movement.
- **Reduced_Motion**: The state in which the media query `(prefers-reduced-motion:reduce)` matches.
- **Theme**: The value of the `data-theme` attribute on the root `<html>` element, either `light` or `dark`.
- **Viewport_Profile**: One of two browser configurations used for comparison. Desktop is 1280×900 CSS pixels. Mobile is 390×844 CSS pixels with touch enabled.
- **Comparison_Fixture**: One trip dataset, derived from `exampleTrip()` in `tests/fixtures/example-trip.js`, that is loaded into both Bun_App and LM_Server before comparison.
- **Chrome_Region**: The full-width page rectangle from the top of the document to the bottom edge of the `.section-tabs` element, with Masked_Areas filled. The Chrome_Region contains no Planner_Body or Story_Studio pixels.
- **Masked_Areas**: Page areas whose content depends on clock time, storage mode or the signed-in session, and which both apps fill with different text by design: the countdown digits, the `.sync-status` line, and Editor_Stack avatars.
- **Chrome_Comparison_Test**: The Playwright test that captures and compares the Chrome_Region of Bun_App and LM_Web.
- **Pixel_Diff_Ratio**: The fraction of pixels in the Chrome_Region whose color difference exceeds the Playwright per-pixel `threshold` of 0.2.
- **Planner_Snapshot**: The serialized DOM of the LM_Web Planner_Body for the Comparison_Fixture, captured from a running LM_Web page with scripts removed.
- **Key_Elements**: The Planner_Body elements whose computed styles the Style_Comparison_Check compares: every element matched by a Planner_Selector in the Selector_Map, every Schedule_Row, every Swipe_Panel and every Swipe_Toggle.
- **Compared_Properties**: The computed style properties `display`, `position`, `width`, `height`, `grid-template-columns`, `flex-direction`, `flex-wrap`, `align-items`, `justify-content`, `gap`, `margin`, `padding`, `font-family`, `font-size`, `font-weight`, `line-height`, `color`, `background-color`, `border`, `border-radius`, `box-shadow`, `overflow` and `visibility`.
- **Style_Comparison_Check**: The automated Playwright check that loads the same Planner_Snapshot into one static page that links Bun_Stylesheets and into one static page that links Rust_Stylesheets, and compares the Compared_Properties of each Key_Element between the two pages.

## Requirements

### Requirement 1: Stylesheet parity for the schedule tab

**User Story:** As a trip member, I want the Rust schedule tab to use the same CSS rules as the Bun app, so that colors, spacing and breakpoints match.

#### Acceptance Criteria

1. THE file `crates/web/styles/styles.css` SHALL have the same content as Bun_Styles.
2. THE Rust_Stylesheets SHALL contain the swipe-row rules of Bun_Styles lines 47–64, unchanged and at the same position relative to the neighboring rules of Bun_Styles.
3. THE Rust_Stylesheets SHALL contain the rule `.activity-actions,.vehicle-swipe-actions,.gear-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px}`.
4. THE Rust_Stylesheets SHALL contain the dark-theme rules `:root[data-theme=dark] .motion-settings{background:var(--card);border-color:var(--line);color:var(--ink)}` and `:root[data-theme=dark] .motion-settings p{color:var(--muted)}`.
5. THE Rust_Stylesheets SHALL contain the rule `.trip-menu .motion-settings,.trip-menu .data-tools,.trip-menu .event-section,.trip-menu .reset-area{margin-top:18px}`.
6. THE Rust_Stylesheets SHALL contain the Scene_Motion_Layout_Rules with the same selectors and declarations as `src/scene-motion.css`.
7. THE Rust_Stylesheets SHALL load the Scene_Motion_Layout_Rules after every rule of `crates/web/styles/styles.css` and `crates/web/styles/accounts.css`, matching the order in which Bun_Stylesheets place `scene-motion.css` after `styles.css` and `accounts.css`.
8. WHEN an automated check compares `crates/web/styles/styles.css` with Bun_Styles and compares the Rust_Stylesheets with the Scene_Motion_Layout_Rules, THE automated check SHALL list each rule that is missing, different or out of order in the Rust_Stylesheets and SHALL fail when the list is not empty.

### Requirement 2: Page chrome structure and class names

**User Story:** As a trip member, I want the page around the Rust schedule tab to have the same structure as the Bun page, so that the header, hero, toolbar and tab bar look the same in both apps.

#### Acceptance Criteria

1. WHEN the Schedule_Tab is rendered for the Comparison_Fixture, THE LM_Web SHALL produce, for the site header, the breadcrumb, the hero, the trip toolbar and the `.section-tabs` navigation element, the same element order, the same parent and child nesting and the same class names as Bun_App produces for the same trip, including the 「匯出手冊」 export button in the trip toolbar and the theme button in the site header. WHEN the 「匯出手冊」 button or the theme button is activated, THE LM_Web SHALL show a toast stating that the function is not available in this version, and SHALL make no other change.
2. THE LM_Web SHALL render the hero illustration inside `.hero-art` as a `div` with the classes `scene-motion illustration scene-motion--camp`, and SHALL place the `.countdown` element as a child of that `div` after the illustration SVG, matching `hero()` in `src/app.js`.
3. WHILE the Schedule_Tab is shown, THE LM_Web SHALL give the Trip_Page `main` element the class `page`.
4. WHILE the Schedule_Tab is shown, THE LM_Web SHALL place the Planner_Body directly after the `.section-tabs` navigation element.
5. WHEN the Page_Chrome markup changes, THE LM_Web SHALL keep the breadcrumb links, the countdown text required by rust-supabase-rewrite Requirement 32.3, the trip toolbar commands and the section-tab navigation working as before the change.

### Requirement 3: Planner body class names

**User Story:** As a trip member, I want the Rust planner to be styled by the same CSS selectors as in the Bun app, so that the planner's cards, tabs and lists look as Bun's stylesheet defines them.

#### Acceptance Criteria

1. THE design document SHALL contain the Selector_Map, listing every Planner_Selector of Bun_Styles with its target Planner_Body element.
2. WHEN the Schedule_Tab is rendered for the Comparison_Fixture, THE LM_Web SHALL render each Planner_Body element in the Selector_Map with the class names and the parent, child and sibling structure that the paired Planner_Selector requires to match that element.
3. WHERE an LM_Web Planner_Body element performs the role of an element that a Planner_Selector targets but carries a different class name or structure, THE LM_Web SHALL rename or restructure that LM_Web element to the class name and structure in the Planner_Selector.
4. WHEN an automated check runs `document.querySelectorAll` for each Planner_Selector of the Selector_Map in LM_Web for the Comparison_Fixture, THE automated check SHALL fail for each Planner_Selector listed in the Match entries of the Selector_Map that matches no element or matches an element other than the target in the Selector_Map, and for each Planner_Selector listed in the Unreachable entries of the Selector_Map that matches one or more elements.
5. THE LM_Web SHALL keep every schedule behavior required by rust-supabase-rewrite Requirements 22 and 31 after the markup change, including day selection, route cards, activities, the day's meals, places, vehicles, the unassigned shopping plan, the text version and 「複製文字」.
6. WHEN a Planner_Body class name changes, THE file `tests/schedule-bar.e2e.js` SHALL stay unchanged and SHALL pass.

### Requirement 4: Swipe row markup on the schedule tab

**User Story:** As a trip member on a phone, I want schedule rows to hide their edit and delete buttons behind a left swipe, so that rows have room for content, as in the Bun app.

#### Acceptance Criteria

1. THE LM_Web SHALL mark each Schedule_Row with the `data-swipe-row` attribute.
2. WHEN a Schedule_Row is added to the document, THE Swipe_Controller SHALL append to the Schedule_Row one Swipe_Panel with the class `swipe-actions` and `aria-hidden="true"`, containing one `button.swipe-action` copy of each Row_Action in the original order.
3. WHEN the Swipe_Controller creates a `.swipe-action` copy, THE Swipe_Controller SHALL set `data-swipe-label` to 「編輯」 for an edit Row_Action, to 「刪除」 for a Row_Action whose label contains 「移除」 or 「刪除」, and to 「操作」 for any other Row_Action, and SHALL keep the Row_Action's `aria-label` on the copy.
4. WHEN the Swipe_Controller creates a `.swipe-action` copy of a Row_Action that has the class `danger` or the label 「刪除」, THE Swipe_Controller SHALL add the class `swipe-action-danger` to the copy.
5. WHEN the Swipe_Controller prepares a Schedule_Row, THE Swipe_Controller SHALL set `data-swipe-original="true"` on each original Row_Action, set the inline `--swipe-count` property to the number of `.swipe-action` copies, add the class `swipe-row` and set `data-swipe-ready="true"`.
6. WHEN the Swipe_Controller prepares a Schedule_Row, THE Swipe_Controller SHALL append one Swipe_Toggle with `type="button"`, `aria-label="顯示編輯與刪除操作"`, `aria-expanded="false"` and the text 「‹」.
7. WHEN a `.swipe-action` copy is activated, THE LM_Web SHALL run the same command as the original Row_Action.
8. WHEN a Schedule_Row that already has `data-swipe-ready="true"` re-renders, THE Swipe_Controller SHALL keep exactly one Swipe_Panel and one Swipe_Toggle on that Schedule_Row.
9. WHEN the Row_Actions of a prepared Schedule_Row change, THE Swipe_Controller SHALL rebuild the Swipe_Panel so that the copies match the current Row_Actions and their enabled or disabled state.

### Requirement 5: Swipe gesture behavior

**User Story:** As a trip member on a phone, I want left-swipe on a schedule row to feel the same as in the Bun app, so that opening and closing row actions is predictable.

#### Acceptance Criteria

1. WHILE Touch_Layout applies, WHEN a `touch` or `pen` pointer goes down on a prepared Schedule_Row outside any `button`, `a`, `input`, `select`, `textarea` or `summary` element, THE Swipe_Controller SHALL start tracking a gesture for that Schedule_Row.
2. WHILE a gesture is tracked, THE Swipe_Controller SHALL resolve the axis as horizontal once the horizontal travel is at least 8 CSS pixels and at least 1.25 times the vertical travel, and as vertical once the vertical travel is at least 8 CSS pixels and more than 1.25 times the horizontal travel. After the first resolution, the Swipe_Controller SHALL keep the axis for the rest of the gesture.
3. WHEN the gesture axis resolves as vertical, THE Swipe_Controller SHALL stop tracking the gesture and leave page scrolling to the browser.
4. WHILE a horizontal gesture is tracked, THE Swipe_Controller SHALL add the class `swipe-dragging` and write the Drag_Offset to `--swipe-x` at most once per animation frame. The Drag_Offset SHALL stay between End_Stop − 48 CSS pixels and 0, so that the overshoot of 5.5 is included.
5. WHILE a horizontal gesture is tracked and Reduced_Motion does not apply, WHEN the pointer moves past End_Stop, THE Swipe_Controller SHALL render an overshoot of 0.3 times the distance past End_Stop, capped at 48 CSS pixels.
6. WHILE a horizontal gesture is tracked and Reduced_Motion applies, WHEN the pointer moves past End_Stop, THE Swipe_Controller SHALL hold the Drag_Offset at End_Stop.
7. WHEN the pointer is released with an absolute Release_Velocity of at least 0.35 CSS pixels per millisecond, THE Swipe_Controller SHALL open the Schedule_Row for a leftward velocity and close the Schedule_Row for a rightward velocity.
8. WHEN the pointer is released with an absolute Release_Velocity below 0.35 CSS pixels per millisecond, THE Swipe_Controller SHALL open the Schedule_Row when the absolute Drag_Offset is at least half of the absolute End_Stop, and close the Schedule_Row otherwise.
9. IF the Release_Velocity cannot be measured because the gesture has no movement samples, THEN THE Swipe_Controller SHALL keep the previous state unless the gesture axis, resolved from the total travel under the rule of 5.2 when no move resolved it, is horizontal. For a horizontal axis, THE Swipe_Controller SHALL open the Schedule_Row for a horizontal travel of −56 CSS pixels or less, close the Schedule_Row for a horizontal travel of 42 CSS pixels or more, and keep the previous state otherwise.
10. WHEN a Schedule_Row opens, THE Swipe_Controller SHALL add the class `swipe-open`, set `aria-hidden="false"` on the Swipe_Panel and set `aria-expanded="true"` on the Swipe_Toggle. WHEN a Schedule_Row closes, THE Swipe_Controller SHALL reverse those three changes.
11. WHEN a gesture settles, THE Swipe_Controller SHALL add the class `swipe-settling` and remove the class when the transform transition ends or 320 ms after the settle starts, whichever comes first.
12. WHEN a gesture resolved as horizontal, or moved 42 CSS pixels or more horizontally, ends, THE Swipe_Controller SHALL suppress the next click that occurs within 450 ms.
13. WHEN the Swipe_Toggle is activated, THE Swipe_Controller SHALL close every other open Schedule_Row and toggle the open state of the Swipe_Toggle's Schedule_Row.
14. WHEN a click occurs outside every Swipe_Panel and is not suppressed, THE Swipe_Controller SHALL close every open Schedule_Row.
15. WHEN the viewport leaves or enters Touch_Layout, THE Swipe_Controller SHALL abandon the gesture in flight, close every open Schedule_Row, and remove `swipe-dragging`, `swipe-settling` and the inline `--swipe-x` from every prepared Schedule_Row.
16. WHILE Touch_Layout does not apply, THE LM_Web SHALL show the original Row_Actions and hide every Swipe_Panel and Swipe_Toggle.
17. WHEN the Trip_Page unmounts, THE Swipe_Controller SHALL remove its event listeners and stop observing the document.

### Requirement 6: Dark theme rendering

**User Story:** As a trip member who uses the dark theme in the Bun app, I want the Rust schedule tab to render the same dark colors, so that both apps look alike in dark mode.

#### Acceptance Criteria

1. WHILE the Theme is `dark`, THE LM_Web SHALL apply every `:root[data-theme=dark]` rule of Bun_Stylesheets whose selector matches an element of the Schedule_Tab.
2. WHILE the Theme is `dark`, THE LM_Web SHALL render the `.swipe-action-danger` copies with background `#9d3e32` and text color `#fff`.
3. WHEN the page loads without a `data-theme` attribute on the root element, THE LM_Web SHALL render the Schedule_Tab in the light theme.

### Requirement 7: Parity verification

**User Story:** As the developer maintaining LM_Web, I want automated checks against Bun_App's styling, so that schedule tab parity is verified and regressions are caught.

#### Acceptance Criteria

1. THE Chrome_Comparison_Test SHALL load the Comparison_Fixture into Bun_App and into LM_Server, then open `?tab=schedule` for that trip in both apps.
2. THE Chrome_Comparison_Test SHALL capture the Chrome_Region of both apps for each of the four combinations of Viewport_Profile (desktop, mobile) and Theme (light, dark).
3. WHEN the Chrome_Comparison_Test sets the Theme, THE Chrome_Comparison_Test SHALL set the same `data-theme` value on the root element of both apps before the capture.
4. WHILE the Chrome_Comparison_Test captures, THE Chrome_Comparison_Test SHALL emulate Reduced_Motion, wait until all web fonts report loaded, and fill the Masked_Areas with a solid color in both captures.
5. WHILE the Chrome_Comparison_Test captures Bun_App, THE Chrome_Comparison_Test SHALL capture with the Story_Studio editor collapsed, so that the Bun page has the 1220-pixel maximum width and the 29-pixel `.section-tabs` bottom margin of the other tabs.
6. WHEN both captures for a combination are taken, THE Chrome_Comparison_Test SHALL pass the combination only if the captures have the same pixel dimensions and the Pixel_Diff_Ratio is 0.01 or less.
7. IF a Chrome_Comparison_Test combination fails, THEN THE Chrome_Comparison_Test SHALL save the Bun_App capture, the LM_Web capture and a diff image under the Playwright test output directory, and report the combination name and the Pixel_Diff_Ratio.
8. THE Style_Comparison_Check SHALL capture the Planner_Snapshot from LM_Web for the Comparison_Fixture and load the same Planner_Snapshot into a page that links Bun_Stylesheets and into a page that links Rust_Stylesheets, using the same `main.page` parent element in both pages.
9. THE Style_Comparison_Check SHALL compare the Compared_Properties of every Key_Element for each of the four combinations of Viewport_Profile and Theme.
10. WHEN the Style_Comparison_Check finds a Key_Element whose value for a Compared_Property differs between the two pages, THE Style_Comparison_Check SHALL fail and report the combination name, a selector path for the Key_Element, the Compared_Property, the Bun_Stylesheets value and the Rust_Stylesheets value.
11. WHILE the mobile Viewport_Profile applies, THE Chrome_Comparison_Test SHALL perform a left swipe on one Schedule_Row in LM_Web and verify that the Schedule_Row gains the class `swipe-open` and that the Swipe_Panel buttons are visible.
12. THE Chrome_Comparison_Test and the Style_Comparison_Check SHALL each be runnable as a single non-watch command and SHALL be registered in `playwright.config.js`.
