# Implementation Plan: mobile-smooth-swipe

## Overview

The work lands in four files: `src/mobile-swipe.js` (reworked from a release-only classifier into a tracked drag), `src/styles.css` (the swipe block, whose transition placement and `:not()` selector are both defective today), and two new test files.

The order follows the dependency chain in the design. The six exported pure functions carry all the physics and decision logic and need no DOM, so they land first and are verified by `bun test` before any wiring exists. The CSS contract lands next because the tracker produces no visible movement until `--swipe-x` is read by a transform rule. The impure tracker depends on both. Playwright verification of the real gesture comes last.

`tests/app.e2e.js` is not touched. Its synthetic `pointerdown`/`pointerup` pair with no intervening move must keep passing through the legacy fallback: `sampleVelocity` returns `null` below two samples, which routes `resolveRelease` into the 56px-open / 42px-close distance rule. Every task below preserves that path.

Language: vanilla JavaScript ES modules, no transpilation. Commands: `bun test`, `npx playwright test`, `bun scripts/build.mjs`, `bun scripts/serve.mjs`.

**Amendments, added mid-execution.** Task 3.2 (Amendment A) confirms in a browser that the Action_Panel paints over the Row_Surface, then clips the panel to the width the Row_Surface has uncovered. Task 3.3 (Amendment B) keeps the 新增一站 button on the date tabs' row at every width. Both edit only `src/styles.css`, and both verify in headless Chrome over CDP from a throwaway Bun script, because Node.js, npx and the Playwright runner are not installed. Neither starts a server; both use the one already running at `http://127.0.0.1:5173`. Task 6.8 adds `tests/schedule-bar.e2e.js`, which runs once Node is installed.

**Amendments C and D, added mid-execution.** Task 4.5 (Amendment C) measures the release velocity over the 100ms that end at the release, so a release after a pause settles by position, as on iOS. The release path then reaches `sampleVelocity` through `releaseVelocity`, which returns `null` only when no move was sampled, so the `tests/app.e2e.js` pair still takes the legacy rule. Tasks 2.13 and 6.9 test it. Task 3.4 (Amendment D) stops the date buttons shrinking below their content width above 600px, and task 6.10 adds that check to `tests/schedule-bar.e2e.js`. Tasks 4.5 and 3.4 verify in headless Chrome over CDP the way 3.2 and 3.3 do.

## Tasks

- [x] 1. Extract the gesture physics into exported pure functions in `src/mobile-swipe.js`
  - [x] 1.1 Add the constants table and the axis and offset functions
    - Add `ACTION_WIDTH` 68, `AXIS_BIAS` 1.25, `AXIS_DEADZONE` 8, `FLICK_THRESHOLD` 0.35, `VELOCITY_WINDOW` 100, `RUBBER_RESIST` 0.3, `RUBBER_MAX` 48, `SETTLE_MS` 260, `LEGACY_OPEN` 56, `LEGACY_CLOSE` 42, `CLICK_SUPPRESS_MS` 450; keep the existing `SWIPE_THRESHOLD`/`OPEN_THRESHOLD` values as the legacy constants
    - Export `resolveAxis(dx, dy, locked)` returning `'horizontal'`, `'vertical'`, or `null`, sticky once `locked` is non-null, with horizontal winning an exact tie so the two outcomes stay mutually exclusive
    - Export `trackOffset(startOffset, dx, endStop, reduced)` with the closed clamp at `0`, the 1:1 linear zone down to `endStop`, the `reduced` branch returning exactly `endStop`, and the rubber band returning `endStop - min(RUBBER_MAX, overshoot * RUBBER_RESIST)`
    - _Requirements: 1.2, 3.1, 3.2, 3.4, 3.5, 4.1, 4.2, 6.2, 6.3_

  - [x] 1.2 Add the release-decision functions
    - Export `sampleVelocity(samples, window)` returning px/ms over the final 100ms, and `null` for fewer than two samples or a zero-width window rather than dividing by zero
    - Export `resolveRelease({ offset, endStop, velocity, totalDx, totalDy, axis, wasOpen })` returning `true` for open: closed when `endStop` is falsy, the legacy 56/42 distance rule when `velocity === null`, direction when the velocity magnitude clears `FLICK_THRESHOLD`, and the halfway rule otherwise
    - Export `shouldSuppressClick(axis, totalDx)` returning true when the axis resolved to horizontal or the displacement magnitude reaches 42px
    - Keep `null` distinct from `0` in `sampleVelocity`: `0` would mean a measured stationary finger and would route into the halfway rule, breaking the legacy path
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.9, 3.3, 5.1, 5.2_

  - [x] 1.3 Add the per-frame coalescing writer
    - Export `createFrameWriter(write, raf, caf)` with `push`, `flushTarget`, and `cancel`, where the first `push` of a frame schedules the callback and later pushes overwrite the pending value
    - Accept `raf`/`caf` as injected parameters defaulting to `requestAnimationFrame`/`cancelAnimationFrame` so a unit test can drive it with a fake scheduler
    - _Requirements: 1.8_

- [x] 2. Cover the pure layer with `bun test` in `tests/mobile-swipe.test.js`
  - [x] 2.1 Create the test file and its deterministic generator
    - Create `tests/mobile-swipe.test.js` importing the exported functions from `../src/mobile-swipe.js`
    - Define a seeded `mulberry32` PRNG and a `forAll` helper that runs at least 200 iterations, and on failure prints the seed and the failing sample so a counterexample is reproducible
    - Add no property-based testing dependency; the repository has none and none is introduced
    - _Requirements: 1.2, 2.1, 4.1_

  - [x] 2.2 Write property test for `resolveAxis`
    - **Property 4: The axis lock is exclusive, dead-zoned, and sticky**
    - **Validates: Requirements 4.1, 4.2**

  - [x] 2.3 Write property test for linear tracking
    - **Property 1: Tracking is one-to-one inside the linear zone**
    - **Validates: Requirements 1.2, 1.3**

  - [x] 2.4 Write property test for offset bounds
    - **Property 2: The rendered offset never escapes its bounds**
    - **Validates: Requirements 1.2, 3.2, 3.4, 3.5**

  - [x] 2.5 Write property test for rubber-band resistance
    - **Property 3: Rubber-band resistance is proportional and capped**
    - **Validates: Requirements 3.1, 3.2**

  - [x] 2.6 Write property test for the reduced-motion branch of `trackOffset`
    - **Property 9: Reduced motion changes only the rubber band**
    - **Validates: Requirements 6.2, 6.3**

  - [x] 2.7 Write property test for `sampleVelocity`
    - **Property 5: Velocity depends only on the final 100ms and is undefined below two samples**
    - Add explicit zero-sample, one-sample, and identical-timestamp cases asserting `null`, since this is the hinge that keeps `tests/app.e2e.js` passing
    - **Validates: Requirements 2.1, 2.2, 5.1, 5.2**

  - [x] 2.8 Write property test for flick resolution
    - **Property 6: A flick resolves by direction regardless of distance**
    - **Validates: Requirements 2.1, 2.2**

  - [x] 2.9 Write property test for the halfway rule
    - **Property 7: Below the flick threshold the halfway rule decides**
    - **Validates: Requirements 2.3, 2.4, 3.3**

  - [x] 2.10 Write property test for the legacy distance rule
    - **Property 8: With no measurable velocity the legacy distance rule decides**
    - **Validates: Requirements 5.1, 5.2**

  - [x] 2.11 Write property test for click suppression
    - **Property 10: A gesture suppresses a click only after real travel**
    - **Validates: Requirements 2.9**

  - [x] 2.12 Write unit test for `createFrameWriter`
    - Drive a fake `raf`/`caf`: assert that many `push` calls between flushes produce exactly one `write` carrying the newest value, that `cancel` drops a pending write, and that `flushTarget` writes synchronously
    - This is the only verification of the one-write-per-frame contract, which no end-to-end assertion can observe
    - _Requirements: 1.8_

  - [x] 2.13 Write property test for `releaseVelocity`
    - **Property 11: The release velocity covers the 100ms that end at the release**
    - Add `releaseVelocity` to the import from `../src/mobile-swipe.js`. Reuse the file's `forAll` runner and the `VELOCITY_CLOCKS` timer models from the Property 5 section, so every clock coarsening is covered
    - Compute the expected value without calling `sampleVelocity`: the slope from the earliest sample in the 100ms before the release instant to the release, or 0 when no sample falls there
    - Add explicit cases: an empty trace gives `null`; one move followed by a release on the same timestamp gives `0`; a fast trace released more than 100ms after its last move gives `0`
    - Leave task 2.7's Property 5 tests unchanged
    - **Validates: Requirements 2.1, 2.2, 2.11, 5.1, 5.2**

- [x] 3. Fix the CSS contract in `src/styles.css`
  - [x] 3.1 Replace the two defective swipe rules with the `--swipe-x` surface contract
    - Delete `.swipe-row.swipe-open>:not(.swipe-actions){transform:...;transition:transform .22s ease}` and its reduced-motion companion
    - Declare `--swipe-x:0px` on `.swipe-row` and `--swipe-x:calc(var(--swipe-count)*-68px)` on `.swipe-row.swipe-open`
    - Inside `@media(max-width:760px)`, add the base surface rule `.swipe-row>:not(.swipe-actions):not(.swipe-toggle){transform:translateX(var(--swipe-x));transition:transform .26s cubic-bezier(.22,.61,.36,1)}` so the animation is symmetric in both directions and the toggle affordance stays put
    - Add `.swipe-dragging` (`transition:none;will-change:transform`, plus `visibility:visible;pointer-events:none` on the nested panel) and `.swipe-settling` (`will-change:transform`) inside the same media block, so no transform or compositor hint exists on desktop or at rest
    - Add the `prefers-reduced-motion:reduce` override that zeroes the transition, leaving inline tracking untouched
    - Use `translateX` rather than `translate3d` so an identity transform does not permanently promote every row child
    - _Requirements: 1.4, 1.5, 1.6, 2.5, 4.7, 6.1_

  - [x] 3.2 Clip the Action_Panel to the width the Row_Surface has uncovered
    - Confirm the defect first. Run `bun scripts/build.mjs`, then drive headless Chrome over CDP from a throwaway Bun script at 390px on `http://127.0.0.1:5173/demo/`, launched with a temporary `--user-data-dir` and its own debugging port. Drag the first activity card (two actions, End_Stop 136px) 20px left with synthetic touch `PointerEvent`s that include intermediate `pointermove`s, wait two frames, and hit-test 10px inside the panel's left edge; a panel button there confirms the defect
    - Hit-test with `pointer-events` set aside, as the design's "Hit-testing caveat for verification" describes: the dragging panel is `pointer-events:none`, so a plain `elementFromPoint` skips it and reports the defect as absent. As a control, a hit 2px inside the uncovered strip must return a panel button; if it does not, the harness is broken and the result is inconclusive
    - If the control passes and the defect does not reproduce, report the measurements and leave `src/styles.css` unchanged. Otherwise, before editing, record the open resting state: the panel and action-button rects, and `elementFromPoint` at each button's center
    - Apply the CSS block from the design's "Amendment A" to the swipe block in `src/styles.css`: the panel clip and its transitions, `transition-delay:0s` on the open state (never the `transition` shorthand), `transition:none` on the dragging panel, the panel added to the swipe reduced-motion selector list, and `outline-offset:-3px` on focused panel buttons. Leave every `pointer-events` and `visibility` declaration and the surface rules unchanged
    - Rebuild and verify the drag: at 20, 68 and 136px, a hit 2px inside the uncovered strip returns a panel button, a hit 2px outside it (where that point is still inside the panel box) returns a node outside the panel, and the panel width minus the computed `clip-path` left inset equals the surface `translateX` magnitude within 1px
    - Verify a settle to closed: hold the 20px drag still with same-position `pointermove`s for 120ms so the release velocity is 0, release, and sample every frame for 400ms. The panel's `visibility` stays `visible` through 230ms and is `hidden` from 320ms, and its visible width tracks the surface translation within 1px
    - Verify that toggle open, toggle close and an outside click all animate, sampled about 100ms in, with the outside click at least 450ms after any drag so click suppression does not swallow it. Under `prefers-reduced-motion: reduce` emulation, the first frame sampled after the same settle and toggles already shows the resting clip and visibility
    - Verify that the open resting state matches the pre-edit record within 1px with a `0px` left inset, and that a panel button reached with a CDP Tab key press matches `:focus-visible` with a computed `outline-offset` of `-3px`
    - Start no server and leave the one on 5173 running. Task 4.4 edits `src/mobile-swipe.js` in the same wave and the build bundles that file; do not edit it here, and if a half-finished 4.4 edit breaks the bundle, wait for 4.4 and rebuild
    - _Requirements: 1.4, 1.6, 1.9, 2.5, 2.10, 6.1_

  - [x] 3.3 Keep the 新增一站 button on the same row as the date tabs
    - Before editing, run the layout sweep from the design's "Schedule Bar Placement" against the current build in headless Chrome over CDP, with the same launch rules as 3.2, and record the failing pairs. With 15 days every width from 761 to 1020px should fail and no other pair should; any other baseline means the harness or the cascade reading is wrong, and the task reports that instead of editing
    - In `src/styles.css`, delete the whole `.schedule-bar{flex-wrap:wrap}` rule from the `@media(max-width:1020px)` block on line 16. This is the live rule that puts the button under the tabs
    - Delete the latent wraps in the `@media(max-width:480px)` blocks: `flex-wrap:wrap` from `.schedule-bar{flex-wrap:wrap;gap:13px}` on line 18, and the whole `.date-tabs{flex:1 1 100%;width:100%}` rule on line 21. Keep every other declaration there, including the live `.schedule-bar>.button{min-height:44px}` and `.date-tabs span{white-space:nowrap}`
    - Leave the base rules on line 9, the `flex-wrap:nowrap` on line 17, and the `@media(max-width:600px)` grid that begins `.schedule-bar{display:grid` unchanged, and add no new rule
    - Run `bun scripts/build.mjs` and repeat the sweep at 320, 360, 375, 390, 414, 430, 480, 600, 601, 700, 760, 761, 768, 820, 900, 1020, 1021, 1280 and 1440px with 3, 8 and 15 days, measuring after `document.fonts.ready`. Clone date buttons for this layout-only check, and recount them after each width change
    - Assert for every pair: the button's top is above the tabs' bottom; its left edge is no more than 1px left of the tabs' right edge; every date button has the same `offsetTop`; `documentElement.scrollWidth <= innerWidth`; and with 15 days the tabs' `scrollWidth > clientWidth` with a computed `overflow-x` of `auto`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 3.4 Keep every date button at least as wide as its content
    - Before editing, rerun task 3.3's sweep against the current build in headless Chrome over CDP, with 3.3's launch rules, its 19 widths, 3, 8 and 15 days, and cloned date buttons recounted after each width change, measuring after `document.fonts.ready`. Run 3.3's five checks plus the "Not squeezed" check from the design's "Amendment D" under Schedule Bar Placement, and record each pair's narrowest date-button width
    - The baseline must match the finding: the five checks pass at all 57 pairs, and the new check fails at 601, 700, 760, 761, 768, 820, 900 and 1020px with 8 and with 15 days and passes at 600px and below and with 3 days. Record 1021px and up without a prediction, since the finding does not cover it. Any other baseline means the harness or the finding is wrong; report it instead of editing
    - In `src/styles.css`, add `flex-shrink:0` to the base `.date-tabs>button{…}` rule on line 9 and change nothing else
    - Run `bun scripts/build.mjs` and repeat the sweep. All six checks pass at all 57 pairs, and at the sweep widths from 320 to 480px each date button computes `flex-grow:0`, `flex-shrink:0` and `min-width:98px`, which shows that line 220 still overrides line 21's `flex:1;min-width:0`
    - Start no server and leave the one on 5173 running
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [x] 4. Wire the gesture tracker in `src/mobile-swipe.js`
  - [x] 4.1 Build the gesture record and the `pointerdown` path
    - Keep the existing gating unchanged: `touchLayout.matches`, `pointerType` in `touch`/`pen`, target inside `[data-swipe-row].swipe-row` and not inside `button,a,input,select,textarea,summary`
    - Populate the record with `row`, `pointerId`, `x`, `y`, `startOffset` read from the row's state class rather than from computed style, `endStop` from `--swipe-count`, `wasOpen`, `axis: null`, `offset`, `samples`, `dragging`, and a `createFrameWriter` bound to `row.style.setProperty('--swipe-x', ...)`
    - Ignore a second `pointerdown` while a gesture is active, and ignore events whose `pointerId` does not match
    - Move `pointermove`, `pointerup`, and `pointercancel` registration to `root.ownerDocument ?? document` in the capture phase; do not call `setPointerCapture`, which throws on the synthetic events in `tests/app.e2e.js`
    - _Requirements: 1.1, 4.7, 5.3_

  - [x] 4.2 Implement the `pointermove` tracking path
    - Push `{ x: event.clientX, t: performance.now() }` and prune to the final `VELOCITY_WINDOW` keeping one straddling entry, using `performance.now()` so a synthetic zero timestamp cannot produce a bogus rate
    - Resolve the sticky axis; on vertical, remove `.swipe-dragging`, cancel the writer, leave `--swipe-x` untouched, and return without `preventDefault` so the page scrolls
    - Add `.swipe-dragging` once the axis is horizontal or the row is closed and `dx <= -1`, so the panel is revealed at the first leftward pixel
    - On horizontal, call `preventDefault`, compute `trackOffset(startOffset, dx, endStop, reducedMotion.matches)`, and hand the value to `writer.push`
    - Call `closeRows(row)` on the first horizontal resolution
    - _Requirements: 1.2, 1.3, 1.5, 1.6, 1.7, 1.8, 4.3, 4.4, 6.2, 6.3_

  - [x] 4.3 Implement the release and cancel settle
    - On `pointerup`: sample the velocity, call `resolveRelease`, cancel the writer, then in one synchronous batch remove `.swipe-dragging`, add `.swipe-settling`, close the other rows, call `setOpen(row, open)`, and remove the inline `--swipe-x` so the transform transitions from the drag offset to the resting value of the resolved state
    - Guard the batch on `row.isConnected` and drop the gesture if the row was re-rendered mid-drag
    - Set `suppressClickUntil` when `shouldSuppressClick(axis, totalDx)` is true
    - Clear `.swipe-settling` on `transitionend` with a `SETTLE_MS`-safe 320ms fallback timer, since reduced motion and a zero-distance settle fire no `transitionend`
    - On `pointercancel`: run the same batch resolved to `wasOpen`, with no click suppression
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.3, 4.5, 5.1, 5.2_

  - [x] 4.4 Wire the media-query listeners and extend the disposer
    - Hold a `matchMedia('(prefers-reduced-motion: reduce)')` query for the controller's lifetime, following the `setupSceneMotion` precedent, and read `.matches` fresh on every move and settle so a preference change applies to the next gesture with no reload
    - On `touchLayout` changing to non-matching, close every row, remove `--swipe-x` from each tracked row, and abandon any active gesture
    - Extend the returned disposer to remove the document-level pointer listeners and both media-query listeners, cancel the pending frame and the fallback timer, and strip `--swipe-x`, `.swipe-dragging`, and `.swipe-settling` from every tracked row
    - Leave the toggle click, outside click, clone allowlist, and `MutationObserver` paths as they are
    - _Requirements: 4.6, 5.5, 5.6, 5.7, 5.8, 6.4_

  - [x] 4.5 Measure the release velocity over the 100ms that end at the release
    - Before editing, confirm the finding in a browser. Run `bun scripts/build.mjs`, then drive headless Chrome over CDP with task 3.2's launch rules at 390px on `/demo/`, on the first activity card (two actions, End_Stop 136px), with synthetic touch `PointerEvent`s. Drag 40px left in three frames, wait 200ms without dispatching any pointer event, then dispatch `pointerup` at the same point. The current build opens the row, because the velocity still comes from the moves before the pause. If the row settles closed, the drag is too slow to count as a flick, so fix the harness before going on
    - Export `releaseVelocity(samples, release)` from `src/mobile-swipe.js` next to `sampleVelocity`, as the design's "`releaseVelocity` (Amendment C)" gives it: `null` for no samples, otherwise `sampleVelocity([...samples, release]) ?? 0`. Leave `sampleVelocity` and `resolveRelease` unchanged
    - In `onPointerUp`, replace `sampleVelocity(gesture.samples)` with `releaseVelocity(gesture.samples, { x: event.clientX, t: performance.now() })`, and update the comment above it: `null` now comes only from a `pointerdown`/`pointerup` pair with no move
    - Rewrite the prune comment in `onPointerMove` to match the design's `pointermove` step 2: the prune keeps at most one sample older than the window, `sampleVelocity` never reads it, and pruning from the newest move never drops a sample the release window needs. Leave the prune code unchanged
    - Run `bun test` and confirm every existing suite passes, then run `bun scripts/build.mjs`
    - Repeat the browser check on the new build, reloading `/demo/` before each case so the row starts closed. The 40px drag, pause and release settles closed. The same with 100px settles open. A 30px flick in two frames, with `pointerup` dispatched straight after the last move, still opens. The `pointerdown`/`pointerup` pair 85px apart with no move, as `tests/app.e2e.js` sends it, still opens. Record each case's move timestamps, release time and resolved state
    - Tasks 2.8 and 6.3 share this wave and write only their own test files, so do not edit anything under `tests/`. Start no server and leave the one on 5173 running
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.11, 5.1_

- [~] 5. Checkpoint - verify the pure layer and the wiring
  - Run `bun test` and confirm the new unit tests and the existing suites pass
  - Run `npx playwright test tests/app.e2e.js` unmodified and confirm the legacy fallback still opens the row
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Verify the real gesture with Playwright in `tests/mobile-swipe.e2e.js`
  - [x] 6.1 Create the e2e file and its gesture helpers
    - Create `tests/mobile-swipe.e2e.js` at a 390×900 viewport on `/demo/`, following the existing conventions in `tests/app.e2e.js`
    - Add a helper that drives `page.mouse`/`page.touchscreen` with intermediate moves so `pointermove` fires, plus readers for the computed `translateX` of a surface child, the inline `--swipe-x`, and `transition-duration`
    - _Requirements: 1.3_

  - [x] 6.2 Test finger-tracked drag fidelity
    - Drag 40px left and assert the surface translation matches the displacement within 1px, the panel and toggle transforms stay at identity, and the mid-drag `transition-duration` is `0s`
    - Move 1px left and assert the panel is visible before release; open row A, drag row B, assert A closed
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7_
    - Amendment A: at 20, 68 and 136px of drag on a two-action row, assert that a hit 2px inside the uncovered strip returns a panel button, that a hit 2px outside it (where that point is still inside the panel box) returns a node outside the Action_Panel, and that the panel width minus the computed `clip-path` left inset equals the surface `translateX` magnitude within 1px
    - Hit-test through a CDP session's `DOM.getNodeForLocation` with `ignorePointerEventsNone: true`, or after `page.addStyleTag` forces `pointer-events:auto` on the dragging panel and its buttons, because `elementFromPoint` skips the `pointer-events:none` dragging panel. Drive the drag with synthetic touch `PointerEvent`s or `Input.dispatchTouchEvent`, because `page.mouse` reports `pointerType: 'mouse'` and `page.touchscreen` can only tap
    - _Requirements: 1.9_

  - [x] 6.3 Test the release snap, settle symmetry, and ARIA
    - Flick 20px left and assert open; drag 100px left then flick rightward and assert closed; cross and undercut the halfway point with slow releases
    - Assert the `transition-duration` is equal in both directions and at most 320ms, that the settled translation equals the resting value within 1px, and that no inline `--swipe-x` remains
    - Assert `aria-hidden` on the panel and `aria-expanded` on the toggle after opening and after closing
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
    - Amendment C: task 4.5 runs in this wave and counts the release as a velocity sample (design.md, "`releaseVelocity` (Amendment C)"). The drag driver waits one frame between the last move and `pointerup`, and after 4.5 that frame lowers a flick's velocity: `{dx:-20,steps:2}` falls from about 0.6 to about 0.30px/ms and stops flicking. Add a driver option that dispatches `pointerup` straight after the last move, and use it for every flick, so each outcome is the same before and after 4.5. Slow releases at the default 4px per frame, or ending with `{hold:STILL_MS}`, stay under 0.35px/ms either way. Update the header's release-velocity note, the flick example in the `drag()` notes, and the `samples` note to the new rule. A release after a pause with no pointer events is task 6.9's scenario

  - [x] 6.4 Test the rubber-band end stop
    - Drag past the end stop and assert the rendered overshoot is within the 48px cap and smaller than the raw overshoot, then release and assert open
    - Drag an open row rightward past zero and assert the translation holds at `0`
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

  - [x] 6.5 Test scroll coexistence, cancellation, and layout change
    - Mostly vertical drag: assert no `swipe-dragging` class and that the page scrolled; mostly horizontal drag: assert `scrollY` unchanged
    - Start a drag, dispatch `pointercancel`, and assert the prior state is restored with the inline value cleared
    - Open at 390px, resize to 1440px, and assert closed with no inline value
    - _Requirements: 4.3, 4.4, 4.5, 4.6_

  - [x] 6.6 Test the reduced-motion branch
    - Under `prefers-reduced-motion: reduce` emulation, assert the settle `transition-duration` is `0s`, the final translation is correct, tracking still follows the finger 1:1, and the translation holds at the end stop past it
    - Change the emulation between two gestures and assert the second gesture follows the new branch
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 6.7 Test the preserved markup and dismissal contracts
    - Assert the clone conventions on a prepared row, that a newly added activity row gains a panel, and that repeated re-renders leave exactly one panel per row
    - Toggle a row twice asserting inversion plus closure of others, click the page background asserting all closed, swipe then assert the following click is swallowed, and assert a disabled-only action row gets no panel and no toggle
    - _Requirements: 2.9, 5.4, 5.5, 5.6, 5.7, 5.9_

  - [x] 6.8 Test that the 新增一站 button stays on the same row as the date tabs
    - Create `tests/schedule-bar.e2e.js`, separate from `tests/mobile-swipe.e2e.js` so it shares no file with the other 6.x tasks. It needs Node, and it runs against the server already on 5173
    - On `/demo/`, cover the demo's 3 days, then extend the trip through 旅行設定, 編輯旅行 and 結束日期 to 8 days (`2026-11-27`) and to 15 days (`2026-12-04`), following `tests/app.e2e.js`
    - At each of the 19 widths from task 3.3, set the viewport and assert the same five checks as task 3.3, after `document.fonts.ready`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 6.9 Test that a release after a pause settles by position
    - In `tests/mobile-swipe.e2e.js`, add a `{pause:ms}` step to the drag driver that waits that long in animation frames without dispatching any event. `{hold:ms}` repeats the position every frame, so it never leaves the velocity window without moves
    - On the first activity card (two actions, End_Stop 136px), drag 40px left in three frames, pause 200ms, release, and assert the row settles closed. Drag 100px the same way, pause, release, and assert it settles open
    - From `result.samples`, assert that each drag measured at least 0.35px/ms over its moves, so the closed result comes from the pause and not from a slow drag
    - Dry-run the in-page code over CDP against the running server, as the other 6.x tasks do; the Playwright run waits for Node
    - _Requirements: 2.3, 2.4, 2.11_

  - [x] 6.10 Test that the date buttons keep their content width
    - In `tests/schedule-bar.e2e.js`, add the design's "Not squeezed" check at every width and trip length task 6.8 covers, after `document.fonts.ready`: each date button is at least as wide as its max-content width within 1px, each of its three labels renders as one line box, and its `scrollWidth` is at most its `clientWidth`
    - Measure the max-content width and the line boxes as the design's "Amendment D" describes, and remove any inline style the measurement sets before the next check runs
    - Dry-run the in-page code over CDP against the running server, as the other e2e tasks do; the Playwright run waits for Node
    - _Requirements: 7.6_

- [~] 7. Final checkpoint - full verification
  - Run `bun test`, then `npx playwright test` across the whole suite with `tests/app.e2e.js` unmodified, then `bun scripts/build.mjs`
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional. They are the property tests whose criteria are also exercised by the Playwright scenarios in task 6, and the regression scenarios in 6.7 that `tests/app.e2e.js` already covers. Everything unmarked is either delivery code or the only verification of its contract: task 2.7 and 2.10 guard the `null`-velocity legacy path that keeps `tests/app.e2e.js` green, and task 2.12 is the only way to observe the one-write-per-frame behavior.
- `tests/app.e2e.js` must not be edited by any task.
- No new runtime or test dependency is added; the property tests use a seeded `mulberry32` generator defined inside the test file.
- Tasks 1.1 through 1.3 and 4.1 through 4.4 all edit `src/mobile-swipe.js`, so they are scheduled in separate waves to avoid concurrent writes to one file. The same applies to the sub-tasks of 2 and 6 within their own new files.
- Amendment notes. Task 3 stays checked because existing checkboxes are not edited mid-execution, although its new sub-tasks 3.2 and 3.3 are open. Tasks 3.2 and 3.3 both edit `src/styles.css`, so they run in different waves. Task 6.8 writes its own file, `tests/schedule-bar.e2e.js`, so it shares a wave with 6.2; like the rest of task 6, it runs only once Node is installed.
- Criterion 2.10 has no Playwright regression. Task 3.2's browser check is its only verification.
- Amendment C and D notes. Tasks 3 and 4 stay checked although their new sub-tasks 3.4 and 4.5 are open. Tasks 4.5 and 3.4 both rebuild `dist/` with `bun scripts/build.mjs`, so they run in different waves, 9 and 10. Task 6.3 shares wave 9 with 4.5 and writes no file 4.5 writes, but its dry-run hits whichever build is live, so its Amendment C sub-bullet makes every outcome hold under both release rules. Task 6.10 runs in wave 11, after 3.4; 6.8 is the only other task that writes `tests/schedule-bar.e2e.js`. Tasks 2.13 and 6.9 write files that 2.8 to 2.12 and 6.3 to 6.7 write one per wave, so they run in a new wave 14.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1"] },
    { "id": 3, "tasks": ["2.2", "4.1"] },
    { "id": 4, "tasks": ["2.3", "4.2"] },
    { "id": 5, "tasks": ["2.4", "4.3"] },
    { "id": 6, "tasks": ["2.5", "4.4", "3.2"] },
    { "id": 7, "tasks": ["2.6", "6.1", "3.3"] },
    { "id": 8, "tasks": ["2.7", "6.2", "6.8"] },
    { "id": 9, "tasks": ["2.8", "6.3", "4.5"] },
    { "id": 10, "tasks": ["2.9", "6.4", "3.4"] },
    { "id": 11, "tasks": ["2.10", "6.5", "6.10"] },
    { "id": 12, "tasks": ["2.11", "6.6"] },
    { "id": 13, "tasks": ["2.12", "6.7"] },
    { "id": 14, "tasks": ["2.13", "6.9"] }
  ]
}
```
