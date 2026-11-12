# Design Document

## Overview

The swipe gesture in `src/mobile-swipe.js` is rebuilt from a release-only classifier into a continuously tracked drag. Three things change:

1. A `pointermove` path is added. It locks the gesture axis, computes a Drag_Offset, and writes that offset to the row once per animation frame.
2. The release path gains a velocity sampler and a snap resolver. When the gesture produced no move samples, the resolver falls back to the existing 56px/42px distance rule, so `tests/app.e2e.js` keeps passing unchanged.
3. The CSS transition moves out of the `.swipe-open` rule and onto the base surface rule, which makes opening and closing symmetric, and the per-direct-child transform becomes a single custom property written once per frame.

All physics and decision logic is extracted into exported pure functions so `bun test` can cover it without a DOM. The DOM wiring stays thin: read events, call pure functions, write one custom property.

Implementation language: **JavaScript** (ES modules, no transpilation), matching the rest of `src/`.

### Scope boundaries

- One module changes: `src/mobile-swipe.js`. One CSS block changes: the swipe block in `src/styles.css` (currently lines ~47–62).
- No row markup changes in `src/app.js`, `src/accounts-ui.js`, or `src/expenses-ui.js`.
- No new user-facing copy, so the existing Traditional Chinese strings (`滑動操作`, `顯示編輯與刪除操作`) are the only copy involved. _Requirements: 6.5_
- Amendments added after tasks 3.1 and 4.1 to 4.3 shipped. Amendment A adds rules to the same swipe block (see "Amendment A" under CSS Contract). Amendment B removes three wrap declarations from the schedule-bar rules elsewhere in `src/styles.css` (see Schedule Bar Placement). Neither amendment touches JavaScript or row markup.
- Amendments added after tasks 2.7, 3.3 and 6.8 shipped. Amendment C adds one pure function, `releaseVelocity`, to `src/mobile-swipe.js`, calls it from the `pointerup` path, and corrects the prune comment in `pointermove` (see "`releaseVelocity` (Amendment C)" under Pure functions). Amendment D adds one declaration, `flex-shrink:0`, to the base date-button rule in `src/styles.css` (see "Amendment D" under Schedule Bar Placement). Neither amendment changes row markup.

## Architecture

### Layers

```
pointerdown / pointermove / pointerup / pointercancel  (DOM events)
        │
        ▼
  gesture tracker  ──────────────┐   mutable per-gesture record
  (impure, DOM-aware)            │
        │                        ▼
        │              resolveAxis / trackOffset / pushSample
        │              sampleVelocity / releaseVelocity / resolveRelease
        │              shouldSuppressClick
        │              (pure, exported, unit-testable)
        ▼
  frame writer  ──►  row.style.setProperty('--swipe-x', `${offset}px`)
  (one write per rendered frame)
        │
        ▼
  CSS: .swipe-row > surface children { transform: translateX(var(--swipe-x)) }
```

### Constants

| Name | Value | Source |
| --- | --- | --- |
| `ACTION_WIDTH` | `68` | existing panel geometry, `calc(var(--swipe-count)*68px)` |
| `AXIS_BIAS` | `1.25` | existing axis bias, reused per the requirements' stated assumption |
| `AXIS_DEADZONE` | `8` | _Requirements: 4.1, 4.2_ |
| `FLICK_THRESHOLD` | `0.35` px/ms | _Requirements: 2.1, 2.2_ |
| `VELOCITY_WINDOW` | `100` ms | Release_Velocity definition |
| `RUBBER_RESIST` | `0.3` | _Requirements: 3.1_ |
| `RUBBER_MAX` | `48` px | _Requirements: 3.2_ |
| `SETTLE_MS` | `260` | under the 320ms budget, _Requirements: 2.5_ |
| `LEGACY_OPEN` | `56` | existing `OPEN_THRESHOLD`, _Requirements: 5.1_ |
| `LEGACY_CLOSE` | `42` | existing `SWIPE_THRESHOLD`, _Requirements: 5.2_ |
| `CLICK_SUPPRESS_MS` | `450` | existing behavior, _Requirements: 2.9_ |

End_Stop for a row is `-(swipeCount * ACTION_WIDTH)`, read from the `--swipe-count` custom property that `prepare()` already sets.

## The Row_Surface decision

The glossary calls the Row_Surface "the single element whose horizontal transform is animated." The current CSS translates every direct child independently through `.swipe-row.swipe-open > :not(.swipe-actions)`. Three ways to get to one coherent surface were considered.

### Option A — wrapper element inserted by `prepare()` (rejected)

`prepare()` would move every existing child into a `div.swipe-surface` and translate that one element.

Verified against the host modules, this breaks layout. Rows are grid containers whose **direct children** are placed by the grid:

- `src/styles.css`: `.shopping-row{display:grid;grid-template-columns:minmax(0,1fr) 156px minmax(64px,100px) 44px}` with `.shopping-row>label`, `.shopping-row>.assignee-select`, `.shopping-row>.quantity`, `.shopping-row>.icon-button` each assigned explicit `grid-column`/`grid-row` values, and again inside the 580px and 480px media queries.
- `src/styles.css`: `.gear-row{grid-template-columns:minmax(0,1fr) 156px 44px}` with `.gear-row>select`, `.gear-row>.tag`, `.gear-row>.icon-button` placed the same way.
- `src/expenses.css`: `.xp-row{display:grid;grid-template-areas:"main money" "meta actions"}` with children placed by `grid-area`, re-templated at the 560px breakpoint.
- `src/styles.css`: `.meal-date-group .meal-card{display:grid;grid-template-columns:104px minmax(0,1fr)}`.

Inserting a wrapper makes all of those children grandchildren, so every placement rule stops matching and the wrapper would have to inherit each row type's `display`, template, `gap`, `padding`, `align-items` and all breakpoint overrides. That is a cross-cutting CSS refactor over roughly ten row shapes in two stylesheets, for a gesture change.

A second problem compounds it. Rows are produced by template strings and re-rendered wholesale: `src/app.js` assigns `app.innerHTML = ...` on every render, and `src/expenses-ui.js` assigns `body.innerHTML = view()`. The `MutationObserver` (subtree + childList, plus the attributes branch) re-runs `prepare()` on the replacement nodes, so the wrapper would be destroyed and rebuilt on every render. Wrapping is idempotent-able via the existing `data-swipe-ready` guard, but each rebuild moves nodes, and moving nodes inside an observed subtree is exactly the shape that produces observer feedback. The wrapper buys nothing the alternative does not, at that risk.

### Option B — translate the row itself and counter-translate the panel (rejected)

`.swipe-row` carries `overflow:hidden`. Translating the row moves its clip box with it, so nothing is revealed; counter-translating `.swipe-actions` pushes the panel outside the row's padding box where `overflow:hidden` clips it.

### Option C — one custom property drives all surface children (chosen)

The row keeps its authored children. A single rule applies the same transform to every direct child except the panel and the toggle, reading one custom property set on the row:

```css
.swipe-row>:not(.swipe-actions):not(.swipe-toggle){transform:translateX(var(--swipe-x,0px))}
```

The tracker writes `--swipe-x` on the row once per frame. Because every surface child reads the same variable, they translate as a rigid unit and are indistinguishable from a single promoted layer during the gesture.

**Trade-off, stated plainly.** This realizes the Row_Surface as a *logical* surface — the set of direct children excluding the Action_Panel and the Swipe_Toggle — rather than one DOM element, which is a deviation from the glossary's wording. It satisfies the behavioral criteria that depend on the surface: the rendered translation equals the Drag_Offset (_Requirements: 1.3_), and the panel and toggle stay untranslated because the `:not()` clauses exclude them (_Requirements: 1.4_). The cost is that the browser applies the transform to N elements (2–6 per row in this codebase) instead of one, so the style recalculation touches a few more nodes per frame. That cost is bounded and measured in a handful of elements; the wrapper's cost is a stylesheet-wide layout refactor plus node motion inside an observed subtree. The deviation is recorded here so it is traceable rather than silent.

Two secondary notes on Option C:

- The base rule is scoped inside `@media (max-width:760px)` so no transform, stacking context, or containing block is introduced on desktop. That also satisfies _Requirements: 4.7_ structurally rather than by runtime check.
- `translateX` is used rather than `translate3d` so an identity transform does not permanently promote every row child. Promotion is requested only while a gesture or settle is in flight, through `will-change`.

## Components and Interfaces

### Pure functions (exported from `src/mobile-swipe.js`)

These are exported named functions with no DOM or timer access, so `bun test` imports them directly. The module's top level already touches nothing global, so importing it outside a browser is safe.

```js
// Axis lock. Returns 'horizontal', 'vertical', or null while unresolved.
// Once `locked` is non-null the answer is sticky for the rest of the gesture.
export function resolveAxis(dx, dy, locked = null) {
  if (locked) return locked;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax >= AXIS_DEADZONE && ax >= ay * AXIS_BIAS) return 'horizontal';
  if (ay >= AXIS_DEADZONE && ay > ax * AXIS_BIAS) return 'vertical';
  return null;
}
```

Horizontal wins an exact tie, matching `>=` in criterion 4.1 against `exceeds` in criterion 4.2, which keeps the two outcomes mutually exclusive. _Requirements: 4.1, 4.2_

```js
// Drag_Offset for a pointer displacement, including clamp and rubber band.
// `endStop` is negative. `reduced` is true while Reduced_Motion applies.
export function trackOffset(startOffset, dx, endStop, reduced = false) {
  const raw = startOffset + dx;
  if (raw >= 0) return 0;                 // closed clamp, Req 3.4 / 3.5
  if (raw >= endStop) return raw;         // linear zone, 1:1 with the finger
  if (reduced) return endStop;            // Req 6.3
  const overshoot = endStop - raw;        // positive
  return endStop - Math.min(RUBBER_MAX, overshoot * RUBBER_RESIST);
}
```

_Requirements: 1.2, 3.1, 3.2, 3.4, 3.5, 6.2, 6.3_

```js
// Release_Velocity in px/ms, negative leftward. Returns null when it cannot
// be measured, which is the signal for the legacy distance path.
export function sampleVelocity(samples, window = VELOCITY_WINDOW) {
  if (!samples || samples.length < 2) return null;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    if (last.t - samples[i].t > window) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (dt <= 0) return null;
  return (last.x - first.x) / dt;
}
```

**Behavior with zero or one sample.** This is the hinge of the backward-compatibility contract. A gesture that is `pointerdown` then `pointerup` with no `pointermove` fills no samples, so `samples.length < 2` and the function returns `null`. One sample returns `null` for the same reason: a single position carries no rate. A degenerate pair with identical timestamps also returns `null` rather than dividing by zero. `null` is not zero — zero would mean "measured, and the finger was stationary", which would route the gesture into the halfway rule. `null` means "not measured", and `resolveRelease` treats it as the trigger for the legacy rule. _Requirements: 5.1, 5.2_

```js
// Resolve the post-release state. Returns true for open, false for closed.
export function resolveRelease({ offset, endStop, velocity, totalDx, totalDy, axis, wasOpen }) {
  if (!endStop) return false;
  if (velocity === null) {
    const releaseAxis = axis ?? resolveAxis(totalDx, totalDy);
    if (releaseAxis !== 'horizontal') return wasOpen;
    if (totalDx <= -LEGACY_OPEN) return true;    // Req 5.1
    if (totalDx >= LEGACY_CLOSE) return false;   // Req 5.2
    return wasOpen;
  }
  if (Math.abs(velocity) >= FLICK_THRESHOLD) return velocity < 0;   // Req 2.1, 2.2
  return Math.abs(offset) >= Math.abs(endStop) / 2;                 // Req 2.3, 2.4, 3.3
}
```

The rubber-band release case needs no branch: an offset at or past the End_Stop always exceeds half the End_Stop, so the halfway rule already resolves it to open. _Requirements: 3.3_

```js
// Whether the click that follows this gesture should be swallowed.
export function shouldSuppressClick(axis, totalDx) {
  return axis === 'horizontal' || Math.abs(totalDx) >= LEGACY_CLOSE;
}
```

The distance clause is criterion 2.9 verbatim. The axis clause additionally covers a fast short flick, which resolves a state change over less than 42px and must not also fire a click. A tap cannot satisfy either clause, because resolving the axis requires at least 8px of travel. _Requirements: 2.9_

#### `releaseVelocity` (Amendment C)

Task 2.7 found that the release path did not match the Release_Velocity definition. `pointerup` called `sampleVelocity(samples)` and added no sample for the release, so the 100ms window ended at the last `pointermove`. Browsers usually fire no `pointermove` while a finger is held still, so a fast drag, a pause and a lift kept the velocity from before the pause and could resolve as a flick. Task 3.2 measured a 0 velocity only because it sent same-position moves during its hold.

`sampleVelocity` and Property 5 stay exactly as they are. They are the tested primitive for "the velocity of a trace's final 100ms". A second pure function hands it the trace with the release appended:

```js
// Release_Velocity in px/ms over the 100ms that end at the release, with the
// release counted as the last sample. `release` is { x: event.clientX,
// t: performance.now() } taken at pointerup, on the same clock as `samples`.
// null only for an empty trace, the signal for the legacy distance rule.
export function releaseVelocity(samples, release) {
  if (!samples || samples.length === 0) return null;
  return sampleVelocity([...samples, release]) ?? 0;
}
```

Contract: `samples` is the gesture's move buffer in time order, and `release` is no earlier than its last sample, which `performance.now()` guarantees. The result is `null` or a number.

Behavior:

- **Zero samples.** A `pointerdown` then `pointerup` with no `pointermove` returns `null` before `sampleVelocity` runs, so `resolveRelease` takes the 56px/42px distance rule and `tests/app.e2e.js` keeps passing. The release path now reaches `sampleVelocity` only through `releaseVelocity`, so this empty-trace check is the hinge of the legacy path. The zero-or-one-sample paragraph under `sampleVelocity` still describes `sampleVelocity` itself. _Requirements: 5.1, 5.2_
- **One sample.** The move and the release form the pair. A release within 100ms on a later timestamp gives their slope, a release more than 100ms later gives 0, and a release on the same timestamp gives 0 (decision below). Before this amendment one move gave `null` and took the legacy rule; now only an empty trace does.
- **A pause.** When the last move came more than 100ms before the release, the window holds only the release, `sampleVelocity` returns `null`, and `releaseVelocity` returns 0. The halfway rule then decides. _Requirements: 2.11_
- **Otherwise.** The result is the slope from the earliest sample in the 100ms before the release to the release. A release that lags the last move at the same position lowers the result. That is intended: a finger that lingers before lifting has slowed down. _Requirements: 2.1, 2.2_

**Decision: a window collapsed onto the release instant reads as 0.** For a non-empty trace, `sampleVelocity` returns `null` in exactly one situation: no sample falls in the 100ms before the release instant. Either no move falls inside the window at all, which is a pause, or every move inside it shares the release's timestamp, as one move followed by a release on the same timestamp does. Both read as a stationary finger, for two reasons:

1. No sample in the 100ms before the release instant means the browser reported no movement over any non-zero part of the window, which is what a still finger produces.
2. The result stops depending on timer resolution. Browsers coarsen `performance.now()`, for example to 0.1ms or 1ms, so a move and a release dispatched in one task often share a timestamp. A release at the last move's position measures 0 whether or not the clock ticked between the two. Reading the collapsed case as `null` would switch such a gesture between the legacy rule and the halfway rule on a single tick.

**Effect on a gesture with exactly one move.** A synthetic gesture that sends one `pointermove` and releases at that position now resolves by the halfway rule instead of the legacy rule. No existing test depends on the old behavior: `tests/app.e2e.js` sends no move, and the completed 6.2 scenarios end with `pointercancel` or assert nothing after `pointerup`.

**Effect on the e2e drag driver.** `runSyntheticGesture` in `tests/mobile-swipe.e2e.js` dispatches `pointerup` one frame after the last move. With the release counted, that frame lowers a flick's measured velocity: `{dx:-20,steps:2}` falls from about 0.6 to about 0.30px/ms, under the Flick_Threshold. Task 6.3 adds a release in the same frame as the last move for its flicks and updates the driver's notes. Task 6.9 adds a pause step that waits without dispatching anything, because `{hold}` repeats the position every frame and so never leaves the window without moves.

### Frame writer (exported for testability)

```js
export function createFrameWriter(write, raf = requestAnimationFrame, caf = cancelAnimationFrame) {
  let handle = 0, pending = null;
  return {
    push(value) {
      pending = value;
      if (handle) return;
      handle = raf(() => { handle = 0; const next = pending; pending = null; write(next); });
    },
    flushTarget(value) { this.cancel(); write(value); },
    cancel() { if (handle) caf(handle); handle = 0; pending = null; }
  };
}
```

Every `pointermove` calls `push`. Only the first `push` of a frame schedules a callback; later pushes in the same frame overwrite `pending`. The callback writes the newest value and clears the handle. So a burst of coalesced or high-rate pointer events produces exactly one `setProperty` call and one style recalculation per rendered frame. Injecting `raf`/`caf` lets a unit test drive it with a fake scheduler and no browser. _Requirements: 1.8_

### Gesture tracker (impure)

Per-gesture record:

```js
start = {
  row,            // the Swipe_Row element
  pointerId,      // ignore events from other pointers (multi-touch guard)
  x, y,           // pointerdown client coordinates
  startOffset,    // 0 if the row was closed, End_Stop if it was open
  endStop,        // -(swipeCount * 68)
  wasOpen,        // state at gesture start, used by pointercancel and the legacy rule
  axis: null,     // resolveAxis result, sticky once set
  offset: 0,      // latest Drag_Offset
  samples: [],    // { x, t } ring, pruned to the final VELOCITY_WINDOW plus one
  dragging: false,// whether .swipe-dragging is applied
  writer          // createFrameWriter bound to this row
};
```

#### `pointerdown`

Gating is unchanged: `touchLayout.matches`, `pointerType` in `touch`/`pen`, target inside a `.swipe-row` and not inside `button,a,input,select,textarea,summary`. A second `pointerdown` while a gesture is active is ignored. `startOffset` is read from the row's current state rather than from the computed style, so it is exactly `0` or `endStop`. _Requirements: 1.1, 4.7_

#### `pointermove`

1. Ignore if there is no active gesture or `event.pointerId` does not match.
2. Push `{ x: event.clientX, t: performance.now() }` onto `samples` and prune entries more than `VELOCITY_WINDOW` older than the newest move. The prune keeps at most one entry older than the window. `sampleVelocity` never reads an entry older than its window, so that entry has no effect on any velocity; the prune only bounds the buffer at the in-window samples plus one. Pruning from the newest move is also safe for `releaseVelocity`, whose window ends at the release: the release comes at or after the newest move, so every entry its window can include is still in the buffer. `performance.now()` is used rather than `event.timeStamp` so synthetic events with a zero timestamp cannot produce a bogus rate. Amendment C corrected this step, which used to say the older entry keeps two points available when the window is shorter than one frame.
3. `axis = resolveAxis(dx, dy, axis)`.
4. If `axis === 'vertical'`: remove `.swipe-dragging`, cancel the frame writer, leave `--swipe-x` untouched, and return without calling `preventDefault`, so the page scrolls. _Requirements: 4.3_
5. If `axis === 'horizontal'`, or the row is closed and `dx <= -1`: ensure `.swipe-dragging` is on the row. That class makes the panel visible, so the reveal begins at the first leftward pixel. _Requirements: 1.6_
6. If `axis === 'horizontal'`: `event.preventDefault()`, compute `offset = trackOffset(startOffset, dx, endStop, reducedMotion.matches)`, and `writer.push(offset)`. _Requirements: 1.2, 1.3, 1.5, 4.4_
7. On the first horizontal resolution, call `closeRows(row)` so no other row is left open. _Requirements: 1.7_

`preventDefault` on `pointermove` is the belt; the brace is the existing `touch-action:pan-y` on `.swipe-row`, which already prevents the browser from starting a horizontal pan, so a horizontal drag never scrolls the page. The vertical direction stays available to the browser, which is why the axis lock must resolve before any transform is written.

#### `pointerup`

1. `velocity = releaseVelocity(samples, { x: event.clientX, t: performance.now() })`, so the velocity window ends at the release and counts the release position (Amendment C). _Requirements: 2.1, 2.2, 2.11_
2. `open = resolveRelease({ offset, endStop, velocity, totalDx, totalDy, axis, wasOpen })`.
3. `writer.cancel()`.
4. Settle, in one synchronous batch so the browser performs a single style recalculation:
   ```js
   row.classList.remove('swipe-dragging');   // re-enables the base transition
   row.classList.add('swipe-settling');      // keeps will-change for the animation
   if (open) closeRows(row);
   setOpen(row, open);                       // toggles .swipe-open, syncs ARIA
   row.style.removeProperty('--swipe-x');    // hand the value back to the class rule
   ```
   Removing the inline value and toggling `.swipe-open` in the same recalculation makes the transform change from the drag offset to the resting value of the resolved state, with a non-zero transition duration in the after-change style, which is exactly the condition that starts a transition. The animation therefore runs from wherever the finger left the row to the resting position. _Requirements: 2.5, 2.6, 2.7, 2.8_
5. If `shouldSuppressClick(axis, totalDx)`, set `suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS`. _Requirements: 2.9_
6. Clear `.swipe-settling` and the `will-change` hint on the row's `transitionend`, with a `setTimeout` fallback at 320ms in case no transition runs (reduced motion, or a settle with zero distance, both of which fire no `transitionend`). _Requirements: 2.5_

#### `pointercancel`

Settle to `wasOpen` using the same batch as `pointerup`, with no click suppression. This covers the browser taking over the gesture for a scroll after `touch-action` negotiation. _Requirements: 4.5_

#### Layout and motion preference changes

- `touchLayout` `change` to non-matching: `closeRows()` plus `row.style.removeProperty('--swipe-x')` on every tracked row, and abandon any active gesture. _Requirements: 4.6_
- `reducedMotion` is a `matchMedia('(prefers-reduced-motion: reduce)')` query held for the lifetime of the controller, following the `setupSceneMotion` precedent in `src/scene-motion.js`. Its `change` listener does nothing but exist, because `reducedMotion.matches` is read fresh on every `pointermove` and every settle. The next gesture therefore uses the new value with no reload. _Requirements: 6.4_
- The disposer removes the `pointerdown`, `pointermove`, `pointerup`, `pointercancel` and `click` listeners, both media-query listeners, disconnects the observer, cancels any pending frame and fallback timer, and removes `--swipe-x` and the `swipe-dragging`/`swipe-settling` classes from every tracked row. _Requirements: 5.8_

### Pointer capture versus document-level listeners

`setPointerCapture` is **not** used. Two reasons, in order of weight:

1. `tests/app.e2e.js` drives the gesture with `dispatchEvent('pointerdown', { pointerType: 'touch', ... })`. A synthetic `PointerEvent` carries no live pointer, so `setPointerCapture(event.pointerId)` throws `NotFoundError` and would break criteria 5.1 and 5.2 outright.
2. Capture is only needed to keep receiving moves after the pointer leaves the element. Listening on the document achieves the same thing without the failure mode.

So `pointerdown` stays on `root` in the capture phase as today, and `pointermove`, `pointerup`, `pointercancel` are registered once on `root.ownerDocument ?? document` in the capture phase for the controller's lifetime. The handlers return immediately when no gesture is active, so the steady-state cost is one function call per event. The trade-off is that a pointer released outside the document never delivers `pointerup`; the browser sends `pointercancel` in that situation, which the cancel path already settles.

## Data Models

No persisted data. Two DOM-level contracts:

| Contract | Owner | Values |
| --- | --- | --- |
| `--swipe-count` | set by `prepare()` (unchanged) | integer count of cloned actions |
| `--swipe-x` | inline on the row, written by the tracker | `0px` to `endStop - 48px` during a gesture; absent at rest |
| `.swipe-open` | state class (unchanged) | resting state, drives the resting `--swipe-x` and ARIA |
| `.swipe-dragging` | transient | suppresses the transition, reveals the panel, requests `will-change` |
| `.swipe-settling` | transient | holds `will-change` for the duration of the settle |

## CSS Contract

The current block has two defects that are fixed here. The transition is declared inside `.swipe-row.swipe-open>:not(.swipe-actions)`, so it exists only while the row is open and the closing direction snaps. And `>:not(.swipe-actions)` also matches `.swipe-toggle`, translating the affordance along with the content.

Replacing those two lines:

```css
/* removed */
.swipe-row.swipe-open>:not(.swipe-actions){transform:translateX(calc(var(--swipe-count)*-68px));transition:transform .22s ease}
@media(prefers-reduced-motion:reduce){.swipe-row.swipe-open>:not(.swipe-actions){transition:none}}
```

with:

```css
.swipe-row{--swipe-x:0px}
.swipe-row.swipe-open{--swipe-x:calc(var(--swipe-count)*-68px)}
@media(max-width:760px){
  .swipe-row>:not(.swipe-actions):not(.swipe-toggle){transform:translateX(var(--swipe-x));transition:transform .26s cubic-bezier(.22,.61,.36,1)}
  .swipe-row.swipe-dragging>:not(.swipe-actions):not(.swipe-toggle){transition:none;will-change:transform}
  .swipe-row.swipe-settling>:not(.swipe-actions):not(.swipe-toggle){will-change:transform}
  .swipe-row.swipe-dragging>.swipe-actions{visibility:visible;pointer-events:none}
}
@media(prefers-reduced-motion:reduce){
  .swipe-row>:not(.swipe-actions):not(.swipe-toggle){transition:none}
}
```

Points worth noting:

- The transition now lives on the base rule, so it applies in both directions, to gesture settles and to `.swipe-toggle` clicks alike. _Requirements: 2.5_
- `will-change:transform` appears only under `.swipe-dragging` and `.swipe-settling`, which means the compositor hint exists from the moment tracking starts until the settle ends and is dropped by the class removal in the `transitionend` handler. Rows at rest carry no hint.
- `.swipe-open` already handles `visibility` and `pointer-events` on the panel; `.swipe-dragging` adds visibility without interactivity so a reveal in progress cannot be tapped.
- The reduced-motion override kills the transition everywhere, so a settle under reduced motion is an immediate jump to the resting value. Tracking is untouched, because tracking writes the inline value directly and never depends on a transition. _Requirements: 6.1, 6.2_
- `.swipe-row{overflow:hidden}` is unchanged, so the surface is clipped to the row exactly as today, including the existing clipping of `.timeline-stamp` on activity cards.

### Amendment A: the Action_Panel covers the Row_Surface

**Finding.** This came from reading the CSS after task 3.1 shipped. It has not been seen in a browser, so task 3.2 confirms it before changing anything.

- `.swipe-row>.swipe-actions` is `position:absolute;z-index:3;inset:0 0 0 auto;width:calc(var(--swipe-count)*68px)`. Each surface child carries `transform:translateX(var(--swipe-x))`, so it paints as its own stacking context at the `z-index:0` level, and the panel at `z-index:3` paints above every surface child it overlaps.
- `.swipe-row.swipe-dragging>.swipe-actions{visibility:visible}` turns on the whole panel at the first leftward pixel. The full panel covers the right `swipe-count × 68` pixels of the content at once, and the edge between content and panel stays still instead of following the finger. Criterion 1.6 asks for a panel revealed behind the moving Row_Surface.
- `visibility` is not transitioned. When a gesture settles to closed, or a row closes through the Swipe_Toggle or an outside click, removing `.swipe-dragging` or `.swipe-open` hides the panel at once while the content is still sliding back, so the content slides over an empty strip. Opening through the toggle has the mirror problem: the full panel appears at once and the content slides under it.

**Decision: clip the panel to the width the Row_Surface has uncovered.** The panel keeps painting above the content, but only the strip the Row_Surface has moved off stays unclipped.

```css
@media(max-width:760px){
  /* new rules in the existing block */
  .swipe-row>.swipe-actions{clip-path:inset(0 0 0 calc(var(--swipe-count)*68px + var(--swipe-x)));transition:clip-path .26s cubic-bezier(.22,.61,.36,1),visibility 0s linear .26s}
  .swipe-row.swipe-open>.swipe-actions{transition-delay:0s}
  /* existing rule, gains transition:none */
  .swipe-row.swipe-dragging>.swipe-actions{visibility:visible;pointer-events:none;transition:none}
  /* new: keep focus rings inside the clip */
  .swipe-actions>.swipe-action:focus-visible{outline-offset:-3px}
}
@media(prefers-reduced-motion:reduce){
  /* existing rule, gains the panel selector */
  .swipe-row>:not(.swipe-actions):not(.swipe-toggle),.swipe-row>.swipe-actions{transition:none}
}
```

How the rules work:

- The left inset is `swipe-count × 68 + --swipe-x`. Closed (`--swipe-x:0px`) clips the whole panel, open (`--swipe-x` at the End_Stop) clips nothing, and a 20px drag leaves the right 20px visible. The Panel_Visible_Width is therefore the magnitude of `--swipe-x`, which is the Drag_Offset. _Requirements: 1.9_
- Explicit lengths instead of `100%` keep the computed inset a plain length, so it interpolates cleanly. Negative insets are valid, so the rubber-band overshoot needs no `max()`: past the End_Stop the clip box extends beyond the panel and the whole panel shows.
- `clip-path` uses the surface's `.26s cubic-bezier(.22,.61,.36,1)`. A settle, a toggle, and an outside click all change `--swipe-x`, which changes the computed `transform` of the surface children and the computed `clip-path` of the panel in the same style recalculation. Both transitions start together and run for the same time on the same curve, so the panel's visible strip and the surface translation stay equal frame by frame. _Requirements: 2.10_
- In the hidden state, `visibility` waits `.26s` before switching, so a closing panel stays visible until the clip has closed. The open state resets only `transition-delay` to `0s`, so opening shows the panel at once. It sets the delay alone, not the `transition` shorthand, so the swipe block's own reduced-motion rule keeps covering the open state; a shorthand in the higher-specificity open-state rule would outrank that rule and leave only the global rule on line 19 to stop the animation. _Requirements: 2.10_
- `.swipe-dragging` gets `transition:none`, so the clip follows each frame's `--swipe-x` with no lag, the same as the surface. _Requirements: 1.9_
- Reduced motion: the panel joins the swipe block's own reduced-motion rule. The global rule on line 19, `@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`, already removes every transition, so the swipe-block rule records the intent next to the swipe rules without changing behavior. Under reduced motion a close hides the panel at once. _Requirements: 6.1_
- Focus rings move inside the buttons. Panel buttons get the global outset `outline:3px` from `button:focus-visible`, and the row's `overflow:hidden` already clips that ring on the top, bottom and right. The clip would remove the remaining left edge as well, which leaves a focused button in a one-action row with no visible ring at all; that happens for members without delete permission, whose rows only offer 編輯. `outline-offset:-3px` draws each ring inside its button, where neither clip reaches it. The rule sets only the offset, so the global rule's color and width still apply.

What does not change:

- Criterion 1.4 still holds. A clip is not a translation: the panel's `transform` stays identity, so the 6.2 identity assertion on the panel still passes.
- The no-wrapper decision (Option C) stands. The clip needs no new element.
- Every `pointer-events` and `visibility` declaration stays. The dragging panel is still `pointer-events:none`. The open panel is still `pointer-events:auto`, and clipped-out areas take no hits, so while a panel opens only its revealed part is tappable.
- `src/mobile-swipe.js` needs no change. `beginSettle` ends a settle only on a `transitionend` whose `propertyName` is `transform` and whose target is a direct child of the row, so the panel's new `clip-path` and `visibility` `transitionend` events cannot end a settle early.
- The 6.2 check at 1px reads the computed `visibility`, which is still `visible` at the first leftward pixel. The Panel_Visible_Width there is 0, because the tracker writes no offset until the axis locks at 8px, so 6.2 must not expect a non-zero visible width at 1px.

**Alternatives rejected.**

- Put the panel beneath the content, by giving it a lower `z-index` so the content covers it. The surface children have transparent gaps between them and no shared background, so a panel underneath would show through every gap. An opaque surface background needs a wrapper, which Option C rules out.
- Slide the panel in with the content, by translating the panel. This is the other common iOS look, but criterion 1.4 leaves the Action_Panel untranslated.

**Known limitations, recorded but not fixed here.**

- Inside the Rubber_Band_Zone the Row_Surface moves up to 48px further than the panel is wide, so a gap of up to 48px opens between the content and the panel and shows the row's own background.
- When the Swipe_Toggle (the ‹ button) opens a row, the panel's `clip-path` transition starts one or two frames after the surface's `transform` transition. Task 3.2 measured this in headless Chrome 156: the clip started late in 11 of 14 runs (one frame late in 8, two frames late in 3) and on the same frame in the remaining 3.
  - About 100ms in, the Panel_Visible_Width trails the surface translation by 10 to 23px, and by 24px and 46.5px in the worst frames. A strip of the row's background shows between the content and the panel and closes over about 230ms.
  - The toggle-open path is the only one where the panel goes from `visibility:hidden` to visible in the same frame its clip transition starts. These paths all stayed in sync, with 0px error: a gesture settling closed (2 of 2 runs); a gesture settling open from a held drag, where the panel was already visible (3 of 3); the toggle closing a row (4 of 4); and an outside click (2 of 2).
  - The cause is Chrome's composited clip-path animations. Launching Chrome with `--disable-blink-features=CompositeClipPathAnimation` gave 0px error in 3 of 3 runs.
  - Ruled out: style reads by the test harness, a `will-change:clip-path` hint, and keeping the closed panel visible. The last one made the lag worse.
  - Possibly related: Chromium issue 536479735, "CompositeClipPathAnimation: clip-path animation desyncs from same-frame transform on fresh subtree", https://issues.chromium.org/issues/536479735. Only its search summary could be read, because the page requires sign-in.
  - The user accepted this as a known Chrome issue, and the CSS stays as designed. Criterion 2.10 is therefore not met on the toggle-open path in Chromium browsers.
  - iOS Safari has not been tested. Every iPhone browser uses WebKit, which does not run Chrome's compositor code, so it may not show the lag.

**Hit-testing caveat for verification.** The dragging panel is `pointer-events:none`, and its buttons inherit it. `document.elementFromPoint` skips such elements, so a plain hit test during a drag never returns the panel and would report the defect as absent. Checks must set `pointer-events` aside, either with CDP `DOM.getNodeForLocation` and `ignorePointerEventsNone: true`, or with a test-only style that forces `pointer-events:auto` on the dragging panel and its buttons before calling `elementFromPoint`. Hit testing still respects `visibility` and `clip-path`, so once `pointer-events` is set aside the hit result is whatever paints on top at that point. A positive control guards against a broken harness passing as a negative: a hit 2px inside the uncovered strip must return a panel button.

## Schedule Bar Placement

Amendment B, for Requirement 7. The user asked that the button beside the date tabs never be pushed under the dates. They called it 新增下一站; the label in `src/app.js` is `新增一站` and stays as it is. Interpretation: at every width of at least 320px and for every trip length, the Add_Stop_Button stays on the Date_Tabs' row, to their right, and the Date_Tabs scroll sideways to absorb extra days.

The markup does not change. `schedule()` in `src/app.js` renders `<div class="schedule-bar"><div class="date-tabs">…one button per day…</div>${button(icon('plus')+'新增一站','activity','small')}</div>`.

### Current cascade

Line numbers are physical lines of the minified `src/styles.css`. `dist/styles.css` puts `styles.css` first, then `accounts.css`, `scene-motion.css` and `expenses.css`, none of which mention these selectors.

| Line | Condition | Declarations | Effect on the button |
| --- | --- | --- | --- |
| 9 | always | `.schedule-bar{display:flex;align-items:center;justify-content:space-between;gap:12px}`, `.date-tabs{display:flex;gap:12px;padding:0 4px 5px 0;overflow-x:auto}`, `.schedule-bar>.button{white-space:nowrap;flex-shrink:0}` | Same row. The tabs are a scroll container, so their automatic minimum width is 0 and they shrink and scroll, while the button keeps its width. |
| 16 | `max-width:1020px` | `.schedule-bar{flex-wrap:wrap}` | The live defect. From 761 to 1020px the button wraps under the tabs once the tabs' max-content width plus the gap and the button exceeds the bar. Line 41 stacks the sidebar below the main column at 1020px and narrower, so the bar spans the content width. By estimate this needs roughly 5 or more days at 768px and 6 or more at about 900px. |
| 17 | `max-width:760px` | `.schedule-bar{flex-wrap:nowrap}` | Same row. |
| 18 | `max-width:480px` | `.schedule-bar{flex-wrap:wrap;gap:13px}`, `.date-tabs{gap:10px;flex:1;min-width:0}`, `.schedule-bar>.button{margin-left:auto;min-height:44px}` | Latent. `flex-wrap:wrap` does nothing under the line-218 grid. `min-height:44px` is live. |
| 21 | `max-width:480px` | `.date-tabs{flex:1 1 100%;width:100%}`, `.date-tabs>button{…}`, `.date-tabs span{white-space:nowrap}`, `.schedule-bar>.button{margin-left:auto}` | Latent. The full-width tabs rule does nothing, because `flex` does not apply to grid items and line 219's `width:auto` wins. `white-space:nowrap` on the spans is live. |
| 43 | `max-width:480px` | `.schedule-bar{gap:16px}`, `.date-tabs{gap:8px}`, date-button padding and type sizes | Gaps, overridden by lines 218 and 219. No effect on placement. |
| 218 to 221 | `max-width:600px` | `.schedule-bar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:10px}`, `.date-tabs{width:auto;min-width:0;flex:0 1 auto;gap:8px}`, `.date-tabs>button{flex:0 0 auto;min-width:98px;padding:8px}`, `.schedule-bar>.button{align-self:start;margin:0}` | Same row: two grid columns, with the tabs in the shrinkable first one. This matches the user's phone screenshot. |

Net effect today: same row at 760px and below and above 1020px; under the tabs from 761 to 1020px once the days stop fitting beside the button, for example in iPad portrait at 768 or 820px.

### Fix

Delete three declarations and nothing else:

1. Line 16: the whole `.schedule-bar{flex-wrap:wrap}` rule. This removes the live defect, and 761 to 1020px then lays out like the base rule.
2. Line 18: `flex-wrap:wrap` from `.schedule-bar{flex-wrap:wrap;gap:13px}`, leaving `.schedule-bar{gap:13px}`.
3. Line 21: the whole `.date-tabs{flex:1 1 100%;width:100%}` rule.

Items 2 and 3 do nothing today, but they are the declarations that deliberately put the button on its own line under the tabs, and they would take effect again if the line-218 grid were removed or reordered. Every other declaration in those blocks stays, including the live `.schedule-bar>.button{min-height:44px}`, `.date-tabs span{white-space:nowrap}` and `.date-tabs>button{…gap:3px 5px}`. The button's `margin-left:auto` does not move it to a new line, so it stays too; line 221's `margin:0` overrides it at those widths anyway.

No new rule is needed. Without the wraps, every width range keeps the two items on one line. Above 600px the bar is a non-wrapping flex row whose tabs can shrink to zero and scroll while the button keeps its width. At 600px and below it is the two-column grid. The now-redundant `flex-wrap:nowrap` on line 17 stays as a harmless no-op. _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

### Verification

The same sweep runs before the edit and after it. Before the edit, record which width and day-count pairs fail. The cascade above predicts failures only from 761 to 1020px, and with 15 days at every one of those widths. If the baseline shows no failure there, or shows one elsewhere, the harness or this reading of the cascade is wrong, and the task reports that instead of editing. After the edit, every pair passes.

- Widths: 320, 360, 375, 390, 414, 430, 480, 600, 601, 700, 760, 761, 768, 820, 900, 1020, 1021, 1280, 1440.
- Day counts: the demo trip's 3 days, 8 days, and 15 days. The smallest effective Date_Button minimum width is 91px, from 761 to 1020px; it is 98px or 102px elsewhere. Fifteen Date_Buttons at 91px plus their gaps are wider than the Schedule_Bar at every listed width, so 15 days always overflow without relying on a measurement.
- Measure after `document.fonts.ready`, because the date and button widths depend on the loaded font.

Checks for every pair:

| Check | Assertion | Criterion |
| --- | --- | --- |
| Same row | the button's top is above the tabs' bottom | 7.1 |
| To the right | the button's left edge is no more than 1px left of the tabs' right edge | 7.2 |
| One line | every Date_Button has the same `offsetTop` | 7.3 |
| Scrolls | with 15 days, the tabs' `scrollWidth > clientWidth` and computed `overflow-x` is `auto` | 7.4 |
| No page overflow | `documentElement.scrollWidth <= innerWidth` | 7.5 |
| Not squeezed | every Date_Button is at least as wide as its max-content width within 1px; each Date_Label renders as one line box; every Date_Button's `scrollWidth <= clientWidth`. Added by Amendment D and measured as described there | 7.6 |

### Amendment D: date buttons squeezed above 600px

**Finding.** Task 3.3 measured this in headless Chrome.

- Above 600px, when the days do not fit, the date buttons shrink to their `min-width` before the Date_Tabs start scrolling: 98px at 601–760px and 91px at 761–1020px. The base rule sets no `flex`, so the buttons keep the default `flex-shrink:1`.
- A shrunk button wraps its weekday onto a second line. At 91px the text runs about 4px past the button's border.
- This already happened at 601–820px with 8 and 15 days, and at 900–1020px with 15 days. Task 3.3 deleted the 1020px wrap, so the Add_Stop_Button now stays beside the tabs and leaves them less room. That extended the squeeze to 8 days at 900px (96.75 → 91px) and at 1020px (111.75 → 96.25px).
- At 600px and below, line 220 already prevents the shrinking.

**Date-button cascade after task 3.3.** Every rule below uses the selector `.date-tabs>button`, so all of them share one specificity and source order decides. The other stylesheets in `dist/styles.css` do not mention the date tabs.

| Line | Condition | Declarations that affect sizing | Effect |
| --- | --- | --- | --- |
| 9 | always | `display:grid;grid-template-columns:1fr auto;gap:3px 7px;padding:9px 13px;min-width:102px`, and no `flex` | Shrinks to 102px above 1020px. |
| 16 | `max-width:1020px` | `min-width:91px;padding:8px 11px` | Shrinks to 91px at 761–1020px. |
| 17 | `max-width:760px` | `min-width:98px` | Shrinks to 98px at 601–760px. |
| 18 | `max-width:480px` | `min-width:calc((100vw - 68px)/3);padding:9px 12px` | Overridden by lines 43 and 220. |
| 21 | `max-width:480px` | `flex:1;min-width:0;grid-template-columns:1fr auto;gap:3px 5px` | `flex` and `min-width` overridden by line 220, the template by line 43. The gap is live. |
| 43 | `max-width:480px` | `padding:8px;grid-template-columns:1fr;text-align:left` | Live single-column layout. |
| 220 | `max-width:600px` | `flex:0 0 auto;min-width:98px;padding:8px` | No shrinking at 600px and below. |

**Fix.** Add `flex-shrink:0` to the base rule on line 9 and change nothing else.

- From 601px up, no later rule sets `flex` or `flex-shrink`, because lines 16 and 17 set only `min-width` and `padding`. The new declaration applies, and the `min-width` values become floors: each button is as wide as its content or its `min-width`, whichever is larger. The Date_Tabs are already a scroll container, so extra days become scroll. _Requirements: 7.4, 7.6_
- At 481–600px, line 220's `flex:0 0 auto` already sets `flex-shrink:0`, so nothing changes.
- At 480px and below, line 21's `flex:1` would set `flex-shrink:1`. Line 220 comes later at the same specificity, and `max-width:600px` matches there as well, so its `flex:0 0 auto` and `min-width:98px` still win and nothing changes.
- The placement from task 3.3 is unaffected. The Date_Tabs still shrink and scroll as a whole, so criteria 7.1, 7.2 and 7.5 keep holding.

Alternatives rejected:

- `white-space:nowrap` on the labels above 480px keeps each label on one line, but a squeezed button would still push its text past the border.
- A larger `min-width` depends on the font and on the longest date and weekday, so any fixed value is too wide for short labels or too narrow for long ones. `flex-shrink:0` uses each button's own content width.

**Verification.** Task 3.4 reruns the task 3.3 sweep before and after the edit, with the five checks above plus the "Not squeezed" row. The new check runs at every pair. Where the days fit nothing shrinks, so it holds there even without the fix.

- Baseline, as the finding predicts it: the five checks pass at all 57 pairs. The new check fails at 601, 700, 760, 761, 768, 820, 900 and 1020px with 8 and with 15 days, and passes at 600px and below and with 3 days. The finding does not cover 1021px and up, where the shrink floor is 102px, so those pairs are recorded without a prediction. Any other baseline means the harness or the finding is wrong, and the task reports it instead of editing.
- After the edit, all six checks pass at all 57 pairs. At every width from 320 to 480px, each date button also computes `flex-grow:0`, `flex-shrink:0` and `min-width:98px`, which shows that line 220 still overrides line 21.

How the new check measures:

- **Max-content width:** the button's `getBoundingClientRect().width` with inline `flex:none;width:max-content;min-width:0`, read after every button's rendered width has been recorded. The inline style is removed again afterwards.
- **One line box:** a `Range` over the label's contents returns client rects that all share one `top` within 1px. The labels are grid items, so the element's own `getClientRects()` returns one box however many lines its text takes.
- **Inside the border:** the button's `scrollWidth <= clientWidth`.

## Error Handling

| Situation | Handling |
| --- | --- |
| Row has no `--swipe-count`, or it parses to `0` | `endStop` is `0`; `resolveRelease` returns closed and no transform is written. Such rows are never prepared anyway (_Requirements: 5.9_). |
| Second pointer touches during a gesture | Ignored by the `pointerId` guard; the first gesture continues. |
| Row removed from the DOM mid-gesture | The settle batch checks `row.isConnected` and drops the gesture; the existing `scan()` prunes the `rows` set. |
| `transitionend` never fires | 320ms fallback timer clears `.swipe-settling`. |
| Identical timestamps in the sample buffer | `sampleVelocity` returns `null` instead of dividing by zero. At release, `releaseVelocity` turns that `null` into `0` whenever at least one move was sampled, so the halfway rule decides. Only a gesture with no move sample takes the distance rule. |
| Finger held still for more than 100ms before lifting | No `pointermove` arrives during the pause, so the window that ends at the release holds only the release. `releaseVelocity` returns `0` and the halfway rule decides (_Requirements: 2.11_). |
| `pointerup` without a prior `pointerdown` | Handler returns immediately on the absent gesture record. |

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Tracking is one-to-one inside the linear zone

For any start offset, any pointer displacement, and any End_Stop, if the sum of the start offset and the displacement falls between the End_Stop and zero inclusive, then `trackOffset` returns exactly that sum.

**Validates: Requirements 1.2, 1.3**

### Property 2: The rendered offset never escapes its bounds

For any start offset, any pointer displacement, and any End_Stop, `trackOffset` returns a value that is at most zero and at least `End_Stop - 48`; under Reduced_Motion it returns a value at least equal to the End_Stop.

**Validates: Requirements 1.2, 3.2, 3.4, 3.5**

### Property 3: Rubber-band resistance is proportional and capped

For any raw offset past the End_Stop, the distance by which `trackOffset` renders beyond the End_Stop equals the smaller of 48 and 0.3 times the raw overshoot; and of any two raw sums, the smaller never renders to the right of the larger, so `trackOffset` is monotonically non-decreasing in the raw offset.

**Validates: Requirements 3.1, 3.2**

### Property 4: The axis lock is exclusive, dead-zoned, and sticky

For any horizontal and vertical displacement pair, `resolveAxis` returns exactly one of horizontal, vertical, or unresolved; it returns unresolved whenever both displacement magnitudes are below 8; and for any already-resolved lock it returns that same lock regardless of the displacements.

**Validates: Requirements 4.1, 4.2**

### Property 5: Velocity depends only on the final 100ms and is undefined below two samples

For any sample sequence, `sampleVelocity` returns the same value as it does for the subsequence of samples within 100ms of the last sample, and it returns the not-measured value for any sequence of fewer than two samples or any sequence whose window collapses to a single instant.

**Validates: Requirements 2.1, 2.2, 5.1, 5.2**

### Property 6: A flick resolves by direction regardless of distance

For any Drag_Offset, any End_Stop, and any Release_Velocity whose magnitude is at least 0.35 pixels per millisecond, `resolveRelease` resolves to open when the velocity is leftward and to closed when the velocity is rightward.

**Validates: Requirements 2.1, 2.2**

### Property 7: Below the flick threshold the halfway rule decides

For any Drag_Offset, any End_Stop, and any Release_Velocity whose magnitude is below 0.35 pixels per millisecond, `resolveRelease` resolves to open if and only if the Drag_Offset magnitude is at least half the End_Stop magnitude.

**Validates: Requirements 2.3, 2.4, 3.3**

### Property 8: With no measurable velocity the legacy distance rule decides

For any horizontal displacement and any prior row state, when the velocity is the not-measured value and the release axis is horizontal, `resolveRelease` resolves to open if the displacement is at least 56 pixels leftward, to closed if it is at least 42 pixels rightward, and to the prior state otherwise.

**Validates: Requirements 5.1, 5.2**

### Property 9: Reduced motion changes only the rubber band

For any start offset, any displacement, and any End_Stop, `trackOffset` returns the same value with and without the Reduced_Motion flag whenever the clamped sum lies between the End_Stop and zero, and returns exactly the End_Stop with the flag set whenever the raw sum lies past the End_Stop.

**Validates: Requirements 6.2, 6.3**

### Property 10: A gesture suppresses a click only after real travel

For any axis state and any horizontal displacement, `shouldSuppressClick` returns true if and only if the axis resolved to horizontal or the displacement magnitude is at least 42 pixels, and therefore returns false for a zero-displacement tap.

**Validates: Requirements 2.9**

### Property 11: The release velocity covers the 100ms that end at the release

For any sample trace and any release no earlier than the trace's last sample, `releaseVelocity` returns the not-measured value if and only if the trace is empty. For a non-empty trace, when some sample falls in the 100ms before the release instant, it returns the slope from the earliest such sample to the release; otherwise it returns 0, which covers every release more than 100ms after the last sample and every window whose samples share the release's timestamp.

**Validates: Requirements 2.1, 2.2, 2.11, 5.1, 5.2**

### Rendering and layout amendments add no properties

Criteria 1.9, 2.10 and 7.1 to 7.6 are rendering and layout outcomes. No JavaScript function computes them: the clip, the schedule-bar placement and the date-button widths live in CSS, and the risk sits in how the browser paints, clips, hit-tests and lays out, which only a real browser shows. A few drag distances and an enumerated list of widths on both sides of every breakpoint cover them, and generated inputs would not find more. They are verified with browser example checks (tasks 3.2, 3.3, 3.4, 6.2, 6.8 and 6.10). Amendment C is the exception: `releaseVelocity` is a pure function, so it adds Property 11, and Properties 1 to 10 are unchanged.

## Testing Strategy

### Unit tests — `bun test tests/mobile-swipe.test.js`

Covers the exported pure functions and the frame writer. No DOM, no browser. The repository has no property-based testing dependency and the design does not add one, so each property is driven by a seeded deterministic generator defined in the test file (a small `mulberry32` PRNG), run for at least 200 iterations per property, printing the failing sample on assertion failure so a counterexample is reproducible from the seed.

| Target | Coverage |
| --- | --- |
| `resolveAxis` | Property 4 |
| `trackOffset` | Properties 1, 2, 3, 9 |
| `sampleVelocity` | Property 5, plus explicit zero-sample and one-sample cases |
| `releaseVelocity` | Property 11, plus explicit empty-trace, same-timestamp and pause cases |
| `resolveRelease` | Properties 6, 7, 8 |
| `shouldSuppressClick` | Property 10 |
| `createFrameWriter` | Example test with a fake `raf`/`caf`: many `push` calls between flushes produce exactly one `write` carrying the newest value (_Requirements: 1.8_) |
| gating predicate | Example tests over the enumerable combinations of layout, pointer type and target kind (_Requirements: 1.1, 4.7_) |

### End-to-end tests — `playwright test tests/mobile-swipe.e2e.js`

New file, at a 390×900 viewport on `/demo/`, driving real `page.mouse`/`page.touchscreen` sequences with intermediate moves.

| Scenario | Criteria |
| --- | --- |
| Drag 40px left, read the computed `translateX` of a surface child, assert it matches the displacement within 1px; assert the panel and toggle transforms stay at identity; assert `transition-duration` is `0s` mid-drag | 1.3, 1.4, 1.5 |
| Move 1px left, assert the panel is visible before release | 1.6 |
| Open row A, then drag row B, assert A closed | 1.7 |
| Drag 20px left then release fast, assert open; drag 100px left then release fast rightward, assert closed | 2.1, 2.2 |
| Drag past half the panel width and release slowly, assert open; drag under half and release slowly, assert closed | 2.3, 2.4 |
| Read `transition-duration` for both directions, assert equal and at most 320ms; after settling assert the computed translation equals the resting value within 1px and no inline `--swipe-x` remains | 2.5, 2.6 |
| Assert `aria-hidden` and `aria-expanded` after opening and after closing | 2.7, 2.8 |
| Drag past the end stop, assert the rendered overshoot is within the 48px cap and smaller than the raw overshoot; release and assert open | 3.1, 3.2, 3.3 |
| Drag an open row rightward past zero, assert the translation holds at zero | 3.5 |
| Mostly vertical drag: assert no `swipe-dragging` class, assert the page scrolled; mostly horizontal drag: assert `scrollY` unchanged | 4.3, 4.4 |
| Start a drag then dispatch `pointercancel`, assert the prior state is restored and the inline value cleared | 4.5 |
| Open at 390px, resize to 1440px, assert closed and no inline value | 4.6 |
| Assert the clone conventions on a prepared row; add an activity and assert the new row gets a panel; re-render repeatedly and assert exactly one panel per row | 5.4, 5.5 |
| Toggle a row twice and assert inversion plus closure of others; click the page background and assert all closed; swipe then assert the following click is swallowed | 5.6, 5.7, 2.9 |
| Disabled-only action row gets no panel and no toggle | 5.9 |
| Under `prefers-reduced-motion: reduce` emulation: assert `transition-duration` is `0s` on settle, the final translation is correct, tracking still follows the finger 1:1, and the translation holds at the end stop past it; change the emulation between two gestures and assert the second follows the new branch | 6.1, 6.2, 6.3, 6.4 |
| Amendment A, in 6.2: at 20, 68 and 136px of drag on a two-action row, a hit 2px inside the uncovered strip returns a panel button, a hit 2px outside it (where that point is still inside the panel box) returns a node outside the panel, and the panel width minus the computed `clip-path` left inset matches the surface `translateX` magnitude within 1px. Hits must set `pointer-events` aside, as described under "Hit-testing caveat for verification" | 1.9 |
| Amendment C, in 6.9: drag a two-action row 40px left in three frames, wait 200ms with no pointer events, release, and assert closed; the same with 100px, assert open. Check from the recorded samples that each drag measured at least 0.35px/ms before the pause, so the closed result comes from the pause | 2.11 |

Correction found while amending: `page.mouse` reports `pointerType: 'mouse'`, which the controller ignores, and Playwright's `page.touchscreen` can only tap. The drags in this file therefore cannot come from `page.mouse` or `page.touchscreen` as the paragraph above the table says. They need synthetic touch `PointerEvent`s, as `tests/app.e2e.js` dispatches, or a CDP session's `Input.dispatchTouchEvent`.

### Regression

`tests/app.e2e.js` is **not modified**. Its `pointerdown`/`pointerup` pair with no intervening move exercises the zero-sample path: `releaseVelocity` returns the not-measured value, `resolveRelease` takes the legacy branch, the 85px leftward displacement clears the 56px open threshold, and the row opens with the cloned actions visible and the delete dialog reachable. That file passing unchanged is the verification for criteria 5.1, 5.2 and 5.3.

### Layout regression — `playwright test tests/schedule-bar.e2e.js`

Task 6.8 adds a separate file, so it never shares a file with the `tests/mobile-swipe.e2e.js` tasks. It runs the sweep from Schedule Bar Placement on `/demo/`. The longer trips come from the settings dialog (旅行設定, then 編輯旅行, then 結束日期), the same path `tests/app.e2e.js` uses. It covers criteria 7.1 to 7.5. Task 6.10 adds the "Not squeezed" check from Amendment D to the same sweep, which covers criterion 7.6.

### Browser checks while Node is unavailable

Bun 1.4.4 is installed, while Node.js, npx and the Playwright runner are not, so the Playwright files above wait until Node is installed. Tasks 3.2, 3.3, 3.4 and 4.5 verify in a browser now, the way an earlier task verified CSS: a throwaway Bun script launches `C:/Program Files/Google/Chrome/Application/chrome.exe` headless with a temporary `--user-data-dir` and its own `--remote-debugging-port`, and drives it over CDP. The script targets the server already running at `http://127.0.0.1:5173`, which serves `dist/` and reads files per request, so `bun scripts/build.mjs` is picked up without a restart. No task starts a second server on 5173 or stops the running one. Criterion 2.10 is verified only by task 3.2's browser check; it has no Playwright regression.
