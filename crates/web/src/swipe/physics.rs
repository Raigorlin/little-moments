//! 手勢的純計算（design 4.1），逐行對照 `src/mobile-swipe.js`，不使用 `web_sys`。

/// Panel geometry: `calc(var(--swipe-count)*68px)`.
pub const ACTION_WIDTH: f64 = 68.0;
/// Horizontal/vertical dominance ratio.
pub const AXIS_BIAS: f64 = 1.25;
/// Pixels of travel before the axis can resolve.
pub const AXIS_DEADZONE: f64 = 8.0;
/// Pixels per millisecond.
pub const FLICK_THRESHOLD: f64 = 0.35;
/// Milliseconds of samples used for the release velocity.
pub const VELOCITY_WINDOW: f64 = 100.0;
/// Fraction of the overshoot that is rendered.
pub const RUBBER_RESIST: f64 = 0.3;
/// Pixel cap on the rendered overshoot.
pub const RUBBER_MAX: f64 = 48.0;
/// Release-only distance rule, open.
pub const LEGACY_OPEN: f64 = 56.0;
/// Release-only distance rule, close.
pub const LEGACY_CLOSE: f64 = 42.0;
/// Click swallowed for this long after a gesture.
pub const CLICK_SUPPRESS_MS: f64 = 450.0;
/// Fallback that clears `.swipe-settling` when `transitionend` never fires.
pub const SETTLE_FALLBACK_MS: u32 = 320;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub t: f64,
}

/// `resolveAxis`: sticky once `locked` is Some; horizontal wins an exact tie.
pub fn resolve_axis(dx: f64, dy: f64, locked: Option<Axis>) -> Option<Axis> {
    if locked.is_some() {
        return locked;
    }
    let (ax, ay) = (dx.abs(), dy.abs());
    if ax >= AXIS_DEADZONE && ax >= ay * AXIS_BIAS {
        return Some(Axis::Horizontal);
    }
    if ay >= AXIS_DEADZONE && ay > ax * AXIS_BIAS {
        return Some(Axis::Vertical);
    }
    None
}

/// `trackOffset`: closed clamp at 0, linear to `end_stop` (negative), then
/// rubber band, or a hard clamp at `end_stop` under reduced motion.
pub fn track_offset(start: f64, dx: f64, end_stop: f64, reduced: bool) -> f64 {
    let raw = start + dx;
    if raw >= 0.0 {
        return 0.0; // closed clamp
    }
    if raw >= end_stop {
        return raw; // linear zone, 1:1 with the finger
    }
    if reduced {
        return end_stop;
    }
    let overshoot = end_stop - raw; // positive
    end_stop - RUBBER_MAX.min(overshoot * RUBBER_RESIST)
}

/// `sampleVelocity`: px/ms over the final `window` ms, negative leftward.
/// None for fewer than two samples or a zero-length window.
pub fn sample_velocity(samples: &[Sample], window: f64) -> Option<f64> {
    if samples.len() < 2 {
        return None;
    }
    let last = samples[samples.len() - 1];
    let mut first = last;
    for sample in samples[..samples.len() - 1].iter().rev() {
        if last.t - sample.t > window {
            break;
        }
        first = *sample;
    }
    let dt = last.t - first.t;
    if dt <= 0.0 {
        return None;
    }
    Some((last.x - first.x) / dt)
}

/// `releaseVelocity`: None only for an empty trace; otherwise the release
/// counts as the last sample, and an unmeasurable window reads as 0.
pub fn release_velocity(samples: &[Sample], release: Sample) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut trace = Vec::with_capacity(samples.len() + 1);
    trace.extend_from_slice(samples);
    trace.push(release);
    Some(sample_velocity(&trace, VELOCITY_WINDOW).unwrap_or(0.0))
}

/// `onPointerMove`'s prune: drop entries more than `VELOCITY_WINDOW` older
/// than the newest sample, keeping at most one entry older than the window.
pub fn prune_samples(samples: &mut Vec<Sample>) {
    let Some(newest) = samples.last().map(|s| s.t) else {
        return;
    };
    let mut drop = 0;
    while samples.len() - drop > 2 && newest - samples[drop + 1].t > VELOCITY_WINDOW {
        drop += 1;
    }
    samples.drain(..drop);
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Release {
    pub offset: f64,
    pub end_stop: f64,
    pub velocity: Option<f64>,
    pub total_dx: f64,
    pub total_dy: f64,
    pub axis: Option<Axis>,
    pub was_open: bool,
}

/// `resolveRelease`: true = open.
pub fn resolve_release(release: &Release) -> bool {
    if release.end_stop == 0.0 {
        return false;
    }
    let Some(velocity) = release.velocity else {
        let release_axis = release
            .axis
            .or_else(|| resolve_axis(release.total_dx, release.total_dy, None));
        if release_axis != Some(Axis::Horizontal) {
            return release.was_open;
        }
        if release.total_dx <= -LEGACY_OPEN {
            return true;
        }
        if release.total_dx >= LEGACY_CLOSE {
            return false;
        }
        return release.was_open;
    };
    if velocity.abs() >= FLICK_THRESHOLD {
        return velocity < 0.0;
    }
    release.offset.abs() >= release.end_stop.abs() / 2.0
}

/// `shouldSuppressClick`.
pub fn should_suppress_click(axis: Option<Axis>, total_dx: f64) -> bool {
    axis == Some(Axis::Horizontal) || total_dx.abs() >= LEGACY_CLOSE
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionRole {
    Edit,
    Delete,
    Other,
}

/// Requirement 4.3: Edit → 「編輯」; otherwise a label containing 「移除」 or
/// 「刪除」 → 「刪除」; else 「操作」. The Delete role does not change the label.
pub fn swipe_label(role: ActionRole, label: &str) -> &'static str {
    if role == ActionRole::Edit {
        "編輯"
    } else if label.contains("移除") || label.contains("刪除") {
        "刪除"
    } else {
        "操作"
    }
}

/// Requirement 4.4: the original has class `danger`, or the swipe label is 「刪除」.
pub fn is_danger(has_danger_class: bool, swipe_label: &str) -> bool {
    has_danger_class || swipe_label == "刪除"
}
