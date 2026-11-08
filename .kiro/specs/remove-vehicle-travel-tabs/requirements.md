# Requirements Document

## Introduction

The trip view currently shows seven section tabs. This feature removes the "旅伴與車輛" (`crew`) tab and the "旅行設定" (`settings`) tab, leaving five tabs: 行程表, 料理菜單, 採買清單, 裝備分工, 分帳記帳. The actions that lived only on the removed tabs stay available through a new Trip_Menu opened from a menu button in the trip header, next to the trip title. Stored data (people, vehicles, trip details, events) is preserved unchanged, and no storage migration is performed.

## Glossary

- **Trip_View**: The rendered trip screen produced by `trip()` in `src/app.js`, including the trip header and the `.section-tabs` navigation.
- **Section_Tabs**: The tab navigation rendered from the `TABS` list in `src/model.js`.
- **Remaining_Tabs**: The ordered tab set `schedule` (行程表), `meals` (料理菜單), `shopping` (採買清單), `gear` (裝備分工), `expenses` (分帳記帳).
- **Removed_Tabs**: The tab keys `crew` (旅伴與車輛) and `settings` (旅行設定).
- **Trip_Header**: The header area of the Trip_View that displays the trip title.
- **Menu_Button**: A button in the Trip_Header, placed next to the trip title, that opens the Trip_Menu.
- **Trip_Menu**: The menu opened by the Menu_Button that lists the Relocated_Actions.
- **Relocated_Actions**: The actions previously reachable only from the Removed_Tabs: edit trip (`trip-settings`), add companion, edit companion, add vehicle, edit vehicle, delete vehicle, switch identity (`profile`), export data, import data, print, scene motion settings, and reset.
- **Tab_Resolver**: The logic in `src/app.js` that selects which tab content to render for the current tab value.
- **Swipe_Navigator**: The mobile swipe tab navigation in `src/mobile-swipe.js`.
- **Stored_State**: The persisted application state, including people, vehicles, trip details, and events.

## Requirements

### Requirement 1: Five Section Tabs

**User Story:** As a trip member, I want the trip view to show only the five content tabs, so that navigation is shorter and focused on trip content.

#### Acceptance Criteria

1. THE Section_Tabs SHALL render exactly the Remaining_Tabs in the order schedule, meals, shopping, gear, expenses.
2. THE Section_Tabs SHALL number the Remaining_Tabs sequentially from 01 to 05.
3. THE Trip_View SHALL render the Section_Tabs without a tab button for either of the Removed_Tabs.

### Requirement 2: Trip Header Menu Button

**User Story:** As a trip member, I want a menu button next to the trip title, so that I can reach trip, companion, vehicle, and data actions without the removed tabs.

#### Acceptance Criteria

1. THE Trip_Header SHALL display the Menu_Button adjacent to the trip title.
2. THE Menu_Button SHALL expose an accessible name that identifies the button as the trip menu.
3. WHEN the user activates the Menu_Button, THE Trip_View SHALL open the Trip_Menu.
4. WHILE the Trip_Menu is open, THE Menu_Button SHALL report an expanded state to assistive technology.
5. WHEN the user activates a close control or presses the Escape key while the Trip_Menu is open, THE Trip_View SHALL close the Trip_Menu and return focus to the Menu_Button.

### Requirement 3: Relocated Actions in Trip Menu

**User Story:** As a trip member, I want every action from the removed tabs available in the Trip_Menu, so that no existing feature is lost.

#### Acceptance Criteria

1. THE Trip_Menu SHALL provide an entry that opens the edit trip dialog (`trip-settings`).
2. THE Trip_Menu SHALL provide an entry that opens the add companion dialog.
3. THE Trip_Menu SHALL list each person in the Stored_State with an entry that opens the edit companion dialog for that person.
4. THE Trip_Menu SHALL provide an entry that opens the add vehicle dialog.
5. THE Trip_Menu SHALL list each vehicle in the Stored_State with an entry that opens the edit vehicle dialog for that vehicle.
6. WHERE the current account has delete permission, THE Trip_Menu SHALL provide a delete entry for each vehicle in the Stored_State.
7. THE Trip_Menu SHALL provide an entry that opens the switch identity dialog (`profile`).
8. THE Trip_Menu SHALL provide entries for export data, import data, and print.
9. THE Trip_Menu SHALL provide access to the scene motion settings produced by `sceneMotionSettings()`.
10. THE Trip_Menu SHALL provide an entry for reset.
11. WHEN the user activates a Trip_Menu entry, THE Trip_View SHALL perform the same action and apply the same confirmation and permission checks that the equivalent control on the Removed_Tabs performed.

### Requirement 4: Fallback for Removed and Unknown Tabs

**User Story:** As a returning user, I want old links and saved state that point to a removed tab to still open the app, so that I do not land on a broken or empty screen.

#### Acceptance Criteria

1. IF the current tab value is `crew` or `settings`, THEN THE Tab_Resolver SHALL render the schedule tab content and mark the schedule tab as the current tab.
2. IF the current tab value is not one of the Remaining_Tabs, THEN THE Tab_Resolver SHALL render the schedule tab content and mark the schedule tab as the current tab.
3. WHEN the Tab_Resolver falls back to the schedule tab, THE Trip_View SHALL leave the Stored_State people, vehicles, trip details, and events unchanged.

### Requirement 5: Swipe Navigation Over Remaining Tabs

**User Story:** As a mobile user, I want swipe navigation to move only between the remaining tabs, so that swiping never lands on a removed tab.

#### Acceptance Criteria

1. WHEN the user swipes to the next tab, THE Swipe_Navigator SHALL select the next tab in the Remaining_Tabs order.
2. WHEN the user swipes to the previous tab, THE Swipe_Navigator SHALL select the previous tab in the Remaining_Tabs order.
3. WHILE the current tab is the first or last of the Remaining_Tabs, THE Swipe_Navigator SHALL apply the same boundary behavior it applied to the first and last tabs before this change.

### Requirement 6: Stored Data Preservation

**User Story:** As a user with existing trips, I want my data kept as it is, so that removing tabs does not lose companions, vehicles, or history.

#### Acceptance Criteria

1. THE Trip_View SHALL read the Stored_State using the existing storage key and schema without a migration step.
2. WHEN the app loads Stored_State saved before this change, THE Trip_View SHALL display the same people, vehicles, trip details, and recent events through the Trip_Menu and the Remaining_Tabs.

### Requirement 7: Test Suite Updates

**User Story:** As a developer, I want the automated tests to reflect the new navigation, so that the test suite passes and guards the change.

#### Acceptance Criteria

1. THE test suite SHALL reach the Relocated_Actions through the Trip_Menu in every test that previously reached them through the Removed_Tabs.
2. THE test suite SHALL include a test that verifies the Section_Tabs render exactly the Remaining_Tabs.
3. THE test suite SHALL include a test that verifies a tab value of `crew` or `settings` renders the schedule tab.
