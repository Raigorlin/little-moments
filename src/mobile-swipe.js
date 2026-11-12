const ROW_SELECTOR = '[data-swipe-row]';
const ACTION_SELECTOR = [
  '[data-action="activity"]', '[data-action="meal"]', '[data-action="shopping"]',
  '[data-action="gear"]', '[data-action="vehicle"]', '[data-action="person"]', '[data-action="delete"]',
  '[data-action^="acct-edit-"]', '[data-action^="acct-delete-"]',
  '[data-xp="edit-expense"]', '[data-xp="ask-remove-expense"]',
  '[data-xp="ask-remove-settlement"]'
].join(',');
// Geometry and physics constants. See .kiro/specs/mobile-smooth-swipe/design.md.
const ACTION_WIDTH = 68;        // panel geometry: calc(var(--swipe-count)*68px)
const AXIS_BIAS = 1.25;         // horizontal/vertical dominance ratio
const AXIS_DEADZONE = 8;        // px of travel before the axis can resolve
const FLICK_THRESHOLD = 0.35;   // px/ms
const VELOCITY_WINDOW = 100;    // ms of samples used for the release velocity
const RUBBER_RESIST = 0.3;      // fraction of the overshoot that is rendered
const RUBBER_MAX = 48;          // px cap on the rendered overshoot
const SETTLE_MS = 260;          // settle duration, mirrors the CSS `.26s`
const LEGACY_OPEN = 56;         // release-only distance rule, open
const LEGACY_CLOSE = 42;        // release-only distance rule, close
const CLICK_SUPPRESS_MS = 450;  // click swallowed after a gesture
// `transitionend` never fires under reduced motion or for a settle with zero
// distance, so this timer is the only thing that clears `.swipe-settling` in
// those cases. It sits at the 320ms budget from Requirement 2.5, which is above
// the SETTLE_MS transition, so it cannot fire while a real settle is running.
const SETTLE_FALLBACK_MS = 320;

/**
 * Axis lock. Returns 'horizontal', 'vertical', or null while unresolved.
 * Once `locked` is non-null the answer is sticky for the rest of the gesture.
 * Horizontal wins an exact tie, which keeps the two outcomes mutually exclusive.
 */
export function resolveAxis(dx, dy, locked = null) {
  if (locked) return locked;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax >= AXIS_DEADZONE && ax >= ay * AXIS_BIAS) return 'horizontal';
  if (ay >= AXIS_DEADZONE && ay > ax * AXIS_BIAS) return 'vertical';
  return null;
}

/**
 * Drag_Offset for a pointer displacement, including the closed clamp and the
 * rubber band. `endStop` is negative. `reduced` is true while Reduced_Motion
 * applies, in which case the offset holds exactly at the end stop.
 */
export function trackOffset(startOffset, dx, endStop, reduced = false) {
  const raw = startOffset + dx;
  if (raw >= 0) return 0;          // closed clamp
  if (raw >= endStop) return raw;  // linear zone, 1:1 with the finger
  if (reduced) return endStop;
  const overshoot = endStop - raw; // positive
  return endStop - Math.min(RUBBER_MAX, overshoot * RUBBER_RESIST);
}

/**
 * Release_Velocity in px/ms over the final `window` milliseconds, negative
 * leftward. Returns null when it cannot be measured, which is the signal for
 * the legacy distance path: fewer than two samples carries no rate, and a
 * window that collapses to a single instant would divide by zero. null is not
 * zero — zero would mean "measured, and the finger was stationary", which
 * routes the gesture into the halfway rule.
 */
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

/**
 * Release_Velocity in px/ms over the 100ms that end at the release, with the
 * release counted as the last sample. `release` is { x: event.clientX,
 * t: performance.now() } taken at pointerup, on the same clock as `samples`.
 * Returns null only for an empty trace, the signal for the legacy distance
 * rule. When no sample falls in the 100ms before the release instant, after a
 * pause or when the only moves share the release's timestamp, `sampleVelocity`
 * returns null and this reads it as a stationary finger, 0, so the halfway
 * rule decides and the result does not depend on timer resolution.
 */
export function releaseVelocity(samples, release) {
  if (!samples || samples.length === 0) return null;
  return sampleVelocity([...samples, release]) ?? 0;
}

/**
 * Resolve the post-release state. Returns true for open, false for closed.
 * A rubber-band release needs no branch: an offset at or past the end stop
 * always exceeds half the end stop, so the halfway rule resolves it to open.
 */
export function resolveRelease({ offset, endStop, velocity, totalDx, totalDy, axis, wasOpen }) {
  if (!endStop) return false;
  if (velocity === null) {
    const releaseAxis = axis ?? resolveAxis(totalDx, totalDy);
    if (releaseAxis !== 'horizontal') return wasOpen;
    if (totalDx <= -LEGACY_OPEN) return true;
    if (totalDx >= LEGACY_CLOSE) return false;
    return wasOpen;
  }
  if (Math.abs(velocity) >= FLICK_THRESHOLD) return velocity < 0;
  return Math.abs(offset) >= Math.abs(endStop) / 2;
}

/**
 * Whether the click that follows this gesture should be swallowed. The
 * distance clause is the 42px rule; the axis clause additionally covers a fast
 * short flick, which changes state over less than 42px and must not also fire
 * a click. A tap satisfies neither, because resolving the axis needs 8px.
 */
export function shouldSuppressClick(axis, totalDx) {
  return axis === 'horizontal' || Math.abs(totalDx) >= LEGACY_CLOSE;
}

/**
 * Per-frame coalescing writer. Every `pointermove` calls `push`; only the
 * first push of a frame schedules a callback, and later pushes in the same
 * frame overwrite the pending value. So a burst of coalesced or high-rate
 * pointer events produces exactly one `write` per rendered frame, carrying the
 * newest value. `raf`/`caf` are injected so a unit test can drive the writer
 * with a fake scheduler and no browser; the defaults are evaluated at call
 * time, so importing this module without a DOM is safe.
 *
 * The three methods are closure-scoped functions rather than `this`-dependent
 * object methods, so they keep working when destructured or detached.
 */
export function createFrameWriter(write, raf = requestAnimationFrame, caf = cancelAnimationFrame) {
  let handle = 0;
  let pending = null;

  function cancel() {
    if (handle) caf(handle);
    handle = 0;
    pending = null;
  }

  function push(value) {
    pending = value;
    if (handle) return;
    handle = raf(() => {
      handle = 0;
      const next = pending;
      pending = null;
      write(next);
    });
  }

  function flushTarget(value) {
    cancel();
    write(value);
  }

  return { push, flushTarget, cancel };
}

export function enableSwipeActions(root = document.body) {
  let start = null;
  let suppressClickUntil = 0;
  const rows = new Set();
  // Per-row settle bookkeeping: `row -> { timer, onEnd }`. Keyed by row rather
  // than held on the gesture record, because a settle outlives the gesture that
  // started it. `beginSettle` ends any settle already in flight on the row, so
  // at most one timer and one listener exist per row at any moment and a
  // consecutive gesture cannot be cut short by its predecessor's cleanup.
  const settles = new Map();
  const touchLayout = matchMedia('(max-width: 760px)');
  // Held for the controller's lifetime, following the `setupSceneMotion`
  // precedent in `src/scene-motion.js`. `.matches` is read fresh on every move
  // rather than cached, so a preference change applies to the next gesture
  // without a reload.
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // `pointermove`/`pointerup`/`pointercancel` live on the document, not on the
  // row, so a finger that leaves the row keeps delivering events. Resolved once
  // so the disposer detaches from exactly the target it attached to.
  const pointerTarget = root.ownerDocument ?? document;

  /**
   * End_Stop for a row, read from the `--swipe-count` inline property that
   * `prepare()` sets. A missing or zero count yields `0`, which makes the row
   * inert: `trackOffset` writes nothing useful and `resolveRelease` returns
   * closed.
   */
  function readEndStop(row) {
    const count = Number.parseInt(row.style.getPropertyValue('--swipe-count'), 10);
    if (!Number.isFinite(count) || count <= 0) return 0;
    return -(count * ACTION_WIDTH);
  }

  /**
   * Whether this pointer event belongs to the gesture in flight. A second
   * finger landing mid-gesture carries a different `pointerId` and is ignored,
   * so the first gesture continues undisturbed. A synthetic event that carries
   * no `pointerId` at all is accepted, because there is no other pointer it
   * could belong to.
   */
  function isGestureEvent(event) {
    if (!start) return false;
    return event.pointerId === undefined || event.pointerId === start.pointerId;
  }

  function closeRows(except = null) {
    for (const row of rows) {
      if (row !== except) setOpen(row, false);
    }
  }
  function setOpen(row, open) {
    row.classList.toggle('swipe-open', open);
    row.querySelector('.swipe-actions')?.setAttribute('aria-hidden', String(!open));
    row.querySelector('.swipe-toggle')?.setAttribute('aria-expanded', String(open));
  }
  function prepare(row) {
    if (row.dataset.swipeReady === 'true') return;
    const controls = [...row.querySelectorAll(ACTION_SELECTOR)];
    const sourceButtons = controls.filter(button => !button.disabled);
    if (!sourceButtons.length) return;
    const panel = document.createElement('div');
    panel.className = 'swipe-actions';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', '滑動操作');
    panel.setAttribute('aria-hidden', 'true');
    for (const button of sourceButtons) {
      const copy = button.cloneNode(true);
      const label = button.getAttribute('aria-label') || button.textContent.trim();
      const swipeLabel = /編輯/.test(label) ? '編輯' : /移除|刪除/.test(label) ? '刪除' : '操作';
      const icons = [...copy.querySelectorAll('svg')];
      copy.replaceChildren(...icons);
      copy.removeAttribute('id');
      copy.setAttribute('aria-label', label || swipeLabel);
      copy.dataset.swipeLabel = swipeLabel;
      copy.classList.add('swipe-action');
      if (button.classList.contains('danger') || swipeLabel === '刪除') {
        copy.classList.add('swipe-action-danger');
      }
      panel.append(copy);
    }
    controls.forEach(button => { button.dataset.swipeOriginal = 'true'; });
    row.style.setProperty('--swipe-count', String(panel.children.length));
    row.append(panel);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'swipe-toggle';
    toggle.setAttribute('aria-label', '顯示編輯與刪除操作');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '‹';
    row.append(toggle);
    row.dataset.swipeReady = 'true';
    row.classList.add('swipe-row');
    rows.add(row);
  }
  function scan(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches(ROW_SELECTOR)) prepare(node);
    node.querySelectorAll(ROW_SELECTOR).forEach(prepare);
    for (const row of rows) if (!row.isConnected) rows.delete(row);
  }

  scan(root);
  const observer = new MutationObserver(records => records.forEach(record => {
    record.addedNodes.forEach(scan);
    if (record.type === 'attributes' && record.target.matches?.(ROW_SELECTOR)) prepare(record.target);
  }));
  observer.observe(root, { subtree: true, childList: true });

  function onPointerDown(event) {
    if (start) return;  // a gesture is already in flight; ignore the second touch
    suppressClickUntil = 0;
    if (!touchLayout.matches || !['touch', 'pen'].includes(event.pointerType)) return;
    const row = event.target.closest?.(`${ROW_SELECTOR}.swipe-row`);
    if (!row || event.target.closest('button,a,input,select,textarea,summary')) return;
    const endStop = readEndStop(row);
    // Read the start offset from the state class, not from the computed style,
    // so it is exactly 0 or the End_Stop even mid-transition.
    const wasOpen = row.classList.contains('swipe-open');
    const startOffset = wasOpen ? endStop : 0;
    start = {
      row,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startOffset,
      endStop,
      wasOpen,
      axis: null,
      offset: startOffset,
      samples: [],
      dragging: false,
      writer: createFrameWriter(value => row.style.setProperty('--swipe-x', `${value}px`))
    };
  }
  function onPointerMove(event) {
    if (!isGestureEvent(event)) return;
    const { row, samples } = start;

    // `performance.now()` rather than `event.timeStamp`: a synthetic event can
    // carry a zero timestamp, which would make the whole buffer collapse onto
    // one instant and produce a bogus rate.
    samples.push({ x: event.clientX, t: performance.now() });
    // Prune entries more than VELOCITY_WINDOW older than the newest move. The
    // loop keeps at most one entry older than the window, and `sampleVelocity`
    // never reads an entry older than its window, so that entry affects no
    // velocity; the prune only bounds the buffer at the in-window samples plus
    // one. Pruning from the newest move is also safe for `releaseVelocity`,
    // whose window ends at the release: the release comes at or after the
    // newest move, so every entry its window can include is still here.
    const newest = samples[samples.length - 1].t;
    while (samples.length > 2 && newest - samples[1].t > VELOCITY_WINDOW) samples.shift();

    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    const priorAxis = start.axis;
    start.axis = resolveAxis(dx, dy, priorAxis);  // sticky once resolved

    if (start.axis === 'vertical') {
      // Hand the gesture back to the browser. `--swipe-x` is deliberately left
      // as it is, so the rendered translation stays at the translation the row
      // held when the gesture started, and no `preventDefault` runs.
      if (start.dragging) {
        start.dragging = false;
        row.classList.remove('swipe-dragging');
      }
      start.writer.cancel();
      return;
    }

    // The second clause is how the panel can be revealed at the first leftward
    // pixel while the axis still needs 8px to resolve. `start.dragging` keeps
    // the classList touched only on a transition.
    if (!start.dragging && (start.axis === 'horizontal' || (!start.wasOpen && dx <= -1))) {
      start.dragging = true;
      row.classList.add('swipe-dragging');
    }

    if (start.axis !== 'horizontal') return;

    event.preventDefault();
    start.offset = trackOffset(start.startOffset, dx, start.endStop, reducedMotion.matches);
    // Through the writer, never straight to the style property: the writer
    // coalesces a burst of pointer events into one write per rendered frame.
    start.writer.push(start.offset);

    // The axis is sticky, so a null-to-horizontal transition happens exactly
    // once per gesture. That is the first horizontal resolution.
    if (!priorAxis) closeRows(row);
  }
  /**
   * Drop the settle in flight on a row: clear the fallback timer, detach the
   * `transitionend` listener, and release the `will-change` hint that
   * `.swipe-settling` carries. Idempotent, so it is safe to call for a row that
   * is not settling.
   */
  function endSettle(row) {
    const settle = settles.get(row);
    if (!settle) return;
    settles.delete(row);
    clearTimeout(settle.timer);
    row.removeEventListener('transitionend', settle.onEnd);
    row.classList.remove('swipe-settling');
  }

  /**
   * Hold `.swipe-settling` on a row until its transform transition ends.
   *
   * The first act is to end any settle still in flight on this row. That is
   * what keeps consecutive gestures independent: without it, gesture N's
   * fallback timer or `transitionend` listener would still be armed when
   * gesture N+1 settles, and firing then would strip `.swipe-settling` and drop
   * the compositor hint in the middle of gesture N+1's animation.
   *
   * The listener is removed explicitly rather than registered with
   * `{ once: true }`, because it filters the events it accepts: a `once`
   * listener would be spent by the first unrelated `transitionend` bubbling up
   * from a descendant and would stop watching for the one that matters.
   */
  function beginSettle(row) {
    endSettle(row);
    row.classList.add('swipe-settling');
    const settle = { timer: 0, onEnd: null };
    // Only the surface transform ends the settle. Surface children are direct
    // children of the row by the CSS contract, so a transform transition on a
    // descendant such as a panel button is not this settle finishing.
    settle.onEnd = event => {
      if (event.propertyName !== 'transform' || event.target.parentElement !== row) return;
      endSettle(row);
    };
    settles.set(row, settle);
    row.addEventListener('transitionend', settle.onEnd);
    settle.timer = setTimeout(() => endSettle(row), SETTLE_FALLBACK_MS);
  }

  /**
   * The settle batch, shared by the release and cancel paths so the two cannot
   * drift. Every mutation happens in one synchronous sequence with no
   * intervening style read, so the browser performs a single style
   * recalculation in which the transform's before-change value is the drag
   * offset and its after-change value is the resting value of `open`. That is
   * exactly the condition that starts a transition, so the row animates from
   * wherever the finger left it to the resting position.
   *
   * Order matters. Removing `.swipe-dragging` re-enables the base transition,
   * and removing the inline `--swipe-x` last hands the value back to the class
   * rule within the same recalculation.
   *
   * The batch also owns cleanup, which is why every gesture runs it even when
   * the resolved state equals the state the row started in: a partial drag
   * leaves `.swipe-dragging` and an inline `--swipe-x` behind, and only this
   * batch clears them.
   */
  function settleGesture(gesture, open) {
    const { row } = gesture;
    // A wholesale re-render can replace the row mid-drag. Mutating a detached
    // node would strand `.swipe-settling` and a timer on something nothing
    // renders, so the gesture is dropped instead; `scan()` prunes `rows`.
    if (!row.isConnected) return;
    row.classList.remove('swipe-dragging');
    beginSettle(row);
    if (open) closeRows(row);
    setOpen(row, open);
    row.style.removeProperty('--swipe-x');
  }

  function onPointerUp(event) {
    if (!isGestureEvent(event)) return;
    const gesture = start;
    // Read the displacement off the record before it is cleared.
    const totalDx = event.clientX - gesture.x;
    const totalDy = event.clientY - gesture.y;
    // The release counts as the last sample, so the 100ms window ends at the
    // release rather than at the last move, and a finger that paused before
    // lifting measures 0 and settles by position. `null` now comes only from a
    // `pointerdown`/`pointerup` pair with no move in between. The decision is
    // left entirely to `resolveRelease`, which dispatches that case to the
    // legacy distance rule.
    const velocity = releaseVelocity(gesture.samples, { x: event.clientX, t: performance.now() });
    const open = resolveRelease({
      offset: gesture.offset,
      endStop: gesture.endStop,
      velocity,
      totalDx,
      totalDy,
      axis: gesture.axis,
      wasOpen: gesture.wasOpen
    });
    gesture.writer.cancel();
    // Cleared before the batch, which mutates the DOM and can dispatch
    // synchronously into other listeners; none of them may see a live gesture.
    start = null;
    settleGesture(gesture, open);
    // Also true for a fast short flick, which changes state over less than the
    // 42px the old distance-only rule required.
    if (shouldSuppressClick(gesture.axis, totalDx)) {
      suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    }
  }
  function onPointerCancel(event) {
    if (!isGestureEvent(event)) return;
    const gesture = start;
    gesture.writer.cancel();
    start = null;
    // The same batch, resolved to the state the row held when the gesture
    // started, and with no click suppression: the browser took the gesture
    // away, so there is no click of ours to swallow.
    settleGesture(gesture, gesture.wasOpen);
  }
  function onClick(event) {
    const toggle = event.target.closest?.('.swipe-toggle');
    if (toggle) {
      const row = toggle.closest(ROW_SELECTOR);
      closeRows(row);
      setOpen(row, !row.classList.contains('swipe-open'));
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (performance.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.target.closest('.swipe-actions')) closeRows();
  }
  /**
   * Drop the gesture in flight, if any, without settling it. The writer is
   * cancelled so a frame already scheduled cannot write `--swipe-x` back onto
   * a row that the caller is about to clean, and `start` is cleared before the
   * caller touches the DOM so no listener can observe a live gesture.
   *
   * Used only by the two paths that end a gesture without a resolution: the
   * viewport leaving Touch_Layout, and teardown. A gesture that ends normally
   * goes through `settleGesture` instead.
   */
  function abandonGesture() {
    if (!start) return;
    start.writer.cancel();
    start = null;
  }

  /**
   * Return a row to a clean resting state: no settle armed, no transient
   * classes, no inline translation. Shared by `onLayoutChange` and the
   * disposer so the two definitions of "clean" cannot drift.
   *
   * `endSettle` is used rather than `beginSettle`, so the row snaps instead of
   * animating. Neither caller is a gesture, and in both cases there is no
   * transition to wait for: the base transition rule lives inside
   * `@media (max-width:760px)`, so by the time `touchLayout` reports
   * non-matching the rule no longer applies, and after teardown nothing is
   * driving the row anyway. Arming a settle would leave `.swipe-settling` and
   * a timer waiting on a `transitionend` that can never arrive.
   *
   * The row's `.swipe-open` state class is deliberately left alone. It is
   * resting state, not transient, and teardown has no business changing what
   * the user sees; the caller closes rows when the requirement calls for it.
   */
  function resetRow(row) {
    endSettle(row);
    row.classList.remove('swipe-dragging');
    row.style.removeProperty('--swipe-x');
  }

  /**
   * Touch_Layout changed. Leaving the breakpoint has to clear the gesture's
   * traces, because the CSS that renders them stops applying: the inline
   * `--swipe-x` would linger as a stale value on a row that no longer reads it,
   * and `.swipe-dragging`/`.swipe-settling` would be left behind with nothing
   * to remove them.
   *
   * Run unconditionally rather than only on the non-matching edge. In the
   * entering direction a gesture cannot be in flight and no row can hold an
   * inline value, because `onPointerDown` gates on `touchLayout.matches`, so
   * everything after `abandonGesture` is a no-op there apart from `closeRows`,
   * which is the behavior this handler already had.
   */
  function onLayoutChange() {
    abandonGesture();
    closeRows();
    for (const row of rows) resetRow(row);
  }

  /**
   * Reduced_Motion changed. There is nothing to do: `reducedMotion.matches` is
   * read fresh inside `onPointerMove`, and the settle reads the preference
   * through the CSS cascade rather than through JavaScript, so the new value
   * takes effect from the next pointer event onward with no reload. Nothing is
   * cached, so there is nothing to invalidate.
   *
   * A gesture already in flight is left as it is. The only observable
   * difference a mid-gesture flip could make is a finger held still inside the
   * Rubber_Band_Zone at the instant of the change, and the next `pointermove`
   * recomputes the offset against the new preference regardless. Requirement
   * 6.4 asks only that the change reach the next gesture.
   *
   * The listener still has to exist, so that the preference is observed at all
   * and so the disposer has a registration to remove.
   */
  function onMotionPreferenceChange() {}

  touchLayout.addEventListener('change', onLayoutChange);
  reducedMotion.addEventListener('change', onMotionPreferenceChange);
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('click', onClick, true);
  pointerTarget.addEventListener('pointermove', onPointerMove, true);
  pointerTarget.addEventListener('pointerup', onPointerUp, true);
  pointerTarget.addEventListener('pointercancel', onPointerCancel, true);
  return () => {
    observer.disconnect();
    touchLayout.removeEventListener('change', onLayoutChange);
    reducedMotion.removeEventListener('change', onMotionPreferenceChange);
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('click', onClick, true);
    pointerTarget.removeEventListener('pointermove', onPointerMove, true);
    pointerTarget.removeEventListener('pointerup', onPointerUp, true);
    pointerTarget.removeEventListener('pointercancel', onPointerCancel, true);
    abandonGesture();
    // `settles` is drained by its own keys, not through `rows`. `scan()` prunes
    // a disconnected row out of `rows`, so a row that was re-rendered while its
    // settle was in flight is reachable from `settles` and from nowhere else;
    // iterating `rows` alone would leave that row's fallback timer armed and
    // its `transitionend` listener attached past teardown. Snapshotted because
    // `endSettle` deletes from the map it is iterating.
    for (const row of [...settles.keys()]) endSettle(row);
    for (const row of rows) resetRow(row);
  };
}
