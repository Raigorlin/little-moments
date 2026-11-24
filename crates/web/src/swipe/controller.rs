//! 事件監聽、手勢狀態、每個動畫影格一次的寫入、收尾計時與卸載（design 4.3）。
//!
//! Ported from `enableSwipeActions` in `src/mobile-swipe.js`. The row registry
//! of the Bun controller is replaced by reading `.swipe-row` from the DOM, as
//! `rows::close_rows` does.
//!
//! Every listener is a `Closure<dyn Fn(Event)>`. A `Fn` closure may be invoked
//! reentrantly, which matters for the click handler: delegating a copy's click
//! to its original dispatches a nested `click` through the same listener. No
//! `RefCell` borrow is held while foreign code (`HtmlElement::click`) runs.
//! Dropping a closure while it is executing is safe: the wasm-bindgen glue
//! defers the destruction until the call returns.

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use gloo_timers::callback::Timeout;
use js_sys::{Array, Reflect};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{
    AddEventListenerOptions, Element, Event, EventTarget, HtmlElement, MediaQueryList,
    MutationObserver, MutationObserverInit, Performance, Window,
};

use super::physics::{
    prune_samples, release_velocity, resolve_axis, resolve_release, should_suppress_click,
    track_offset, Axis, Release, Sample, ACTION_WIDTH, CLICK_SUPPRESS_MS, SETTLE_FALLBACK_MS,
};
use super::rows::{self, INTERACTIVE, ROW, ROW_ACTION};

const TOUCH_LAYOUT: &str = "(max-width: 760px)";
const REDUCED_MOTION: &str = "(prefers-reduced-motion: reduce)";
/// A row that `rows::reconcile` has prepared.
const PREPARED_ROW: &str = "[data-swipe-row].swipe-row";
/// A `.swipe-action` copy inside a Swipe_Panel.
const COPY: &str = ".swipe-actions > .swipe-action";
const OBSERVED_ATTRIBUTES: [&str; 3] = ["data-swipe-row", "disabled", "aria-label"];

/// 掛在旅行頁工作區上的滑動控制器。`Drop` 移除所有監聽並把列還原成靜止狀態（Requirement 5.17）。
pub struct SwipeController {
    inner: Rc<Inner>,
    observer: Option<Observer>,
    listeners: Vec<Listener>,
}

/// Shared by every listener.
struct Inner {
    /// The `Rc` this value lives in, for callbacks that must not keep it alive.
    weak: Weak<Inner>,
    root: Element,
    /// None when `matchMedia` or `performance` is unavailable: rows are still
    /// prepared, but no gesture listener is registered.
    env: Option<Env>,
    state: RefCell<State>,
}

struct Env {
    window: Window,
    performance: Performance,
    touch_layout: MediaQueryList,
    /// Held for the controller's lifetime; `.matches()` is read on every move.
    reduced_motion: Option<MediaQueryList>,
}

#[derive(Default)]
struct State {
    gesture: Option<Gesture>,
    suppress_click_until: f64,
    /// At most one per row.
    settles: Vec<Settle>,
    /// True while a copy's click is being delegated to its original, so the
    /// nested click passes through untouched.
    delegating: bool,
}

struct Gesture {
    row: HtmlElement,
    /// `event.pointerId`, None when the event carried none.
    pointer_id: Option<f64>,
    x: f64,
    y: f64,
    start_offset: f64,
    end_stop: f64,
    was_open: bool,
    axis: Option<Axis>,
    offset: f64,
    samples: Vec<Sample>,
    dragging: bool,
    writer: FrameWriter,
}

/// A settle in flight: `swipe-settling` is removed by whichever of the
/// `transitionend` listener and the fallback timer fires first.
struct Settle {
    row: Element,
    _timer: Timeout,
    on_end: Closure<dyn Fn(Event)>,
}

/// `createFrameWriter`: one `--swipe-x` write per animation frame with the
/// newest pushed value. Dropping the writer cancels a scheduled frame.
struct FrameWriter {
    window: Window,
    pending: Rc<Cell<Option<f64>>>,
    handle: Rc<Cell<Option<i32>>>,
    frame: Closure<dyn Fn()>,
}

impl FrameWriter {
    fn new(window: &Window, row: &HtmlElement) -> FrameWriter {
        let pending = Rc::new(Cell::new(None));
        let handle = Rc::new(Cell::new(None));
        let frame = {
            let (pending, handle, row) = (pending.clone(), handle.clone(), row.clone());
            Closure::<dyn Fn()>::new(move || {
                handle.set(None);
                if let Some(value) = pending.take() {
                    let _ = row.style().set_property("--swipe-x", &px(value));
                }
            })
        };
        FrameWriter {
            window: window.clone(),
            pending,
            handle,
            frame,
        }
    }

    fn push(&self, value: f64) {
        self.pending.set(Some(value));
        if self.handle.get().is_some() {
            return;
        }
        let handle = self
            .window
            .request_animation_frame(self.frame.as_ref().unchecked_ref())
            .ok();
        self.handle.set(handle);
    }

    fn cancel(&self) {
        if let Some(handle) = self.handle.take() {
            let _ = self.window.cancel_animation_frame(handle);
        }
        self.pending.set(None);
    }
}

impl Drop for FrameWriter {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// An event listener that removes itself on drop.
struct Listener {
    target: EventTarget,
    kind: &'static str,
    capture: bool,
    callback: Closure<dyn Fn(Event)>,
}

impl Listener {
    fn add(
        target: &EventTarget,
        kind: &'static str,
        capture: bool,
        non_passive: bool,
        handler: impl Fn(Event) + 'static,
    ) -> Listener {
        let callback = Closure::<dyn Fn(Event)>::new(handler);
        let options = AddEventListenerOptions::new();
        options.set_capture(capture);
        if non_passive {
            options.set_passive(false);
        }
        let _ = target.add_event_listener_with_callback_and_add_event_listener_options(
            kind,
            callback.as_ref().unchecked_ref(),
            &options,
        );
        Listener {
            target: target.clone(),
            kind,
            capture,
            callback,
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.target.remove_event_listener_with_callback_and_bool(
            self.kind,
            self.callback.as_ref().unchecked_ref(),
            self.capture,
        );
    }
}

/// The `MutationObserver` on `root`; disconnects on drop.
struct Observer {
    observer: MutationObserver,
    _callback: Closure<dyn Fn()>,
}

impl Drop for Observer {
    fn drop(&mut self) {
        self.observer.disconnect();
    }
}

impl SwipeController {
    /// Prepares the rows under `root`, keeps them prepared as the DOM changes,
    /// and handles the swipe gestures on them.
    pub fn mount(root: Element) -> SwipeController {
        rows::reconcile(&root);
        let inner = Rc::new_cyclic(|weak| Inner {
            weak: weak.clone(),
            root,
            env: Env::detect(),
            state: RefCell::new(State::default()),
        });
        let observer = observe(&inner);
        let listeners = listen(&inner);
        SwipeController {
            inner,
            observer,
            listeners,
        }
    }
}

impl Drop for SwipeController {
    fn drop(&mut self) {
        self.observer.take();
        self.listeners.clear();
        abandon_gesture(&self.inner);
        end_all_settles(&self.inner);
        for row in matching(&self.inner.root, ".swipe-row") {
            reset_row(&row);
        }
    }
}

impl Env {
    fn detect() -> Option<Env> {
        let window = web_sys::window()?;
        let performance = window.performance()?;
        let touch_layout = window.match_media(TOUCH_LAYOUT).ok().flatten()?;
        let reduced_motion = window.match_media(REDUCED_MOTION).ok().flatten();
        Some(Env {
            window,
            performance,
            touch_layout,
            reduced_motion,
        })
    }

    fn reduced(&self) -> bool {
        self.reduced_motion
            .as_ref()
            .is_some_and(MediaQueryList::matches)
    }
}

/// Observes `root` and reconciles once per batch of mutation records.
fn observe(inner: &Rc<Inner>) -> Option<Observer> {
    let weak = inner.weak.clone();
    let callback = Closure::<dyn Fn()>::new(move || {
        if let Some(inner) = weak.upgrade() {
            rows::reconcile(&inner.root);
            after_reconcile(&inner);
        }
    });
    let observer = MutationObserver::new(callback.as_ref().unchecked_ref()).ok()?;
    let init = MutationObserverInit::new();
    init.set_child_list(true);
    init.set_subtree(true);
    init.set_attributes(true);
    let filter: Array = OBSERVED_ATTRIBUTES
        .iter()
        .map(|name| JsValue::from_str(name))
        .collect();
    init.set_attribute_filter(&filter);
    observer.observe_with_options(&inner.root, &init).ok()?;
    Some(Observer {
        observer,
        _callback: callback,
    })
}

/// `rows::unprepare` only removes `swipe-settling`; the settle bookkeeping of
/// a row that is no longer prepared, or no longer in the document, ends here.
/// A gesture on a row that lost its preparation is dropped, so its writer
/// cannot write `--swipe-x` back onto plain markup.
fn after_reconcile(inner: &Inner) {
    let stale: Vec<Element> = inner
        .state
        .borrow()
        .settles
        .iter()
        .filter(|settle| !is_prepared(&settle.row))
        .map(|settle| settle.row.clone())
        .collect();
    for row in stale {
        end_settle(inner, &row);
    }
    let gesture_unprepared = inner
        .state
        .borrow()
        .gesture
        .as_ref()
        .is_some_and(|gesture| {
            gesture.row.is_connected() && !gesture.row.class_list().contains("swipe-row")
        });
    if gesture_unprepared {
        abandon_gesture(inner);
    }
}

fn is_prepared(row: &Element) -> bool {
    row.is_connected() && row.class_list().contains("swipe-row")
}

/// Registers the listeners of design 4.3; none when `env` is unavailable.
fn listen(inner: &Rc<Inner>) -> Vec<Listener> {
    let Some(env) = inner.env.as_ref() else {
        return Vec::new();
    };
    let mut listeners = Vec::new();
    let root: &EventTarget = inner.root.as_ref();
    let handler = |handle: fn(&Inner, &Env, &Event)| {
        let inner = inner.clone();
        move |event: Event| {
            if let Some(env) = inner.env.as_ref() {
                handle(&inner, env, &event);
            }
        }
    };
    listeners.push(Listener::add(
        root,
        "pointerdown",
        true,
        false,
        handler(on_pointer_down),
    ));
    listeners.push(Listener::add(root, "click", true, false, handler(on_click)));
    let document = inner
        .root
        .owner_document()
        .or_else(|| env.window.document());
    if let Some(document) = document {
        let document: &EventTarget = document.as_ref();
        listeners.push(Listener::add(
            document,
            "pointermove",
            true,
            true,
            handler(on_pointer_move),
        ));
        listeners.push(Listener::add(
            document,
            "pointerup",
            true,
            false,
            handler(on_pointer_up),
        ));
        listeners.push(Listener::add(
            document,
            "pointercancel",
            true,
            false,
            handler(on_pointer_cancel),
        ));
    }
    let touch_layout: &EventTarget = env.touch_layout.as_ref();
    listeners.push(Listener::add(
        touch_layout,
        "change",
        false,
        false,
        handler(on_layout_change),
    ));
    listeners
}

fn on_pointer_down(inner: &Inner, env: &Env, event: &Event) {
    let mut state = inner.state.borrow_mut();
    // A gesture is already in flight; ignore the second touch.
    if state.gesture.is_some() {
        return;
    }
    state.suppress_click_until = 0.0;
    if !env.touch_layout.matches() {
        return;
    }
    if !matches!(
        string_prop(event, "pointerType").as_deref(),
        Some("touch" | "pen")
    ) {
        return;
    }
    let Some(target) = target_element(event) else {
        return;
    };
    let Some(row) = closest(&target, PREPARED_ROW)
        .filter(|row| inner.root.contains(Some(row.as_ref())))
        .and_then(|row| row.dyn_into::<HtmlElement>().ok())
    else {
        return;
    };
    if closest(&target, INTERACTIVE).is_some() {
        return;
    }
    let end_stop = read_end_stop(&row);
    // From the state class, so the start is exactly 0 or End_Stop even mid-transition.
    let was_open = row.class_list().contains("swipe-open");
    let start_offset = if was_open { end_stop } else { 0.0 };
    state.gesture = Some(Gesture {
        writer: FrameWriter::new(&env.window, &row),
        row,
        pointer_id: number_prop(event, "pointerId"),
        x: number_prop(event, "clientX").unwrap_or_default(),
        y: number_prop(event, "clientY").unwrap_or_default(),
        start_offset,
        end_stop,
        was_open,
        axis: None,
        offset: start_offset,
        samples: Vec::new(),
        dragging: false,
    });
}

fn on_pointer_move(inner: &Inner, env: &Env, event: &Event) {
    let first_horizontal = {
        let mut state = inner.state.borrow_mut();
        let Some(gesture) = state.gesture.as_mut() else {
            return;
        };
        if !is_gesture_event(gesture, event) {
            return;
        }
        let x = number_prop(event, "clientX").unwrap_or_default();
        let y = number_prop(event, "clientY").unwrap_or_default();
        gesture.samples.push(Sample {
            x,
            t: env.performance.now(),
        });
        prune_samples(&mut gesture.samples);

        let (dx, dy) = (x - gesture.x, y - gesture.y);
        let prior_axis = gesture.axis;
        gesture.axis = resolve_axis(dx, dy, prior_axis);

        if gesture.axis == Some(Axis::Vertical) {
            // Hand the gesture back to the browser; `--swipe-x` stays as it is.
            if gesture.dragging {
                gesture.dragging = false;
                remove_class(&gesture.row, "swipe-dragging");
            }
            gesture.writer.cancel();
            return;
        }

        // Reveal the panel at the first leftward pixel of a closed row, before
        // the axis resolves.
        if !gesture.dragging
            && (gesture.axis == Some(Axis::Horizontal) || (!gesture.was_open && dx <= -1.0))
        {
            gesture.dragging = true;
            add_class(&gesture.row, "swipe-dragging");
        }

        if gesture.axis != Some(Axis::Horizontal) {
            return;
        }

        event.prevent_default();
        gesture.offset = track_offset(gesture.start_offset, dx, gesture.end_stop, env.reduced());
        gesture.writer.push(gesture.offset);

        // The axis is sticky, so this is the first horizontal resolution.
        prior_axis.is_none().then(|| gesture.row.clone())
    };
    if let Some(row) = first_horizontal {
        rows::close_rows(&inner.root, Some(row.as_ref()));
    }
}

fn on_pointer_up(inner: &Inner, env: &Env, event: &Event) {
    let (gesture, open, total_dx) = {
        let mut state = inner.state.borrow_mut();
        let Some(gesture) = state.gesture.as_ref() else {
            return;
        };
        if !is_gesture_event(gesture, event) {
            return;
        }
        let x = number_prop(event, "clientX").unwrap_or_default();
        let y = number_prop(event, "clientY").unwrap_or_default();
        let (total_dx, total_dy) = (x - gesture.x, y - gesture.y);
        // The release counts as the last sample.
        let velocity = release_velocity(
            &gesture.samples,
            Sample {
                x,
                t: env.performance.now(),
            },
        );
        let open = resolve_release(&Release {
            offset: gesture.offset,
            end_stop: gesture.end_stop,
            velocity,
            total_dx,
            total_dy,
            axis: gesture.axis,
            was_open: gesture.was_open,
        });
        gesture.writer.cancel();
        // Cleared before the settle batch, so no listener sees a live gesture.
        let Some(gesture) = state.gesture.take() else {
            return;
        };
        (gesture, open, total_dx)
    };
    settle_gesture(inner, gesture.row.as_ref(), open);
    if should_suppress_click(gesture.axis, total_dx) {
        inner.state.borrow_mut().suppress_click_until = env.performance.now() + CLICK_SUPPRESS_MS;
    }
}

fn on_pointer_cancel(inner: &Inner, _env: &Env, event: &Event) {
    let gesture = {
        let mut state = inner.state.borrow_mut();
        if !state
            .gesture
            .as_ref()
            .is_some_and(|gesture| is_gesture_event(gesture, event))
        {
            return;
        }
        state.gesture.take()
    };
    let Some(gesture) = gesture else {
        return;
    };
    gesture.writer.cancel();
    // Back to the state the row started in, with no click suppression.
    settle_gesture(inner, gesture.row.as_ref(), gesture.was_open);
}

fn on_click(inner: &Inner, env: &Env, event: &Event) {
    if inner.state.borrow().delegating {
        return;
    }
    let target = target_element(event);

    if let Some(toggle) = target.as_ref().and_then(|t| closest(t, ".swipe-toggle")) {
        if let Some(row) = closest(&toggle, ROW) {
            rows::close_rows(&inner.root, Some(&row));
            rows::set_open(&row, !row.class_list().contains("swipe-open"));
        }
        swallow(event);
        return;
    }

    {
        let mut state = inner.state.borrow_mut();
        if env.performance.now() < state.suppress_click_until {
            state.suppress_click_until = 0.0;
            drop(state);
            swallow(event);
            return;
        }
    }

    if let Some(copy) = target.as_ref().and_then(|t| closest(t, COPY)) {
        swallow(event);
        if let Some(original) = original_for(&copy) {
            inner.state.borrow_mut().delegating = true;
            original.click();
            inner.state.borrow_mut().delegating = false;
        }
        return;
    }

    let inside_panel = target
        .as_ref()
        .is_some_and(|t| closest(t, ".swipe-actions").is_some());
    if !inside_panel {
        rows::close_rows(&inner.root, None);
    }
}

/// The enabled, connected Row_Action that a copy stands for: the row's
/// Row_Action at the copy's `data-swipe-index`, counting only originals.
fn original_for(copy: &Element) -> Option<HtmlElement> {
    let index: usize = copy.get_attribute("data-swipe-index")?.parse().ok()?;
    let row = closest(copy, ROW)?;
    let original = query_all(&row, ROW_ACTION)
        .into_iter()
        .filter(|action| {
            closest(action, ".swipe-actions")
                .is_none_or(|panel| !row.contains(Some(panel.as_ref())))
        })
        .nth(index)?
        .dyn_into::<HtmlElement>()
        .ok()?;
    (original.is_connected() && !original.has_attribute("disabled")).then_some(original)
}

/// Touch_Layout changed in either direction (Requirement 5.15).
fn on_layout_change(inner: &Inner, _env: &Env, _event: &Event) {
    abandon_gesture(inner);
    rows::close_rows(&inner.root, None);
    end_all_settles(inner);
    for row in matching(&inner.root, ".swipe-row") {
        reset_row(&row);
    }
}

/// The settle batch, in the order of Bun's `settleGesture`.
fn settle_gesture(inner: &Inner, row: &Element, open: bool) {
    // A re-render can replace the row mid-drag; a detached row is dropped.
    if !row.is_connected() {
        return;
    }
    remove_class(row, "swipe-dragging");
    begin_settle(inner, row);
    if open {
        rows::close_rows(&inner.root, Some(row));
    }
    rows::set_open(row, open);
    remove_style(row, "--swipe-x");
}

/// Holds `swipe-settling` until the row's surface transform transition ends,
/// or `SETTLE_FALLBACK_MS` passes (Requirement 5.11).
fn begin_settle(inner: &Inner, row: &Element) {
    end_settle(inner, row);
    add_class(row, "swipe-settling");
    // The settle callbacks hold the controller weakly, so a settle never keeps it alive.
    let weak = inner.weak.clone();
    let on_end = {
        let (weak, row) = (weak.clone(), row.clone());
        Closure::<dyn Fn(Event)>::new(move |event: Event| {
            if string_prop(&event, "propertyName").as_deref() != Some("transform") {
                return;
            }
            // Only a direct child of the row is the surface.
            let parent = target_element(&event).and_then(|target| target.parent_element());
            if parent.as_ref() != Some(&row) {
                return;
            }
            if let Some(inner) = weak.upgrade() {
                end_settle(&inner, &row);
            }
        })
    };
    let _ = row.add_event_listener_with_callback("transitionend", on_end.as_ref().unchecked_ref());
    let timer = {
        let row = row.clone();
        Timeout::new(SETTLE_FALLBACK_MS, move || {
            if let Some(inner) = weak.upgrade() {
                end_settle(&inner, &row);
            }
        })
    };
    inner.state.borrow_mut().settles.push(Settle {
        row: row.clone(),
        _timer: timer,
        on_end,
    });
}

/// Drops the settle on `row`, if any: clears the timer, detaches the listener
/// and removes `swipe-settling`.
fn end_settle(inner: &Inner, row: &Element) {
    let settle = {
        let mut state = inner.state.borrow_mut();
        let Some(index) = state.settles.iter().position(|settle| &settle.row == row) else {
            return;
        };
        state.settles.swap_remove(index)
    };
    let _ = row.remove_event_listener_with_callback(
        "transitionend",
        settle.on_end.as_ref().unchecked_ref(),
    );
    remove_class(row, "swipe-settling");
    drop(settle);
}

fn end_all_settles(inner: &Inner) {
    let rows: Vec<Element> = inner
        .state
        .borrow()
        .settles
        .iter()
        .map(|settle| settle.row.clone())
        .collect();
    for row in rows {
        end_settle(inner, &row);
    }
}

/// Drops the gesture in flight without settling it. Dropping its writer
/// cancels a scheduled frame.
fn abandon_gesture(inner: &Inner) {
    let gesture = inner.state.borrow_mut().gesture.take();
    drop(gesture);
}

/// No transient classes and no inline translation; `swipe-open` is resting state and stays.
fn reset_row(row: &Element) {
    remove_class(row, "swipe-dragging");
    remove_style(row, "--swipe-x");
}

/// `true` when the event belongs to the gesture in flight. An event without a
/// `pointerId` is accepted, as in Bun's `isGestureEvent`.
fn is_gesture_event(gesture: &Gesture, event: &Event) -> bool {
    match number_prop(event, "pointerId") {
        None => true,
        Some(id) => gesture.pointer_id == Some(id),
    }
}

/// End_Stop for a row from its inline `--swipe-count`.
fn read_end_stop(row: &HtmlElement) -> f64 {
    end_stop_for(
        &row.style()
            .get_property_value("--swipe-count")
            .unwrap_or_default(),
    )
}

/// `-(parseInt(count) × 68)`, or 0 for a missing, invalid or non-positive count.
fn end_stop_for(count: &str) -> f64 {
    let text = count.trim_start();
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digits: &str = &rest[..rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len())];
    let Ok(count) = digits.parse::<f64>() else {
        return 0.0;
    };
    if negative || count <= 0.0 {
        return 0.0;
    }
    -(count * ACTION_WIDTH)
}

/// `${value}px`; JavaScript prints negative zero as `0`.
fn px(value: f64) -> String {
    let value = if value == 0.0 { 0.0 } else { value };
    format!("{value}px")
}

fn swallow(event: &Event) {
    event.prevent_default();
    event.stop_immediate_propagation();
}

fn target_element(event: &Event) -> Option<Element> {
    event.target()?.dyn_into::<Element>().ok()
}

fn closest(element: &Element, selector: &str) -> Option<Element> {
    element.closest(selector).ok().flatten()
}

fn number_prop(value: &JsValue, name: &str) -> Option<f64> {
    Reflect::get(value, &JsValue::from_str(name)).ok()?.as_f64()
}

fn string_prop(value: &JsValue, name: &str) -> Option<String> {
    Reflect::get(value, &JsValue::from_str(name))
        .ok()?
        .as_string()
}

/// `root` itself when it matches, then its matching descendants.
fn matching(root: &Element, selector: &str) -> Vec<Element> {
    let mut elements = Vec::new();
    if root.matches(selector).unwrap_or(false) {
        elements.push(root.clone());
    }
    elements.extend(query_all(root, selector));
    elements
}

fn query_all(root: &Element, selector: &str) -> Vec<Element> {
    let Ok(list) = root.query_selector_all(selector) else {
        return Vec::new();
    };
    (0..list.length())
        .filter_map(|index| list.get(index))
        .filter_map(|node| node.dyn_into::<Element>().ok())
        .collect()
}

fn add_class(element: &Element, class: &str) {
    let _ = element.class_list().add_1(class);
}

fn remove_class(element: &Element, class: &str) {
    let classes = element.class_list();
    if classes.contains(class) {
        let _ = classes.remove_1(class);
    }
}

fn remove_style(element: &Element, property: &str) {
    if let Some(element) = element.dyn_ref::<HtmlElement>() {
        let _ = element.style().remove_property(property);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_stop_follows_the_swipe_count() {
        assert_eq!(end_stop_for("1"), -68.0);
        assert_eq!(end_stop_for("2"), -136.0);
        assert_eq!(end_stop_for(" 3"), -204.0);
    }

    #[test]
    fn end_stop_parses_like_parse_int() {
        assert_eq!(end_stop_for("2px"), -136.0);
        assert_eq!(end_stop_for("+2"), -136.0);
    }

    #[test]
    fn missing_or_non_positive_count_is_inert() {
        for count in ["", "0", "-2", "abc", "-"] {
            assert_eq!(end_stop_for(count), 0.0, "{count:?}");
        }
    }

    #[test]
    fn px_matches_javascript_template_output() {
        assert_eq!(px(-12.5), "-12.5px");
        assert_eq!(px(-136.0), "-136px");
        assert_eq!(px(0.0), "0px");
        assert_eq!(px(-0.0), "0px");
    }
}
