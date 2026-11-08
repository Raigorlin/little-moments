# Requirements Document

## Introduction

Mobile list rows in Little Moments reveal their edit and delete actions with a left swipe, but the current gesture is release-only: `src/mobile-swipe.js` records a `pointerdown` position, waits for `pointerup`, and then decides whether to add or remove the `swipe-open` class. Nothing moves while the finger is on the screen, and the CSS transition is declared inside the `.swipe-open` rule so opening animates while closing snaps instantly.

This feature reworks the gesture so a row follows the finger in real time and settles with an iOS-style snap, matching the user's stated expectation ("the same swipe like iOS in Apple"). Scope: continuous tracking during `pointermove`, velocity-aware snap on release, rubber-band resistance past the end stop, and symmetric open/close animation. All existing row markup contracts (`data-swipe-row`, the cloned action allowlist, the `.swipe-toggle` affordance, ARIA wiring) stay as they are, and the current release-only recognition path keeps working so existing end-to-end coverage remains valid.

**Assumptions carried from existing code conventions** (the user skipped these clarify questions; no preference was invented):

- **Scroll-versus-swipe trigger**: the existing axis bias (`Math.abs(dx) >= Math.abs(dy) * 1.25`) is treated as the established project convention and is reused as the axis-lock rule for tracking, rather than introducing a new generosity model.
- **Haptics**: no haptic feedback. The codebase contains no vibration or haptic API usage, so none is added.
- **Transform target**: a single translated surface replaces the current per-direct-child transform selector, because `src/scene-motion.js` and `scene-motion.css` already establish the convention of promoting one animated layer and gating it on motion preference. The surface is introduced without changing any row's authored child markup.
- **Motion preference**: the `prefers-reduced-motion` contract follows the existing `scene-motion` precedent (a `matchMedia` listener plus a reduce branch that removes animation).
- **User-facing copy**: Traditional Chinese, consistent with existing strings such as `滑動操作` and `顯示編輯與刪除操作`.

**Amendment A (found after tasks 3.1 and 4.1 to 4.3 shipped).** A reading of the shipped CSS shows the Action_Panel painting above the Row_Surface instead of being revealed behind it, contrary to criterion 1.6. The panel is `position:absolute;z-index:3`, and `.swipe-row.swipe-dragging>.swipe-actions{visibility:visible}` turns the whole panel on at the first leftward pixel, so the panel covers the right `swipe-count × 68` pixels of the row at once and its edge stays still instead of following the finger. Hiding is not transitioned either, so a closing row's content slides back over an empty strip. Criteria 1.9 and 2.10 state the intended behavior. The defect has not been seen in a browser yet, and task 3.2 confirms it before changing anything.

**Amendment B (new user request).** The user asked that the button beside the date tabs on the trip schedule never be pushed under the dates. The user called it 新增下一站; the rendered label is `新增一站`, and the label does not change. Requirement 7 keeps the button on the date tabs' row, to their right, at every viewport width of at least 320 CSS pixels and for every trip length the app accepts, with the date tabs scrolling sideways to absorb extra days.

**Amendment C (found by task 2.7).** The release path measures the Release_Velocity back from the last `pointermove` and adds no sample for the release itself. Browsers usually fire no `pointermove` while a finger is held still, so a fast drag, a pause and a lift keep the velocity from before the pause and can resolve as a flick. iOS settles by position after a pause. The Release_Velocity entry in the Glossary now ends its 100-millisecond window at the release and counts the release position, and criterion 2.11 states the pause case. A `pointerdown` followed by a `pointerup` with no `pointermove` still has no Release_Velocity, so Requirement 5 is unchanged.

**Amendment D (found by task 3.3).** Above 600 CSS pixels, when the days do not fit, the Date_Buttons shrink to their minimum width before the Date_Tabs start scrolling. A shrunk Date_Button wraps its weekday onto a second line, and at 91 pixels its text runs about 4 pixels past its border. Task 3.3 kept the Add_Stop_Button beside the Date_Tabs from 761 to 1020 pixels, which extended the squeeze to 8-day trips at 900 and 1020 pixels. Criterion 7.6 keeps every Date_Button at least as wide as its content while the days do not fit, so the Date_Tabs scroll instead.

## Glossary

- **Swipe_Controller**: The behavior exported by `src/mobile-swipe.js` as `enableSwipeActions`, wired once from `src/entry.js`.
- **Swipe_Row**: A list element that opts in with the `data-swipe-row` attribute and has been prepared by the Swipe_Controller (carries `data-swipe-ready="true"` and the `swipe-row` class).
- **Action_Panel**: The `.swipe-actions` group the Swipe_Controller builds inside a Swipe_Row from the allowlisted action buttons.
- **Row_Surface**: The single element whose horizontal transform is animated to reveal the Action_Panel. The Row_Surface excludes the Action_Panel and the Swipe_Toggle.
- **Swipe_Toggle**: The `.swipe-toggle` button the Swipe_Controller appends to a Swipe_Row so the actions can be reached without a swipe gesture.
- **Drag_Offset**: The current horizontal translation of the Row_Surface, in CSS pixels, where `0` is closed and negative values move the Row_Surface left.
- **End_Stop**: The Drag_Offset at which the Action_Panel is fully revealed, equal to `-1 × swipe-count × 68` pixels.
- **Rubber_Band_Zone**: Drag_Offset values beyond the End_Stop, that is more negative than the End_Stop.
- **Release_Velocity**: The horizontal pointer speed at the moment of release, in CSS pixels per millisecond, measured over the 100 milliseconds that end at the release, with the release position counted as a pointer sample alongside the `pointermove` samples in that window. A gesture with no `pointermove` event has no Release_Velocity.
- **Flick_Threshold**: A Release_Velocity magnitude of 0.35 pixels per millisecond.
- **Settle_Animation**: The animation that moves the Row_Surface from the Drag_Offset at release to either the closed position or the End_Stop.
- **Touch_Layout**: The viewport condition `matchMedia('(max-width: 760px)')` evaluating to true.
- **Pointer_Gesture**: A pointer interaction whose `pointerType` is `touch` or `pen`.
- **Reduced_Motion**: The viewport condition `matchMedia('(prefers-reduced-motion: reduce)')` evaluating to true.
- **Panel_Visible_Width**: The width, in CSS pixels, of the part of the Action_Panel that is painted on screen, measured inward from the right edge of the Action_Panel. A hidden or fully clipped Action_Panel has a Panel_Visible_Width of 0.
- **Schedule_Bar**: The `.schedule-bar` row at the top of the trip schedule view, rendered by `schedule()` in `src/app.js` and styled by `src/styles.css`, which holds the Date_Tabs followed by the Add_Stop_Button.
- **Date_Tabs**: The `.date-tabs` group inside the Schedule_Bar that holds one Date_Button per trip day.
- **Date_Button**: A day button inside the Date_Tabs, showing `DAY nn`, the date, and the weekday.
- **Add_Stop_Button**: The button labeled `新增一站` that follows the Date_Tabs inside the Schedule_Bar and opens the new-activity form. The user refers to this button as 新增下一站.
- **Date_Label**: One of the three text elements inside a Date_Button: the `small` element showing `DAY nn`, the `b` element showing the date, and the `span` element showing the weekday.
- **Max_Content_Width**: The border-box width, in CSS pixels, of a Date_Button laid out at its CSS `max-content` width, at which no Date_Label wraps.

## Requirements

### Requirement 1: Finger-Tracked Drag

**User Story:** As a phone user, I want the row to move with my finger as I swipe, so that the reveal feels directly connected to my gesture like iOS list rows.

#### Acceptance Criteria

1. WHERE Touch_Layout applies, WHEN a Pointer_Gesture begins on a Swipe_Row outside any `button`, `a`, `input`, `select`, `textarea`, or `summary` descendant, THE Swipe_Controller SHALL record the starting pointer position and begin tracking the gesture.
2. WHILE a tracked gesture is active and the axis lock has resolved to horizontal, THE Swipe_Controller SHALL set the Drag_Offset to the sum of the Drag_Offset at gesture start and the horizontal pointer displacement, clamped to the range from `0` to the Rubber_Band_Zone limit defined in Requirement 3.
3. WHILE a tracked gesture is active and the axis lock has resolved to horizontal, THE Swipe_Controller SHALL match the rendered Row_Surface translation to the Drag_Offset within 1 CSS pixel.
4. WHILE a tracked gesture is active, THE Swipe_Controller SHALL apply the Drag_Offset to the Row_Surface only, and SHALL leave the Action_Panel and the Swipe_Toggle untranslated.
5. WHILE a tracked gesture is active, THE Swipe_Controller SHALL suppress the Settle_Animation transition on the Row_Surface so that the rendered translation reflects the latest pointer sample without interpolation delay.
6. WHEN a tracked gesture on a closed Swipe_Row produces a horizontal displacement of at least 1 CSS pixel in the leftward direction, THE Swipe_Controller SHALL make the Action_Panel visible so that the Action_Panel is revealed behind the moving Row_Surface.
7. WHILE a tracked gesture is active on a Swipe_Row, THE Swipe_Controller SHALL keep every other Swipe_Row in the closed state.
8. WHILE a tracked gesture moves the Drag_Offset, THE Swipe_Controller SHALL update the translation inside a single animation frame callback per rendered frame.
9. WHILE a tracked gesture holds the Drag_Offset between the End_Stop and 0, THE Swipe_Controller SHALL keep the Panel_Visible_Width equal to the magnitude of the Drag_Offset within 1 CSS pixel, so that no part of the Action_Panel covers the Row_Surface.

### Requirement 2: Velocity-Aware Release Snap

**User Story:** As a phone user, I want a short flick to open or close the row completely, so that I do not have to drag the row all the way to the end.

#### Acceptance Criteria

1. WHEN a tracked gesture ends with a Release_Velocity magnitude of at least the Flick_Threshold in the leftward direction, THE Swipe_Controller SHALL run the Settle_Animation to the End_Stop and SHALL place the Swipe_Row in the open state.
2. WHEN a tracked gesture ends with a Release_Velocity magnitude of at least the Flick_Threshold in the rightward direction, THE Swipe_Controller SHALL run the Settle_Animation to the closed position and SHALL place the Swipe_Row in the closed state.
3. WHEN a tracked gesture ends with a Release_Velocity magnitude below the Flick_Threshold and a Drag_Offset magnitude of at least half the End_Stop magnitude, THE Swipe_Controller SHALL run the Settle_Animation to the End_Stop and SHALL place the Swipe_Row in the open state.
4. WHEN a tracked gesture ends with a Release_Velocity magnitude below the Flick_Threshold and a Drag_Offset magnitude below half the End_Stop magnitude, THE Swipe_Controller SHALL run the Settle_Animation to the closed position and SHALL place the Swipe_Row in the closed state.
5. WHEN the Settle_Animation starts, THE Swipe_Controller SHALL complete the Settle_Animation within 320 milliseconds for both the opening direction and the closing direction.
6. WHEN the Settle_Animation completes, THE Swipe_Controller SHALL leave the rendered Row_Surface translation equal to the resting translation of the resolved state within 1 CSS pixel.
7. WHEN a Swipe_Row reaches the open state, THE Swipe_Controller SHALL set `aria-hidden` to `false` on the Action_Panel and `aria-expanded` to `true` on the Swipe_Toggle.
8. WHEN a Swipe_Row reaches the closed state, THE Swipe_Controller SHALL set `aria-hidden` to `true` on the Action_Panel and `aria-expanded` to `false` on the Swipe_Toggle.
9. WHEN a tracked gesture ends after a horizontal displacement of at least 42 CSS pixels, THE Swipe_Controller SHALL suppress the next click event that follows within 450 milliseconds.
10. WHILE the rendered Row_Surface translation animates at a value between the End_Stop and 0, whether after a gesture, a Swipe_Toggle activation, or a click outside the Action_Panel, THE Swipe_Controller SHALL keep the Action_Panel visible with a Panel_Visible_Width equal to the magnitude of the rendered Row_Surface translation within 1 CSS pixel, so that a closing Swipe_Row keeps the Action_Panel visible until the Row_Surface has covered the Action_Panel.
11. WHEN a tracked gesture that received at least one `pointermove` event ends more than 100 milliseconds after the last of those events, THE Swipe_Controller SHALL resolve the release as if the Release_Velocity were 0, so that the Drag_Offset alone decides the resolved state.

### Requirement 3: Rubber-Band End Stop

**User Story:** As a phone user, I want the row to resist when I drag past the revealed actions, so that the end of the gesture feels bounded instead of broken.

#### Acceptance Criteria

1. WHILE a tracked gesture holds the Drag_Offset inside the Rubber_Band_Zone, THE Swipe_Controller SHALL translate the Row_Surface past the End_Stop by 0.3 times the overshoot distance, where the overshoot distance is the pointer displacement beyond the End_Stop.
2. THE Swipe_Controller SHALL limit the rendered translation beyond the End_Stop to 48 CSS pixels.
3. WHEN a tracked gesture ends with the Drag_Offset inside the Rubber_Band_Zone, THE Swipe_Controller SHALL run the Settle_Animation to the End_Stop and SHALL place the Swipe_Row in the open state.
4. WHILE a tracked gesture drags a closed Swipe_Row in the rightward direction, THE Swipe_Controller SHALL hold the rendered translation at `0`.
5. WHILE a tracked gesture drags an open Swipe_Row in the rightward direction, THE Swipe_Controller SHALL allow the rendered translation to reach `0` and SHALL hold the rendered translation at `0` for further rightward displacement.

### Requirement 4: Scroll And Swipe Coexistence

**User Story:** As a phone user, I want vertical scrolling to keep working inside swipeable lists, so that reading a long trip page is unaffected by the new gesture.

#### Acceptance Criteria

1. WHILE a tracked gesture has a horizontal displacement magnitude of at least 1.25 times the vertical displacement magnitude and a horizontal displacement magnitude of at least 8 CSS pixels, THE Swipe_Controller SHALL resolve the axis lock to horizontal for the remainder of that gesture.
2. WHILE a tracked gesture has a vertical displacement magnitude that exceeds 1.25 times the horizontal displacement magnitude and a vertical displacement magnitude of at least 8 CSS pixels, THE Swipe_Controller SHALL resolve the axis lock to vertical for the remainder of that gesture.
3. WHILE the axis lock of a tracked gesture is resolved to vertical, THE Swipe_Controller SHALL leave the rendered Row_Surface translation at the translation held when the gesture started and SHALL allow the default scroll behavior to proceed.
4. WHILE the axis lock of a tracked gesture is resolved to horizontal, THE Swipe_Controller SHALL prevent the default behavior of the pointer movement so that the page does not scroll during the drag.
5. IF a tracked gesture is interrupted by a `pointercancel` event, THEN THE Swipe_Controller SHALL run the Settle_Animation to the resting translation of the state the Swipe_Row held when the gesture started.
6. WHEN the Touch_Layout condition changes from true to false, THE Swipe_Controller SHALL place every Swipe_Row in the closed state and SHALL clear any inline translation applied to the Row_Surface.
7. WHERE Touch_Layout does not apply, WHEN a Pointer_Gesture begins on a Swipe_Row, THE Swipe_Controller SHALL leave the rendered Row_Surface translation unchanged.

### Requirement 5: Backward-Compatible Contracts

**User Story:** As a developer maintaining this app, I want the existing swipe entry points and tests to keep passing, so that the gesture rework does not force changes to row markup or existing coverage.

#### Acceptance Criteria

1. WHEN a Pointer_Gesture consists of a `pointerdown` followed by a `pointerup` with no intervening `pointermove` event and a leftward horizontal displacement of at least 56 CSS pixels, THE Swipe_Controller SHALL place the Swipe_Row in the open state.
2. WHEN a Pointer_Gesture consists of a `pointerdown` followed by a `pointerup` with no intervening `pointermove` event and a rightward horizontal displacement of at least 42 CSS pixels, THE Swipe_Controller SHALL place the Swipe_Row in the closed state.
3. THE Swipe_Controller SHALL keep the `data-swipe-row` opt-in attribute as the only markup contract required of a list row.
4. THE Swipe_Controller SHALL keep cloning the allowlisted action controls into the Action_Panel with the existing `swipe-action`, `swipe-action-danger`, `data-swipe-label`, and `data-swipe-original` conventions.
5. THE Swipe_Controller SHALL keep preparing newly rendered Swipe_Row elements through the existing mutation observation so that rows added by a re-render gain the Action_Panel and the Swipe_Toggle.
6. WHEN the Swipe_Toggle of a Swipe_Row is activated, THE Swipe_Controller SHALL place every other Swipe_Row in the closed state and SHALL invert the state of the activated Swipe_Row.
7. WHEN a click occurs outside any Action_Panel, THE Swipe_Controller SHALL place every Swipe_Row in the closed state.
8. WHEN the cleanup function returned by `enableSwipeActions` is invoked, THE Swipe_Controller SHALL remove every listener and observer the Swipe_Controller registered and SHALL clear any inline translation applied to a Row_Surface.
9. WHERE a Swipe_Row contains no enabled allowlisted action control, THE Swipe_Controller SHALL leave that row without an Action_Panel and without a Swipe_Toggle.

### Requirement 6: Reduced Motion Respect

**User Story:** As a user who limits motion on my device, I want the swipe to settle without animation, so that the app respects my system preference the same way the illustration animations do.

#### Acceptance Criteria

1. WHILE Reduced_Motion applies, WHEN a tracked gesture ends, THE Swipe_Controller SHALL apply the resting translation of the resolved state without running the Settle_Animation.
2. WHILE Reduced_Motion applies, WHEN a tracked gesture moves the Drag_Offset, THE Swipe_Controller SHALL continue matching the rendered Row_Surface translation to the Drag_Offset as specified in Requirement 1.
3. WHILE Reduced_Motion applies, WHEN a tracked gesture holds the Drag_Offset inside the Rubber_Band_Zone, THE Swipe_Controller SHALL hold the rendered translation at the End_Stop.
4. WHEN the Reduced_Motion condition changes, THE Swipe_Controller SHALL apply the changed condition to the next gesture without requiring a page reload.
5. WHERE new user-facing text is added by this feature, THE Swipe_Controller SHALL present that text in Traditional Chinese.

### Requirement 7: Add-Stop Button Beside The Date Tabs

**User Story:** As a trip planner on a phone or tablet, I want the 新增一站 button to stay to the right of the date tabs, so that adding a stop never pushes the button below the dates.

#### Acceptance Criteria

1. WHILE the viewport width is at least 320 CSS pixels, THE Schedule_Bar SHALL place the Add_Stop_Button on the same row as the Date_Tabs, with the top edge of the Add_Stop_Button above the bottom edge of the Date_Tabs, for every trip length from 1 to 31 days.
2. WHILE the viewport width is at least 320 CSS pixels, THE Schedule_Bar SHALL place the left edge of the Add_Stop_Button no more than 1 CSS pixel to the left of the right edge of the Date_Tabs.
3. WHILE the viewport width is at least 320 CSS pixels, THE Schedule_Bar SHALL keep every Date_Button on a single line inside the Date_Tabs.
4. WHILE the combined width of the Date_Buttons and the gaps between them exceeds the visible width of the Date_Tabs, THE Schedule_Bar SHALL make the Date_Tabs scroll horizontally.
5. WHILE the viewport width is at least 320 CSS pixels, THE Schedule_Bar SHALL fit inside the viewport, so that the document scroll width stays at or below the viewport width.
6. WHILE the Max_Content_Widths of the Date_Buttons plus the gaps between them exceed the visible width of the Date_Tabs, THE Schedule_Bar SHALL keep every Date_Button at least as wide as the Max_Content_Width of that Date_Button within 1 CSS pixel, with every Date_Label of that Date_Button on one line and inside the border of that Date_Button.
