# Requirements Document

## Introduction

This feature audits every button, icon, tab, dropdown, and card action in 日子拾光 and brings them into one control system. Icons come from one set, and each icon means one thing. Buttons, dropdowns, expandable sections, and tabs share one look and one set of states, and dropdowns and expandable sections open and close with a short animation. Each card offers one control per job, and tabs and icons that add nothing are removed. The work covers the Local_Planner (`/demo/`) and Account_Mode, in both themes, from 320 to 1440 CSS pixels wide, and keeps the mobile swipe behavior of `.kiro/specs/mobile-smooth-swipe/` intact apart from one fix to the swipe labels.

**Scope.** In scope are every Control and Icon rendered by `src/app.js`, `src/accounts-ui.js`, `src/expenses-ui.js`, `src/scene-motion.js`, `src/mobile-swipe.js`, and `src/maps.js`, and the rules for them in `src/styles.css`, `src/accounts.css`, `src/expenses.css`, and `src/scene-motion.css`. Out of scope are Illustrations, text inputs, text areas, checkboxes, and all server code. The one exception is criterion 10.10, which gives every Single_Line_Input the 44 CSS pixel height of the Dropdowns.

**What the audit found.**

- **Icons come from five places.** `src/app.js` (stroke 1.7), `src/accounts-ui.js` (stroke 1.8), and `src/expenses-ui.js` each keep their own icon table, `src/maps.js` draws an external-link icon on a 16-unit view box, and `src/scene-motion.js` uses filled pause and play icons. `tent` and `calendar` have different shapes in `src/app.js` and `src/accounts-ui.js`, and an unknown icon name silently renders `tent`.
- **Text characters stand in for icons.** `⌄` on the profile control, `←` and `→` in back links, `＋` in 新增支出 and 手動新增一列, and `!` in the ledger's discard confirmation. The `‹` on the Swipe_Toggle belongs to the Swipe_Contract and stays.
- **Some icons mean several things.** ✕ (`close`) closes dialogs and also deletes items on seven card types. `→` marks navigation and also the actions 確認準備完成，出發, 完成這一站, and 填好名字，加入旅行. `people` marks companions, the 集合 activity type, and an activity's participants, so a 集合 Activity_Card shows the same icon twice with two meanings. `moon` is both the dark-theme switch and the 星空時間 type, `book` means both 規劃手冊 and a trip's status, and `tent` stands for six different things.
- **Buttons change with their container.** Every button starts from `.button`, but 27 container rules in `src/styles.css` and `src/expenses.css` change font size, padding, height, shadow, or underline, for example `.crew-panel>.button`, `.data-tools .button`, and a 13-pixel `.vehicle-departures-heading>.button` at 600 pixels and below. Controls use seven corner radii (7, 8, 9, 10, 11, 12, and 999 pixels) and three focus rings (3 pixels at a 4-pixel offset, 2 at 3, and 3 at 3).
- **Destructive actions have five looks.** Red text, red icon, red text link, quiet red, and filled red. The filled red confirm button in the ledger has white text on `#f3a294` in the dark theme, about 2.0:1. The swipe edit action's 12-pixel label is about 2.7:1 in the dark theme, and the scene-motion toggle keeps light-theme colors in the dark theme.
- **Some names are missing or differ.** The trip toolbar's 匯出手冊 button hides its text from 481 to 760 pixels and has no `aria-label`, so it has no accessible name at those widths. In Account_Mode the home link reads 我的首頁 on trip pages and 我的旅行 on account pages, and logout is a text button on one and a small button on the other. The Theme_Switch is named 切換深色模式 in `src/app.js` and 切換為深色模式 in `src/accounts-ui.js`, and the dialog close button is 關閉視窗 in one module and 關閉對話框 in the other.
- **Dropdowns are mostly unified already, but have no motion.** The 24 `select` templates (16 in `src/app.js`, 7 in `src/expenses-ui.js`, and 1 in `src/accounts-ui.js`) share one closed style with a person-colored variant, a customizable picker where `appearance: base-select` is supported, and native rendering under forced colors. The picker opens and closes without animation, the chevron is a CSS background image that does not react to opening, and in the planner and account forms the 44-pixel Dropdowns sit next to 48-pixel text inputs.
- **Expandable sections differ.** The five `details` sections, 匯出與重新載入, 畫面偏好, 料理筆記, 常用食材，點一下加進來, and AI 辨識結果, each have their own summary style, and none animates. The profile control shows `⌄`, which suggests a dropdown, but opens a dialog.
- **Some tabs add nothing.** The Section_Tabs render `01` to `07` numbers that the stylesheet hides at every width. In the Local_Planner the 分帳記帳 tab only says that expenses need an account. The account home's 全部 / 規劃中 / 已完成 filter repeats the page's two status sections. In the Mode_Switch, 出發模式 has two icons and 規劃手冊 has one.
- **Some card controls repeat.** The Account_Trip_Card's title link and 開啟旅行手冊 button open the same trip, and its status appears twice. Every Meal_Card has a 查看採買清單 button that opens the whole 採買清單 tab rather than that meal's items. Every Gear_Row renders a type icon that the stylesheet hides at every width. Edit and delete are icon-only on seven card types, text-only on the Member_Card and Settlement_Row, and an icon-and-text edit beside a text-only delete on the Account_Trip_Card and Admin_User_Row. The Swipe_Controller copies only icons into the Action_Panel, so a text-only action shows a label with no icon when swiped.

**Reviewed and kept.** These overlap without repeating a function, so no requirement changes them: the Shopping_Row's inline quantity and assignee controls beside its edit button, since the edit dialog also changes the name and category; a dialog's ✕ beside its 取消 button; 記錄已還款 in the ledger toolbar, which opens a blank form, and on each suggested transfer, which opens a filled-in one; 切換身分 in the crew tab beside the header profile control; and 看看我的行前清單 in the sidebar and 打開我的行前清單 on the gear tab, which stay in view after the Mode_Switch scrolls away. The hidden JSON import button on the account home also stays, because `tests/trip-deletion.e2e.js` keeps it for future use. The decisions below also keep the decorative Icons of RC7, the 回到我的首頁 Button of the 你的登入帳號 dialog, the CSS status dots, and the `→` text between two companion names in ledger rows.

**Compatibility.** The Swipe_Contract stays intact, including the `‹` Swipe_Toggle, the 68-pixel Swipe_Action width, the −3-pixel focus offset inside the Action_Panel, and the Schedule_Bar layout of its Requirement 7. One swipe behavior changes. Today the Swipe_Controller takes each swipe label from the words 編輯, 移除, and 刪除 in the accessible name of the copied Control and tests 編輯 first, so a meal named 編輯部聚餐 shows 編輯 on both of its Swipe_Actions, and its delete Swipe_Action gets the edit color. Criterion 17.9 takes the label from the action instead, 編輯 for edit and 刪除 for delete, and criterion 17.4 keeps 編輯, 移除, or 刪除 in the accessible names. Existing tests also pin values that this feature keeps: Person_Dropdowns are 156 by 44 pixels with a 1-pixel border, other Dropdowns are 44 pixels tall, the Dropdown_Picker has a 12-pixel radius and 6-pixel padding with options at least 44 pixels tall, every Control uses the `jf open 粉圓` font, and 13 e2e files rely on native `select` behavior (`selectOption`, the `combobox` role, or `appearance: base-select`).

**Open decisions.** The user has decided every Open_Decision, and the criteria follow the option in the Decision column. Another option would change the criteria in the last column.

| ID | Question | Options | Recommended | Decision | Criteria affected |
| --- | --- | --- | --- | --- | --- |
| D1 | Which visual style should the unified controls use? | A: today's sketchbook button style (2-pixel ink border, offset shadow) on every Control. B: the quieter style today's Dropdowns use (1-pixel border, soft shadow) on every Control. C: Buttons keep the sketchbook style, and Icon_Buttons, Dropdowns, Disclosures, Tabs, and Segments use the quieter style. | C, because it matches the cards and dialogs and keeps the Dropdown look that tests pin | C | None; only style values change |
| D2 | Should native `select` elements be replaced by a custom dropdown? | A: keep native `select`, styled as a customizable select, with the browser's own picker as the fallback. B: build a custom JavaScript listbox. | A, because 13 e2e files rely on native selects, and native selects keep keyboard, form, and high-contrast support | A | 6.7, 10.1, 10.4 to 10.7, 10.9, 10.11 to 10.15, 11.1, 11.2, 18.3 |
| D3 | Which icon should delete use? | A: a trash Icon for every delete and remove, with ✕ kept for closing. B: ✕ for both. | A, although the test title "meal card removes directly with an X" suggested ✕ for Meal_Cards | A, confirmed. The test "meal card removes directly with an X after confirmation" in `tests/app.e2e.js` becomes a Changed_Test | 3.2, 3.3, 9.2, 9.3, 14.4 |
| D4 | What should the profile control's `⌄` become? | A: remove `⌄` and keep the companion dialog in the Local_Planner and the account dialog in Account_Mode. B: make the profile control a dropdown menu holding identity, Theme, and account actions. | A, because B moves 登出 and the Theme_Switch into a menu and changes seven test steps that click them directly | A | 2.5, 3.5, 8.1, 8.5 |

**Removal candidates.** The user approved RC1 to RC6 and rejected RC7. Requirement 15 removes the approved candidates. RC2 and RC3 each offered two ways to remove a repeat that Requirement 14 forbids, and the criteria follow the chosen option. The Criteria column names the criteria that carry out each decision.

| ID | Candidate | Finding | Recommended | Tests that change | Decision | Criteria |
| --- | --- | --- | --- | --- | --- | --- |
| RC1 | In the Local_Planner only: the 分帳記帳 Section_Tab with its view, and the shopping tab's 收據辨識與分帳 link with the sentence 買好後，拍張收據逐項記帳。 beside it | The tab only says that expenses need an account. Its notice holds the Local_Planner's only 前往登入 link to `/login` | Remove from the Local_Planner and keep in Account_Mode | `tests/expenses.e2e.js` opens the planner's tab to check the notice | Approved; the Local_Planner keeps one 前往登入 Control | 15.3, 15.9 |
| RC2 | 查看採買清單 on every Meal_Card | Every card repeats the same jump to the 採買清單 tab | A: one 查看採買清單 link in the meals section heading. B: remove the button and rely on the Section_Tab | `tests/app.e2e.js` clicks the first 查看採買清單 button, which is the heading link under option A | Approved, option A | 14.2, 14.8, 15.3 |
| RC3 | The Account_Trip_Card's title link and 開啟旅行手冊 button | Both open the same trip | A: keep the button and show the title as plain text. B: keep the title link and remove the button | None found | Approved, option A | 14.1, 14.9, 15.3, 15.7 |
| RC4 | The 狀態 row with the `book` Icon on the Account_Trip_Card | Repeats the status tag on the cover | Remove the row and show 僅可檢視卡片 beside the status tag | None found | Approved | 15.3, 15.7, 15.8 |
| RC5 | 匯出手冊 in the trip toolbar | Runs the same `export` action as 匯出備份 in 旅行設定, which sits with the other data tools | Remove the toolbar copy | `tests/app.e2e.js` exports through `.toolbar-actions [data-action="export"]` | Approved | 15.3, 15.5 |
| RC6 | The 全部 / 規劃中 / 已完成 filter on the account home | Repeats the 規劃中的旅行 and 已完成的回憶 sections and their counts | Remove | None found | Approved | 15.3, 15.7 |
| RC7 | Decorative Icons: three leaves (hero note, sidebar footnote, schedule endnote), the tent in the Local_Planner footer, and the `✳` in the daily note | No function; part of the brand look | Keep | None | Rejected; the Icons stay | 15.4 |

**Refinement decisions.** Each requirement was refined on its own, and the user answered the questions that the refinement raised. The criteria apply these answers. An ID names the requirement and the question, so R4.Q1 is question 1 of Requirement 4.

| ID | Question | Applied answer | Criteria affected |
| --- | --- | --- | --- |
| R1.Q1 | Do the Icon_Meaning_Map, the replacement Icons, and the Button_Variant and Button_Size assignments need their own approval step? | No; the Control_Inventory records them for review | 1.1, 1.2, 4.1 |
| R1.Q2 | Which label applies while a label set of criterion 1.7 is Pending? | The proposed label | 1.5, 7.2, 7.7 |
| R1.Q3 | Which record of the decisions governs? | The Decision columns of this document; the Control_Inventory copies them | 1.5 |
| R2.Q1 | What replaces the `⌄` of the Identity_Button? | Nothing; D4 is A, so the `⌄` is omitted | 2.5, 3.5 |
| R2.Q2 | Which Icon sizes are allowed? | 16 to 24 CSS pixels inside Controls and 16 to 40 outside | 2.6, 2.7 |
| R2.Q3 | Do the Dropdown_Indicator and the picker check mark follow the Icon set? | Yes; the Dropdown_Indicator uses one of the two Icon sizes for Controls, and the check mark uses the geometry of the Selected_Icon | 2.6, 2.9, 10.6 |
| R2.Q4, R3.Q4 | Do the CSS status dots and the `→` between two companion names in ledger rows change? | No | None |
| R3.Q1 | May an informative Icon also appear as decoration? | Yes; Decorative_Icons outside Controls are exempt, so the tent keeps one informative meaning and also appears as decoration | 3.1, 3.2 |
| R3.Q2 | What happens to the other Icons with more than one meaning? | check, bag, car, and people each keep one meaning; the Control_Inventory chooses another Icon, or none, for their other uses | 1.3, 3.1, 3.2 |
| R3.Q3 | Which Icon marks content that expands? | The chevron, as both the Dropdown_Indicator and the Disclosure_Indicator, meaning "expands in place to show more" | 3.5, 10.8, 12.2 |
| R4.Q1 | Which Button_Variant do Dismiss Buttons in Action_Rows use? | Secondary, consistent with 9.5 | 4.14, 9.5 |
| R4.Q2 | Which Button_Variant does 邀請旅伴 use? | A design decision | None |
| R4.Q3 | Where are Style_Signatures read? | On the Control_Surface | 4.7, 4.8, Glossary |
| R5.Q1 | Where does hover feedback apply? | Only where Hover_Support applies | 5.1, 5.6 |
| R5.Q2 | Which Controls get a pressed Style_Signature? | Also Text_Links, the Identity_Button, and Card_Links; Swipe_Controls stay static | 5.3, 5.8 |
| R5.Q3 | Is feedback required under Forced_Colors? | No hover or pressed feedback is required | 5.1, 5.3 |
| R5.Q4 | Does a Theme change animate? | No | 5.9 |
| R6.Q1, R17.Q2 | How does the Swipe_Action Focus_Ring stay visible? | The shared ring color and width at the −3 CSS pixel offset, with a 2 CSS pixel line in the page background color inside the ring | 6.1, 6.2, 17.6 |
| R7.Q1 | Which name does the Dialog_Close_Button use? | 關閉視窗 | 7.3 |
| R7.Q3 | Does 編輯旅伴 change? | No; `tests/assignment-motion.e2e.js` clicks it | 14.5 |
| R8.Q1 | Which label does the Header_Nav home link use? | 我的旅行; the 回到我的首頁 Button of the 你的登入帳號 dialog keeps its label | 8.2 |
| R8.Q2 | In which order do the Header_Nav items appear? | Home link, admin link, Theme_Switch, account identity, logout | 8.1 |
| R8.Q4 | How are the Header_Nav items styled? | As on today's account pages: the home and admin links are Tabs with a Selected_Indicator while `aria-current="page"` applies, and 登出 is a `button` styled as a Compact Secondary Button | 8.6 |
| R8.Q5 | Which Icon marks 星空時間? | A star Icon | 3.9 |
| R9.Q1 | Which Button_Variant does 放棄草稿 use? | Danger | 4.13, 4.14, 9.1 |
| R9.Q2 | Is 匯入並取代 destructive? | Yes; it uses Danger and 9.4 covers it, while 匯入備份, which only opens the dialog, stays Secondary | 9.1, 9.4, Glossary |
| R9.Q3 | Where does 移除項目 sit? | At the start of the edit dialog's Action_Row, apart from 取消 and 儲存 | 9.8 |
| R10.Q1 | Which inputs get the Dropdown height? | Every Single_Line_Input in the App, at 44 CSS pixels | 10.10 |
| R10.Q2 | Which color does the chevron use? | The text color of the Dropdown | 10.8 |
| R10.Q3 | Question settled by the Requirement 11 drafts | Resolved by 11.1 and 11.2 | 11.1, 11.2 |
| R10.Q4 | How tall must the viewport be for 10.7? | At least 568 CSS pixels | 10.7 |
| R10.Q5 | Which condition gates the picker animation? | Custom_Picker_Mode | 11.1, 11.2 |
| R11.Q1 | Which way does the Disclosure_Indicator point? | Right while closed and down while open | 12.5, 12.6 |
| R11.Q2 | Must a Dropdown that a re-render replaces fade out? | No | 11.2 |
| R11.Q3 | In which browsers must Disclosures animate? | Chrome only | 11.3, 11.4 |
| R11.Q4 | Are the picker slide and the indicator turn confirmed? | Yes: a 4 to 8 CSS pixel slide and an animated turn | 11.1, 11.2 |
| R12.Q1 | Where does the Disclosure_Indicator sit? | Option A: a chevron before the summary text | 12.2 |
| R12.Q2 | Which Disclosures are open after a re-render? | Today's behavior stays | 11.10, 12.7 |
| R12.Q3 | Do Disclosures keep their boxes? | No; every Disclosure loses its border | 12.8 |
| R13.Q1 | How many Selected_Indicators are there? | Two: one for Tabs and one for Segments, Chips, and Choice_Cards | 13.3, 13.5 |
| R13.Q2 | How do disabled Chips look? | They keep the selected look | 5.5, 13.3 |
| R14.Q1 | Do 14.1 and 14.2 need exceptions for undecided candidates? | No; RC2 and RC3 are approved | 14.1, 14.2 |
| R14.Q2 | Does the Control_Inventory list Duplicate_Card_Actions? | Yes | 1.3 |
| R14.Q3 | Which element is the RC2 heading link? | A `button` named 查看採買清單 | 14.8 |
| R15.Q1, R15.Q2 | What else does RC1 remove, and how does the Local_Planner keep a way to `/login`? | RC1 also removes the sentence 買好後，拍張收據逐項記帳。, and one 前往登入 Control stays in the Local_Planner | 15.3, 15.9 |
| R15.Q3 | Question made moot by the decisions | No change | None |
| R15.Q4 | Do 4.10 and 6.4 cover Controls that are Hidden at every Audit_Width? | No; both exclude them | 4.10, 6.4 |
| R16.Q1 | Does the 75% opacity of unselected Date_Buttons stay? | No | 13.6, 16.1 |
| R16.Q2 | How is contrast met on companion and day colors? | Today's color values stay, with darker text where needed | 16.5 |
| R16.Q3 | Are disabled Controls exempt from the contrast criteria? | Yes | 16.1, 16.2 |
| R16.Q4 | Is a border contrast criterion needed? | No | None |
| R17.Q1 | How many Destructive_Colors are there? | One per Theme | 9.1, 9.2, 17.7 |
| R17.Q3 | Is the swipe label fix in scope? | Yes | 17.9 |
| R18.Q1 | How is the Baseline_App kept? | Initialize Git and commit the current files before the first change, after the user confirms at task time | Introduction |
| R18.Q2 | When is the Baseline_Result recorded? | Before the first edit, with Bun 1.3 or later, Node.js, and Chrome installed | 18.9, Glossary |
| R18.Q3 | What happens to tests that fail in the Baseline_Result? | They stay excluded | 18.1 |
| R18.Q4 | Which Theme_Switch names apply? | 切換深色模式 and 切換淺色模式 in every UI_Module | 7.4, 7.5 |
| R18.Q5 | Do single-line text inputs change height? | Yes, to 44 CSS pixels | 10.10 |
| R6.Q2, R6.Q3, R7.Q2, R8.Q3, R13.Q3, R13.Q4 | Items moved out of this feature | Listed under Follow-ups | None |

**Assumptions.** All copy stays in Traditional Chinese. Chrome runs the tests (`playwright.config.js`). Other browsers get the same closed Dropdown look, open their own picker where they lack Customizable_Select_Support, and need not animate Disclosures. No dependency is added. Where two labels exist for the same item, the Control_Inventory proposes one label for review, and criterion 7.7 applies the proposed label until the user decides. The workspace has no Git repository, so the tasks recommend initializing Git and committing the current files before the first change, once the user confirms at task time; that commit then keeps the Baseline_App. Building and testing need Bun 1.3 or later, Node.js, and Chrome, and neither Bun nor Node.js is on PATH today.

**Follow-ups (out of scope).** These items came up during refinement and are left for later work:

- restoring keyboard focus to the same Control after a re-render, and moving focus into the Action_Panel when a Swipe_Toggle is activated;
- placing keyboard focus after a deletion;
- scrolling the selected Tab into view at every width, while the Section_Tabs keep today's scrolling of the selected Section_Tab into view at 760 CSS pixels and below;
- making the account identity an Identity_Button that opens the 你的登入帳號 dialog on the account home, admin, invitation, and message pages, where it stays plain text;
- a pressed state that announces the current identity Choice_Card to screen readers.

## Glossary

- **App**: The 日子拾光 web application in this repository, made of the Local_Planner and Account_Mode.
- **Local_Planner**: The browser-only planner under `/demo/`, rendered by `src/app.js` without an account context.
- **Account_Mode**: The pages rendered by `src/accounts-ui.js` (setup, login, register, account home, admin, invitation, and message pages), plus the trip and departure pages that `src/app.js` renders with an account context.
- **UI_Module**: One of `src/app.js`, `src/accounts-ui.js`, `src/expenses-ui.js`, `src/scene-motion.js`, `src/mobile-swipe.js`, and `src/maps.js`.
- **Control_System**: The shared styles, the Icon_Registry, and the markup helpers through which every UI_Module renders Controls.
- **Control**: An interactive element that a UI_Module renders: a `button`, an `a`, a `select`, a `summary`, the selector button of a file input, or a `label` that wraps a visually hidden radio input. The header brand link, the skip link, text inputs, text areas, and visible checkboxes are not Controls.
- **Control_Family**: The kind of a Control, exactly one of Button, Icon_Button, Text_Link, Inline_Link, Inline_Edit, Identity_Button, Dropdown, Disclosure summary, Tab, Segment, Chip, Choice_Card, Card_Link, and Swipe_Control.
- **Control_Surface**: The element that draws the background, border, corner radius, and box shadow of a Control. For a Choice_Card built on a `label` that wraps a visually hidden radio input, it is the element inside the `label` that draws the card border. For every other Control, it is the Control itself. Dropdown_Pickers, their options, and other elements inside a Control are not Control_Surfaces.
- **Control_Action**: The action that a Control triggers, identified by each of the following that applies: the `data-` attribute (with its value, if it has one) through which the UI_Module handles activation of the Control, such as `data-action="theme"`, `data-act="theme"`, or `data-modal-close`; the link destination of an `a` element; the form that a submit button submits; the field that a Dropdown sets; the Disclosure that a `summary` opens and closes. For a Control that none of these identify, such as the Swipe_Toggle, it is a short description of what activating the Control does.
- **Button**: A Control that shows a text label, with or without an Icon, styled as a filled or outlined button, such as `.button`, the scene-motion toggle, and the selector button of a file input.
- **Button_Variant**: The role styling of a Button, exactly one of Primary, Secondary, Quiet, and Danger.
- **Button_Size**: The size of a Button, exactly one of Regular and Compact.
- **Icon_Button**: A Control that shows only an Icon, such as `.icon-button`.
- **Text_Link**: A standalone Control styled as text, such as `.text-button`, `.text-link`, `.back-link`, and `.unassigned-link`.
- **Inline_Link**: An `a` element inside a line of text, such as a map link from `src/maps.js`.
- **Inline_Edit**: A Control that shows a stored value and becomes a text input when activated, such as the Shopping_Row quantity.
- **Identity_Button**: The header Control (`.profile-button`) that shows the current companion in the Local_Planner and the display name of the signed-in account on trip and departure pages in Account_Mode.
- **Dropdown**: A `select` element.
- **Person_Dropdown**: A Dropdown that assigns a companion and shows the companion's representative color (`select.assignee-select`).
- **Dropdown_Picker**: The list of options that a Dropdown shows while open.
- **Dropdown_Indicator**: The chevron that marks a Dropdown, drawn with the geometry of the chevron Icon of the Icon_Registry.
- **Single_Line_Input**: An `input` element whose `type` attribute is absent or is `text`, `password`, `email`, `search`, `tel`, `url`, `number`, `date`, or `time`.
- **Disclosure**: A `details` element and its `summary`: 匯出與重新載入, 畫面偏好, 料理筆記, 常用食材，點一下加進來, and AI 辨識結果.
- **Disclosure_Content**: Everything inside the `details` element of a Disclosure except its `summary`.
- **Disclosure_Indicator**: The chevron Icon in a Disclosure summary that shows whether the Disclosure is open.
- **Open_Close_Animation**: An animation that Requirement 11 specifies for a Dropdown_Picker or a Disclosure as it opens or closes, including the turn of its Dropdown_Indicator or Disclosure_Indicator.
- **Menu_Button**: A Control that opens a list of actions anchored to the Control. The App has none, and the decision on Open_Decision D4 adds none.
- **Tab_Group**: The Section_Tabs, the Date_Tabs, the Header_Nav_Links, the Mode_Switch, or a Segmented_Filter.
- **Tab**: A Section_Tab, a Date_Button, or a Header_Nav_Link.
- **Section_Tabs**: The `.section-tabs` navigation of the trip page.
- **Section_Tab**: One item of the Section_Tabs, from 行程表 to 旅行設定.
- **Date_Tabs**: The `.date-tabs` group of Date_Buttons in the Schedule_Bar.
- **Date_Button**: A day button of the Date_Tabs, which shows `DAY nn`, the date, and the weekday. The Swipe_Contract uses the same term.
- **Schedule_Bar**: The `.schedule-bar` row at the top of the trip schedule, which holds the Date_Tabs and the Add_Stop_Button.
- **Add_Stop_Button**: The 新增一站 Button in the Schedule_Bar.
- **Page_Header**: The bar at the top of every page (`.topbar` in pages that `src/app.js` renders and `.acct-topbar` in pages that `src/accounts-ui.js` renders). It holds the header brand link and the header Controls, and it stays at the top of the viewport while the page scrolls.
- **Header_Nav**: The items that the Page_Header shows in Account_Mode while an account is signed in: the home link, the admin link, the Theme_Switch, the account identity, and the logout Control. The account identity shows the display name of the signed-in account; it is plain text on the account home, admin, invitation, and message pages and the Identity_Button on trip and departure pages. The logout Control is the 登出 `button`.
- **Header_Nav_Link**: The home link or the admin link of the Header_Nav.
- **Theme_Switch**: The Icon_Button that switches the Theme (`data-action="theme"` in `src/app.js` and `data-act="theme"` in `src/accounts-ui.js`).
- **Mode_Switch**: The `.mode-switch` links 規劃手冊 and 出發模式.
- **Segmented_Filter**: A `.segmented` button group: the shopping filter, the gear filter, or the account home trip status filter, which RC6 removes.
- **Segment**: An item of the Mode_Switch or of a Segmented_Filter.
- **Chip**: An ingredient shortcut button in the meal form.
- **Choice_Card**: A selectable card: an identity option in the companion dialog, or a cover option in the trip card form.
- **Card_Link**: A Card that is itself a link, which is the Home_Trip_Card.
- **Selection_Group**: A set of items among which the App marks the selected ones: the Section_Tabs, the Date_Buttons, the Header_Nav_Links, the Segments of the Mode_Switch, the Segments of one Segmented_Filter, the Chips of the meal form, the identity Choice_Cards of the companion dialog, or the cover Choice_Cards of the trip card form.
- **Selected_Item**: An item of a Selection_Group that is in the selected Interaction_State: a Section_Tab, Header_Nav_Link, or Mode_Switch Segment whose `aria-current` is `page`; a Date_Button, Segmented_Filter Segment, or Chip whose `aria-pressed` is `true`; the identity Choice_Card of the current companion; or the cover Choice_Card whose radio input is checked. An item whose `aria-pressed` is `true` is selected, not in the pressed Interaction_State.
- **Selected_Indicator**: The visual mark that shows a Selected_Item. Tabs share one Selected_Indicator, and Segments, Chips, and Choice_Cards share another.
- **Selected_Icon**: The Icon, drawn as a check mark, whose meaning in the Icon_Meaning_Map is "this item is selected". The check mark of criterion 10.6 has its geometry.
- **Swipe_Controller**: The `enableSwipeActions` behavior in `src/mobile-swipe.js`.
- **Swipe_Row**: A Card that carries the `data-swipe-row` attribute and that the Swipe_Controller has prepared with an Action_Panel and a Swipe_Toggle.
- **Row_Surface**: The part of a Swipe_Row that the Swipe_Controller moves sideways to reveal the Action_Panel, as the Swipe_Contract defines it. The Row_Surface excludes the Action_Panel and the Swipe_Toggle.
- **Action_Panel**: The `.swipe-actions` group that the Swipe_Controller builds in a Swipe_Row.
- **Swipe_Action**: A `.swipe-action` button that the Swipe_Controller clones into an Action_Panel. An edit Swipe_Action is cloned from an Edit_Card_Action, and a delete Swipe_Action is cloned from a Delete_Card_Action.
- **Swipe_Toggle**: The `.swipe-toggle` button that the Swipe_Controller adds to a Swipe_Row.
- **Swipe_Control**: A Swipe_Action or a Swipe_Toggle.
- **Swipe_Contract**: Everything that `.kiro/specs/mobile-smooth-swipe/requirements.md` specifies, including the `data-swipe-row` opt-in, the action allowlist of the Swipe_Controller, the clone conventions, the Swipe_Toggle markup and ARIA, the 68 CSS pixel Swipe_Action width, the Action_Panel clip and transitions, the −3 CSS pixel focus outline offset inside the Action_Panel, and the Schedule_Bar layout of its Requirement 7.
- **Interaction_State**: The state of a Control: rest, hover, pressed, focus-visible, disabled, or selected.
- **Style_Signature**: The computed background color, text color, border width, border style, border color, border radius, font family, font size, font weight, line height, padding, minimum height, box shadow, text decoration, and Icon-to-label gap of a Control in one Interaction_State, read on the Control_Surface of that Control.
- **Pointer_Press**: A pointer interaction with a Control. It starts when the primary mouse button, a pen tip, or a touch contact goes down on the Control. It ends when that button, pen tip, or contact is released, or when the browser cancels the interaction, for example because the touch starts to scroll the page.
- **Theme**: The light or dark color scheme set through `html[data-theme]`.
- **Focus_Ring**: The outline that the App draws around a Control in the focus-visible Interaction_State.
- **Reduced_Motion**: The condition `matchMedia('(prefers-reduced-motion: reduce)')` evaluating to true.
- **Forced_Colors**: The condition `matchMedia('(forced-colors: active)')` evaluating to true.
- **Hover_Support**: The condition `matchMedia('(hover: hover)')` evaluating to true.
- **Customizable_Select_Support**: The condition `CSS.supports('appearance', 'base-select')` evaluating to true.
- **Custom_Picker_Mode**: The condition in which Customizable_Select_Support applies and Forced_Colors does not apply.
- **Audit_Width**: One of the viewport widths 320, 390, 768, and 1440 CSS pixels; the widths N and N+1 CSS pixels for each `max-width: N` media query in the App's stylesheets (N = 400, 480, 560, 580, 600, 760, 860, and 1020); and the widths N−1 and N CSS pixels for each `min-width: N` media query (N = 761 and 1450).
- **Audited_View**: A page state that the Control_Inventory covers: the Local_Planner routes `#/home`, `#/trip` with each Section_Tab, `#/go`, `#/invite`, and `#/privacy`; the Account_Mode routes `/setup`, `/login`, `/register`, `/<account>/home`, `/admin`, `/invite/<token>`, `/<account>/trips/<id>` with each Section_Tab, and `/<account>/trips/<id>/go`; the ledger panel states (ledger, expense form, settlement form, receipt review, discard prompt, and removal confirmation); and every dialog that these views open.
- **Hidden**: The condition of a Control, an Icon, or text on an Audited_View that, at a given viewport width, renders with a width or height of 0 CSS pixels or with a computed `visibility` of `hidden`. It is measured with every Disclosure on the Audited_View open and with neither Reduced_Motion nor Forced_Colors applying.
- **Control_Inventory**: The audit document, kept in this spec's directory, that lists every Control and Icon on every Audited_View and records the user's decisions.
- **Icon**: An SVG pictogram that a UI_Module renders inside a Control or next to text. Illustrations are not Icons.
- **Illustration**: Artwork from `src/art.js`, including the logo, and from `src/dish-art.js`, and the animated scenes of `src/scene-motion.js`.
- **Icon_Registry**: The single module that defines the geometry of every Icon.
- **Icon_Meaning_Map**: The table in the Control_Inventory that gives each Icon name a meaning.
- **Context_Meaning**: A meaning that one rendered Icon carries where it appears. For an Icon inside a Control, it is one of these: the action of that Control; the destination of that Control, if it is a Navigation_Control; the current state of that Control, such as selected, open, or completed; or the kind of notice that the label or accessible name of that Control states. For an Icon outside a Control, it is the item type, item status, item property, or kind of notice that the Icon marks and that visible text in the same Card, notice, or line states. If no such text exists, it is decoration.
- **Decorative_Icon**: An Icon that repeats the meaning of adjacent text or adds no meaning.
- **Informative_Icon**: An Icon that carries meaning, such as an item type, a status, or the action of an Icon_Button.
- **Text_Glyph_Icon**: A text character used as a pictogram: `⌄`, `‹`, `←`, `→`, `＋`, or the `!` of the ledger's discard confirmation.
- **Edit_Icon**: The Icon whose meaning in the Icon_Meaning_Map is "edit this item".
- **Delete_Icon**: The Icon, drawn as a trash can, whose meaning in the Icon_Meaning_Map is "delete or remove this item".
- **Close_Icon**: The Icon, drawn as an ✕, whose meaning in the Icon_Meaning_Map is "close without changing data".
- **Arrow_Icon**: The Icon whose meaning in the Icon_Meaning_Map is "go to another view".
- **Navigation_Control**: A Control that moves to another route, page, or Section_Tab without changing stored data.
- **Destructive_Control**: A Control that deletes, removes, clears, or replaces stored data, that opens a Confirmation_Step or a browser prompt for such a change, or that confirms such a change. 匯入備份, which only opens the 匯入旅行備份 dialog, is not a Destructive_Control.
- **Destructive_Color**: The color, one per Theme, that marks the Danger Button_Variant as destructive in the rest Interaction_State. It is the background color of Danger Buttons if no Button of another Button_Variant uses that background color, and the label color of Danger Buttons otherwise.
- **Dismiss_Control**: A Control whose only effect is to close a dialog, a Dropdown_Picker, a panel, or a confirmation without changing stored data. A link that closes a dialog and also navigates, such as 預覽邀請頁, is a Navigation_Control and not a Dismiss_Control.
- **Discard_Confirm_Control**: The Control that confirms a Confirmation_Step that discards unsaved input without changing stored data. The only one today is 放棄草稿 in the ledger's discard prompt.
- **Confirmation_Step**: A dialog, row, or prompt that the App renders to ask the user to confirm a deletion, removal, clear, or discard before the App makes the change. Its Action_Row holds the Control that confirms the change. The Confirmation_Steps are the 移除這個項目？ and 清除這本旅行手冊？ dialogs, the 刪除旅行 and 刪除帳號 dialogs, the ledger's removal confirmation, and the ledger's discard prompt. A browser prompt from `window.confirm` is not a Confirmation_Step.
- **Dialog_Close_Button**: The Icon_Button in the `.dialog-heading` of a `dialog` element that closes that dialog: the `data-action="close-dialog"` button in `src/app.js` and the `data-modal-close` button in `src/accounts-ui.js`.
- **Action_Row**: The row of Controls that ends a form, a dialog, or a confirmation, such as `.form-actions` and `.xp-confirm-actions`.
- **Confirm_Button**: The Button in an Action_Row that submits the form that the Action_Row ends, or that carries out the change that the dialog or confirmation of that Action_Row asks about, such as 儲存, 匯入並取代, 確認移除, and 放棄草稿. An Action_Row has at most one Confirm_Button.
- **Card**: A repeated container that shows one item. Every Card is one of the Card types defined below.
- **Activity_Card**: The Card of an itinerary stop (`.activity-card`).
- **Departure_Vehicle_Card**: The Card of a vehicle's departure plan on the first trip day (`.departure-vehicle`).
- **Meal_Card**: The Card of a meal (`.meal-card`).
- **Shopping_Row**: The Card of a shopping item (`.shopping-row`).
- **Gear_Row**: The Card of a gear item (`.gear-row`).
- **Member_Card**: The Card of a companion (`.member-card`).
- **Vehicle_Card**: The Card of a vehicle in the crew tab (`.vehicle-card`).
- **Expense_Row**: The Card of a ledger expense (`.xp-row[data-xp-expense]`).
- **Settlement_Row**: The Card of a recorded repayment (`.xp-row[data-xp-settlement]`).
- **Transfer_Row**: The Card of a suggested repayment (`.xp-transfer`).
- **Account_Trip_Card**: The Card of a trip on the account home or admin page (`.acct-trip-card`).
- **Admin_User_Row**: The Card of an account on the admin page (`.acct-user-row`).
- **Home_Trip_Card**: The trip link on the Local_Planner home (`.trip-card`).
- **List_Card**: An Activity_Card, Departure_Vehicle_Card, Meal_Card, Shopping_Row, Gear_Row, Member_Card, Vehicle_Card, Expense_Row, Settlement_Row, or Transfer_Row.
- **Summary_Card**: An Account_Trip_Card or an Admin_User_Row.
- **Card_Action**: A Control inside a Card, other than a Swipe_Control.
- **Card_Action_Target**: The pair of the action that a Card_Action triggers (the `data-action`, `data-xp`, `data-tab`, or `data-nav-tab` value, or the link destination) and the identifier of the item that the action applies to (`data-id`, `data-xp-id`, `data-xp-index`, or none).
- **Edit_Card_Action**: A Card_Action, other than an Inline_Edit, that opens a form for changing the stored values of the item that its Card shows. Examples are the edit Icon_Button of an Activity_Card, 編輯旅伴 on a Member_Card, and 編輯卡片 on an Account_Trip_Card.
- **Delete_Card_Action**: A Card_Action that deletes or removes the item that its Card shows, or that opens the Confirmation_Step or browser prompt for deleting or removing that item. Examples are the delete Icon_Button of a Meal_Card, 移除 on a Settlement_Row, and 刪除旅行 on an Account_Trip_Card. A Control that confirms or cancels that Confirmation_Step, such as 確認移除 or 取消 in a ledger confirmation row, is not a Delete_Card_Action.
- **Duplicate_Card_Action**: A Card_Action that has the same Card_Action_Target as another Card_Action of the same Card, at an Audit_Width at which neither of the two is Hidden. A Card_Action rendered as an `a` element counts by its link destination, whatever its `data-action` value, so the title link and the 開啟旅行手冊 Button of an Account_Trip_Card are Duplicate_Card_Actions. A Dropdown or a Disclosure summary has no Card_Action_Target, and an Inline_Edit has its own Card_Action_Target, so the Person_Dropdowns of Shopping_Rows and Gear_Rows and the quantity Inline_Edit of a Shopping_Row are not Duplicate_Card_Actions of the Edit_Card_Action beside them.
- **Avatar**: The circle that shows the first character of a companion's name on that companion's representative color (`.avatar`).
- **Contrast_Ratio**: The ratio (L1 + 0.05) / (L2 + 0.05) that WCAG 2.2 defines, where L1 and L2 are the relative luminances of the lighter and the darker of two colors. It is measured on rendered colors, after the opacity of the element and of its ancestors is applied, and compared with a threshold without rounding.
- **Effective_Background**: The opaque color behind a piece of text, an Icon, or another mark, formed by compositing the background colors, background images, Illustrations, and opacity of the element and its ancestors over the page background. Where this color varies behind the text, Icon, or mark, the Effective_Background is the color that gives the lowest Contrast_Ratio.
- **Removal_Candidate**: A Control, an Icon, or another element listed in the Removal candidates table of this document.
- **Approved_Removal**: A Removal_Candidate that the Decision column of the Removal candidates table records as approved, together with the option recorded there.
- **Open_Decision**: A question listed in the Open decisions table of this document.
- **Test_Suite**: The unit tests in `tests/*.test.js` and the Playwright tests in `tests/*.e2e.js`.
- **Baseline_App**: The App, with its tests and scripts, exactly as it is before the first change of this feature, kept as an unmodified copy or version-control revision until this feature is accepted.
- **Test_Run**: One execution of every test in the Test_Suite on one set of files, after building those files with the App's build script. The unit tests run with Bun. The Playwright tests run through the isolated test harness that the README documents, with the Playwright configuration of the Baseline_App, which runs each test once without retries. A test passes in a Test_Run when it runs and reports no failure. A test that is skipped or does not run does not pass.
- **Test_Environment**: The operating system, the versions of Bun, Node.js, and Chrome, and the dependencies installed from the lock file, with which a Test_Run executes.
- **Baseline_Result**: For one Test_Environment, the outcome of every test in the Test_Suite, identified by its file and full title, in each of two Test_Runs on the Baseline_App, recorded before the first change of this feature. A test passes in the Baseline_Result only when it passes in both Test_Runs.
- **Changed_Test**: A test that passes in a Baseline_Result and whose title or at least one step states an expected outcome that an Approved_Removal, the approved option of an Open_Decision, or a criterion of Requirements 1 to 17 makes false. Under Open_Decision D3, the test titled "meal card removes directly with an X after confirmation" in `tests/app.e2e.js` is a Changed_Test, because its title describes the ✕ that the trash Icon replaces.
- **Retained_Control**: A Control that the Baseline_App renders on an Audited_View and that no Approved_Removal removes from that Audited_View. Criteria 13.7 and 17.3 use "retained" in this sense.
- **Access_Case**: The access of the person viewing an Account_Mode page. On the setup, login, register, account home, admin, invitation, and message pages, it is exactly one of: signed out, signed in with a member account, or signed in with an administrator account. On trip and departure pages, it is exactly one of: the trip's creator, an administrator who is not the creator and has joined the trip, an administrator who is not the creator and has not joined the trip, or a member account that has joined the trip and is not its creator.

## Requirements

### Requirement 1: Control and Icon Inventory

**User Story:** As the app owner, I want a complete list of every button, icon, tab, dropdown, and card action, so that I can review what exists and approve changes before anything is restyled or removed.

#### Acceptance Criteria

1. THE Control_Inventory SHALL record the following in the entry of every Control: the UI_Module that renders the Control; every Audited_View on which the Control is rendered; the Control_Family of the Control and, for each Theme, the accessible name that Chrome computes for the Control, both taken at the widest Audit_Width at which the Control is not Hidden, or taken from the markup for a Control that is Hidden at every Audit_Width, with the accessible name given once when both Themes give the same name; the Control_Action; which of Destructive_Control, Dismiss_Control, and Navigation_Control the Control is, if any; for a Button, the Button_Variant and Button_Size that the Control_Inventory assigns to the Button; and, for a Card_Action, the type of the Card that holds the Card_Action and whether its Card_Action_Target names the item that the Card shows, another item, or no item.
2. THE Control_Inventory SHALL record the following in one entry for each Icon name at each place where a UI_Module renders an Icon with that name on an Audited_View in either Theme: the Icon name, which is the name under which the UI_Module defines the Icon or, for an Icon that the UI_Module draws without a name, a name that the Control_Inventory assigns; the UI_Module that draws the Icon; the place, given as the entry of the Control that holds the Icon, or as the text that the Icon accompanies and the Card or page section that holds that text; the meaning of the Icon at that place; the meaning that the Icon_Meaning_Map assigns to the Icon name; and whether the Icon is a Decorative_Icon or an Informative_Icon at that place.
3. THE Control_Inventory SHALL list every Text_Glyph_Icon, with the entry of the Control or the notice that shows it and either the Icon name that replaces it or a note that it stays or is removed; every Control, Icon, and text inside a Control that is Hidden at every Audit_Width, in both Themes, and in every state of its Audited_View; every Icon entry whose meaning at its place differs from the meaning that the Icon_Meaning_Map assigns to its Icon name, with the Icon name proposed for that place or a note that the place will show no Icon; every Icon name that two UI_Modules define with different geometry; and every Card type whose Cards hold Duplicate_Card_Actions, with the entries of those Card_Actions and each Audit_Width at which neither of them is Hidden.
4. THE Control_Inventory SHALL list in the entry of every Control each Audit_Width at which the Control is Hidden, and each other Audit_Width at which the visible label of the Control is Hidden, the Control_Family of the Control differs from the Control_Family that criterion 1.1 records, or, in either Theme, the accessible name of the Control is empty or differs from the accessible name that criterion 1.1 records for that Theme.
5. THE Control_Inventory SHALL copy the decision on every Open_Decision, as the chosen option or Pending, and on every Removal_Candidate, as approved with the chosen option, rejected, or Pending, from the Decision columns of this document, which govern where the two records differ, and SHALL record the user's decision on every set that criterion 1.7 lists, as approved as proposed, replaced by the visible label, accessible name, or Control_Family that the user chose, or Pending.
6. THE Control_Inventory SHALL describe in an entry every Control that a UI_Module renders on an Audited_View before this feature changes any Control, including Hidden Controls and Controls that a UI_Module renders only for some account roles or trip permissions or only in some states of the App or of an item, and SHALL describe in one shared entry the Controls that one UI_Module renders for different items and that differ only in the item they apply to and in that item's name or color.
7. THE Control_Inventory SHALL list every set of two or more Controls, other than Swipe_Controls, that produce the same result when activated but differ in visible label, accessible name, or Control_Family, and SHALL give for each set either one proposed visible label, accessible name, and Control_Family, or a note that the differences stay.
8. THE Control_Inventory SHALL record, for every Approved_Removal, the entries of the Controls and Icons that the chosen option removes or changes, a description of each Control that the chosen option adds, the Audited_Views on which the Approved_Removal applies, and, for each function of a Control that the Approved_Removal removes, either the entry of a remaining Control in the same Local_Planner or Account_Mode that performs the function or a note that the Approved_Removal removes the function.

### Requirement 2: One Icon Set

**User Story:** As a user, I want every icon to come from one consistent set, so that every screen looks like part of the same app.

#### Acceptance Criteria

1. THE Icon_Registry SHALL define every Icon name that a UI_Module requests, with exactly one SVG geometry for each Icon name and no SVG geometry shared by two Icon names.
2. THE Icon_Registry SHALL render every Icon as one inline `svg` element with a view box of `0 0 24 24`, no fill, a stroke width from 1.5 to 2 view box units that is the same for every Icon, round line caps, round line joins, and the current text color as the stroke color.
3. THE Icon_Registry SHALL render every Icon with `aria-hidden="true"` and `focusable="false"`.
4. IF a UI_Module requests an Icon name that the Icon_Registry does not define, THEN THE Icon_Registry SHALL render no `svg` element for that request, without throwing an exception, and SHALL write at least one error-level entry that contains the requested Icon name to the browser console.
5. THE Control_System SHALL render every Text_Glyph_Icon inside a Control, and the `!` of the ledger's discard confirmation, as an Icon from the Icon_Registry in the place of that character, except the `‹` text of the Swipe_Toggle, which stays text, and the `⌄` of the Identity_Button, which the Control_System omits with no Icon in its place.
6. THE Control_System SHALL render every Icon that is not Hidden inside a Control, and the Dropdown_Indicator of every Dropdown, at an equal rendered width and height from 16 to 24 CSS pixels, using at most two distinct sizes across all Audited_Views, all Audit_Widths, and both Themes.
7. THE Control_System SHALL render every Icon that is not Hidden outside Controls at an equal rendered width and height from 16 to 40 CSS pixels, using at most three distinct sizes across all Audited_Views, all Audit_Widths, and both Themes.
8. THE Control_System SHALL render every `svg` element in the markup of every UI_Module, other than an `svg` element of an Illustration, as an Icon from the Icon_Registry with the SVG geometry that the Icon_Registry defines for the requested Icon name, including the external-link Icon of map links, the pause and play Icons of the scene-motion toggle, and the Icons that the Swipe_Controller copies into Swipe_Actions.
9. WHILE Controls share a Control_Family, a viewport width, and, where the Controls are Buttons, a Button_Size, THE Control_System SHALL render every Icon that is not Hidden inside those Controls, including the Dropdown_Indicator of each Dropdown, at the same size.

### Requirement 3: One Meaning per Icon

**User Story:** As a user, I want each icon to mean the same thing everywhere, so that I can trust an icon without reading its label every time.

#### Acceptance Criteria

1. THE Icon_Meaning_Map SHALL assign to every Icon name that the Icon_Registry defines exactly one meaning, which is one action, one destination, one state of a Control, one item type, one item status, one item property, one kind of notice, or decoration, without counting the places where an Icon with that name is a Decorative_Icon outside Controls, and SHALL assign every meaning other than decoration to exactly one Icon name.
2. THE Control_System SHALL show every Icon other than a Decorative_Icon outside Controls, on every Audited_View, at every Audit_Width, and in both Themes, only where the meaning that the Icon_Meaning_Map assigns to the Icon name of that Icon is a Context_Meaning of that Icon.
3. THE Control_System SHALL show the Delete_Icon, drawn as a trash can, only on Destructive_Controls, SHALL show the Delete_Icon as the only Icon of every Destructive_Control that shows an Icon, other than a Destructive_Control that replaces stored data, and SHALL show the Close_Icon, drawn as an ✕, only on Dismiss_Controls.
4. THE Control_System SHALL show the Arrow_Icon, in any position, only on Navigation_Controls, and SHALL show no Arrow_Icon on the 確認準備完成，出發, 完成這一站, and 填好名字，加入旅行 Buttons, which change stored data.
5. THE Control_System SHALL show the chevron Icon, whose meaning in the Icon_Meaning_Map is "expands in place to show more", only as the Dropdown_Indicator of a Dropdown, as the indicator of a Menu_Button, and as the Disclosure_Indicator of a Disclosure summary, and SHALL render the Identity_Button without the `⌄` character.
6. THE Control_System SHALL pair every Informative_Icon, at every Audit_Width, with a text or state equivalent of the meaning that the Icon_Meaning_Map assigns to its Icon name. For an Informative_Icon inside a Control, the equivalent is the visible label, the accessible name, or the state that the Control exposes to assistive technology, such as expanded, pressed, or current. For an Informative_Icon outside a Control, it is visible text in the same Card, notice, or line.
7. THE Control_System SHALL show in every Control, at the same time, at most one Icon before the visible label, at most one Icon after the visible label, and no Icon between two characters of the visible label, and SHALL show exactly one Icon in every Icon_Button.
8. THE Icon_Registry SHALL use each geometry for at most one Icon name.
9. THE Control_System SHALL render the activity type Icon of every Activity_Card whose activity type is 星空時間 as a star Icon whose Icon name and SVG geometry differ from those of the moon Icon of the Theme_Switch.

### Requirement 4: Unified Buttons

**User Story:** As a user, I want buttons with the same role to look the same wherever they appear, so that I can tell main, secondary, and destructive actions apart at a glance.

#### Acceptance Criteria

1. THE Control_System SHALL render every Button with exactly one Button_Variant and exactly one Button_Size, namely the Button_Variant and Button_Size that the Control_Inventory records for that Button.
2. WHILE Forced_Colors does not apply and two Buttons share a Button_Variant, an Interaction_State, a Theme, and an Audit_Width, THE Control_System SHALL render the two Buttons with identical Style_Signatures, except that Buttons of different Button_Sizes may differ in font size, line height, padding, minimum height, and Icon-to-label gap, whichever UI_Module renders each Button, whichever Audited_View, Card, or container holds it, and whether it is a `button` element, an `a` element, or the selector button of a file input.
3. WHILE Forced_Colors does not apply and two Icon_Buttons share an Interaction_State, a Theme, and an Audit_Width, with both or neither of them being a Destructive_Control, THE Control_System SHALL render the two Icon_Buttons with identical Style_Signatures, called the destructive Style_Signature when both are Destructive_Controls and the non-destructive Style_Signature when neither is, whichever UI_Module renders each Icon_Button and whichever Audited_View, Card, or container holds it.
4. WHILE Forced_Colors does not apply and two Text_Links share an Interaction_State, a Theme, and an Audit_Width, THE Control_System SHALL render the two Text_Links with identical Style_Signatures, whichever UI_Module renders each Text_Link, whichever Audited_View, Card, or container holds it, and whether it is a `button` element or an `a` element.
5. WHILE two Inline_Links share an Interaction_State and a Theme, THE Control_System SHALL render the two Inline_Links with the same text color, the same Focus_Ring, and an underline with the same line style, color, thickness, and underline offset, whichever Audited_View or Audit_Width shows each Inline_Link.
6. WHILE Forced_Colors does not apply, THE Control_System SHALL render the selector button of every file input that is not Hidden with the Style_Signature of a Compact Secondary Button in the same Interaction_State, Theme, and Audit_Width.
7. THE Control_System SHALL use at most three distinct non-zero computed corner radius values on the Control_Surfaces of all Controls other than Card_Links, counted together over every corner, Audited_View, Audit_Width, Theme, and Interaction_State.
8. THE Control_System SHALL use at most two distinct computed box shadow values other than `none` on the Control_Surfaces of all Controls other than Card_Links in each combination of Theme and Interaction_State, counted together over every Audited_View and Audit_Width.
9. THE Control_System SHALL render the visible text of all Buttons, Text_Links, closed Dropdowns, Disclosure summaries, Section_Tabs, Header_Nav items, Segments, and Chips in at most three distinct computed font sizes at each Audit_Width, counted together over every Audited_View, Theme, and Interaction_State.
10. THE Control_System SHALL give every Control other than an Inline_Link and the Swipe_Toggle a target area of at least 44 by 44 CSS pixels at every Audit_Width at which the Control is not Hidden, where the target area is the border box of the Control, or of the file input for the selector button of a file input.
11. THE Control_System SHALL give the Swipe_Toggle a target area of at least 24 by 24 CSS pixels, measured as its border box, at every Audit_Width at which the Swipe_Toggle is not Hidden.
12. THE Control_System SHALL place the Confirm_Button of every Action_Row after every other Dismiss_Control of that Action_Row in document order and, at every Audit_Width, on screen to the right of each such Dismiss_Control when their border boxes overlap vertically, or with its top edge at or below the bottom edge of that Dismiss_Control when they do not.
13. THE Control_System SHALL render every Confirm_Button that is neither a Destructive_Control nor a Discard_Confirm_Control with the Primary Button_Variant, and SHALL render at most one Primary Button in each Action_Row and in each Card.
14. THE Control_System SHALL render every Dismiss_Control that is a Button in an Action_Row, other than a Discard_Confirm_Control, with the Secondary Button_Variant.
15. WHILE Forced_Colors does not apply, THE Control_System SHALL render any two Buttons of different Button_Variants, and any Icon_Button that is a Destructive_Control together with any Icon_Button that is not, so that the two differ in background color, border color, or text color in each of the rest, hover, and pressed Interaction_States, in both Themes and at every Audit_Width, counting a transparent color as the page background color of that Theme.

### Requirement 5: Interaction Feedback and Motion

**User Story:** As a user, I want controls to respond smoothly when I hover over or press them, so that the app feels modern and I can see that my input registered.

#### Acceptance Criteria

1. WHILE Hover_Support applies and Forced_Colors does not apply, WHEN the pointer moves over an enabled Control, THE Control_System SHALL render the hover Style_Signature of that Control, which differs from the Style_Signature that the Control shows while the pointer is not over it in at least one of background color, text color, border color, box shadow, and text decoration, and which keeps the layout width and height of the Control unchanged.
2. WHILE Reduced_Motion does not apply, WHEN an enabled Control changes between the hover Interaction_State and the rest or selected Interaction_State, THE Control_System SHALL animate every change in its colors, its box shadow, and the position, scale, or rotation at which it is drawn, over one duration from 100 to 200 milliseconds that is the same for every Control.
3. WHILE Forced_Colors does not apply, WHEN a Pointer_Press starts on an enabled Button, Icon_Button, Text_Link, Identity_Button, Tab, Segment, Chip, Choice_Card, or Card_Link, THE Control_System SHALL finish changing that Control to its pressed Style_Signature within 100 milliseconds and SHALL hold that Style_Signature until the Pointer_Press ends, where the pressed Style_Signature differs from the Style_Signature that the Control showed just before the Pointer_Press in at least one of background color, text color, border color, box shadow, and text decoration, and keeps the layout width and height of the Control unchanged.
4. WHILE Reduced_Motion applies, THE Control_System SHALL show every Interaction_State change of a Control in full in the first rendered frame after the change, without changing the position, scale, or rotation at which the Control is drawn, and SHALL render each Interaction_State with the same Style_Signature as when Reduced_Motion does not apply.
5. WHILE a Control is disabled, which for a Choice_Card or the selector button of a file input means that its input is disabled, THE Control_System SHALL render the disabled Style_Signature of that Control in place of the hover and pressed Style_Signatures and without moving the Control, SHALL draw the Control with at least one of text color, background color, border color, border style, and opacity different from the same Control while it is enabled and neither hovered nor pressed, and SHALL draw a disabled Selected_Item with the background color, border, and Selected_Indicator that the same item has while it is enabled and selected.
6. WHILE Hover_Support does not apply, WHEN a Pointer_Press on an enabled Control ends, THE Control_System SHALL render that Control, within 200 milliseconds, with its rest, selected, or disabled Style_Signature, whichever applies after the Pointer_Press.
7. WHILE the Row_Surface of a Swipe_Row is translated away from its closed position, THE Control_System SHALL translate every Control inside that Row_Surface by the same horizontal distance as the rest of the Row_Surface within 1 CSS pixel, in every Interaction_State of that Control and in both Themes.
8. THE Control_System SHALL draw every Swipe_Control at the same position and size in every Interaction_State as in the rest Interaction_State.
9. WHEN the Theme changes, THE Control_System SHALL show every Control that is not Hidden with the colors and box shadow of the new Theme in the first frame that the browser renders after the change, without animating between the two Themes.

### Requirement 6: Keyboard Focus and Operation

**User Story:** As a keyboard user, I want one clear focus ring and full keyboard control of every button, tab, dropdown, and expandable section, so that I can use the app without a mouse.

#### Acceptance Criteria

1. WHEN a Control receives keyboard focus, THE Control_System SHALL draw the Focus_Ring around that Control, or around the visible card of a Choice_Card built on a radio input, as a solid outline 2 to 4 CSS pixels wide placed 0 to 4 CSS pixels outside the border, with one width and one offset shared by every Control in both Themes and one color shared by every Control in the current Theme, except that each Swipe_Action draws the Focus_Ring inside its border at the offset that criterion 17.6 specifies.
2. THE Control_System SHALL draw the Focus_Ring of every Control other than a Swipe_Action, in both Themes, at a Contrast_Ratio of at least 3:1 against the color of every pixel that the Focus_Ring covers, as that pixel appears while the Control is not focused, and SHALL draw the Focus_Ring of every Swipe_Action at a Contrast_Ratio of at least 3:1 against the line that criterion 17.6 draws along its inner edge.
3. WHEN a Control receives keyboard focus, THE Control_System SHALL show the whole Focus_Ring of that Control inside the viewport, with no part of it cut off by an ancestor that scrolls or clips its content, such as the Section_Tabs, the Date_Tabs, the Mode_Switch, a Card, a dialog, or the Action_Panel, and no part of it covered by the Page_Header or by the heading row or the Action_Row of a dialog.
4. THE Control_System SHALL keep out of the Tab order every Control that is disabled, Hidden at the current viewport width, inside a closed Disclosure or a closed Action_Panel, or outside an open dialog or discard prompt, and SHALL keep every other Control in the Tab order, reached by the Tab key in document order and by Shift+Tab in reverse order, with one stop for each group of Choice_Cards built on radio inputs and with the Controls that share a row in an Action_Row, a Tab_Group, or a Card in their left-to-right order on screen.
5. THE Control_System SHALL keep activation by the Enter key and by the Space key for every Control rendered as a `button` element, a `summary` element, or a file input, and activation by the Enter key for every Control rendered as an `a` element, with the same result as a pointer click on that Control.
6. WHILE the radio input of a Choice_Card has keyboard focus, THE Control_System SHALL keep the radio group behavior of the browser, in which ArrowRight and ArrowDown move focus to and select the next Choice_Card of the group, ArrowLeft and ArrowUp move focus to and select the previous one, the movement wraps between the last and the first Choice_Card, and the Space key selects the focused Choice_Card.
7. WHILE keyboard focus is on a Dropdown or on an option of its Dropdown_Picker, THE Control_System SHALL keep the keyboard behavior of the browser, in which the Space key opens the Dropdown_Picker; ArrowUp, ArrowDown, Home, and End move keyboard focus between the options of the open Dropdown_Picker; Enter selects the focused option and closes the Dropdown_Picker; Escape closes the Dropdown_Picker without changing the value and without closing the dialog or panel that holds the Dropdown; and keyboard focus returns to the Dropdown after the Dropdown_Picker closes.

### Requirement 7: Accessible Names

**User Story:** As a screen reader user, I want every control to announce a clear and stable name at every screen width, so that I know what each control does.

#### Acceptance Criteria

1. THE Control_System SHALL give every Icon_Button, every Swipe_Control, and every Control whose visible label is Hidden at one or more Audit_Widths an accessible name that contains at least one character other than white space and Text_Glyph_Icon characters, on every Audited_View and at every Audit_Width at which the accessibility tree contains that Control.
2. THE Control_System SHALL give every Retained_Control, including a Control whose markup or Control_Family changes, the non-empty accessible name that the Control has before this feature on the same Audited_View in the same App state, except that the name drops each Text_Glyph_Icon character and the white space next to it, and except for the name changes that criteria 7.3, 7.4, 7.5, 7.7, and 8.2 require.
3. THE Control_System SHALL give every Dialog_Close_Button the accessible name `關閉視窗`.
4. WHILE the light Theme applies, THE Control_System SHALL give every Theme_Switch the accessible name `切換深色模式`.
5. WHILE the dark Theme applies, THE Control_System SHALL give every Theme_Switch the accessible name `切換淺色模式`.
6. THE Control_System SHALL give every Control the same accessible name at every Audit_Width at which the accessibility tree contains that Control, on the same Audited_View in the same App state.
7. THE Control_System SHALL give the Controls of every set that criterion 1.7 lists with a proposal the visible label, accessible name, and Control_Family that the Control_Inventory records as the decision on that set under criterion 1.5, or the proposed ones while that decision is Pending.

### Requirement 8: Header Controls Across Pages

**User Story:** As a signed-in user, I want the header to show the same controls in the same order on every page, so that I can always find the home link, the theme switch, and logout.

#### Acceptance Criteria

1. WHILE an account is signed in, THE Control_System SHALL render the Header_Nav of every Account_Mode page with exactly these items, in this order in the document and in the same order on screen (left to right, then top to bottom): the home link, the admin link for an account with the admin role and for no other account, the Theme_Switch, the account identity, and the logout Control.
2. WHILE an account is signed in, THE Control_System SHALL give the Header_Nav home link the visible label 我的旅行 and the accessible name 我的旅行 on every Account_Mode page, and SHALL keep the label 回到我的首頁 on the Button of the 你的登入帳號 dialog.
3. THE Control_System SHALL render the Theme_Switch with the moon Icon in the light Theme and with the sun Icon in the dark Theme on every Audited_View of the Local_Planner and of Account_Mode.
4. WHILE an account is signed in, THE Control_System SHALL give each Header_Nav item the same Control_Family, visible text, Icons, accessible name, and Style_Signature on every Account_Mode page that the account views, compared at the same Theme, viewport width, and Interaction_State, except that the account identity, which stays plain text on the account home, admin, invitation, and message pages and stays the Identity_Button on trip and departure pages, may differ between those two groups of pages in Control_Family, Style_Signature, visible text, and accessible name, and shows the display name of the signed-in account on every Account_Mode page.
5. WHILE no dialog is open and the page is scrolled to the top, THE Control_System SHALL show the Theme_Switch of every Audited_View, and each Header_Nav item that criterion 8.1 requires, as items of the Page_Header that are not Hidden at any Audit_Width, outside any Disclosure and any list that a Menu_Button opens, with the whole bounding box of each item inside the viewport.
6. WHILE an account is signed in, THE Control_System SHALL render the Header_Nav_Links as Tabs, SHALL mark the Header_Nav_Link whose `aria-current` is `page` with the Selected_Indicator of Tabs, and SHALL render the logout Control as a `button` element with the Secondary Button_Variant and the Compact Button_Size.

### Requirement 9: Destructive and Dismiss Controls

**User Story:** As a user, I want delete actions to look clearly different from closing a window, so that I do not remove something by mistake.

#### Acceptance Criteria

1. THE Control_System SHALL render every Destructive_Control that shows a text label, other than a Swipe_Action, and every Discard_Confirm_Control as a Button that has the Danger Button_Variant and keeps the Destructive_Color of the current Theme as its background color, or as its label color where the Destructive_Color is the label color of Danger Buttons, in the rest, hover, pressed, and focus-visible Interaction_States.
2. THE Control_System SHALL render every Destructive_Control that shows only an Icon, other than a Swipe_Action, as an Icon_Button that has the destructive Style_Signature and draws the Delete_Icon in the Destructive_Color of the current Theme in the rest, hover, pressed, and focus-visible Interaction_States.
3. THE Control_System SHALL render every Dismiss_Control that shows only an Icon, other than a Swipe_Control, as an Icon_Button that has the non-destructive Style_Signature and draws the Close_Icon in a color other than the Destructive_Color of the current Theme in every Interaction_State.
4. WHEN a Destructive_Control that starts a deletion, removal, clear, or replacement is activated, directly or through its delete Swipe_Action, THE App SHALL show the browser confirmation prompts, the message that refuses the change, or the Confirmation_Step that the App showed before this feature for the same item, page, and unsaved input, in the same order and with the same heading, message text, text inputs, labels of the Controls in the Action_Row, and condition for enabling the Control that confirms the change.
5. THE Control_System SHALL render every Dismiss_Control that shows a text label, other than a Swipe_Control or a Discard_Confirm_Control, as a Button with one Button_Variant that all such Dismiss_Controls share and that is neither Primary nor Danger.
6. WHEN a Confirmation_Step opens, THE App SHALL keep keyboard focus off the Control that confirms the change until the user moves focus to that Control.
7. IF the user closes a Confirmation_Step without activating the Control that confirms the change, THEN THE App SHALL leave stored data, and any unsaved input that the Confirmation_Step offered to discard, unchanged.
8. THE Control_System SHALL render the 移除項目 Button of every edit form dialog as the first Control of its Action_Row in document order and at the left end of that Action_Row on screen, and, at every Audit_Width at which the 移除項目 Button shares a line with the 取消 Button and that line has space left over, SHALL place that space between the 移除項目 Button and the 取消 Button.

### Requirement 10: Unified Dropdowns

**User Story:** As a user, I want every dropdown to look and work the same, with a modern option list, so that choosing a value feels familiar on every form.

#### Acceptance Criteria

1. THE App SHALL render every Control that opens a list of options anchored to the Control for choosing one value as a native `select` element with the `combobox` role, and SHALL give the `combobox` and `listbox` roles to no other element that a UI_Module renders.
2. WHILE two Dropdowns share an Interaction_State, a Theme, a viewport width, and the open or closed state of their Dropdown_Pickers, THE Control_System SHALL render the two Dropdowns with identical Style_Signatures, whichever UI_Module, Audited_View, or container renders each Dropdown, except for the background color and text color of a Person_Dropdown.
3. WHILE two Person_Dropdowns show the same representative color, or both have no companion assigned, and share an Interaction_State, a Theme, a viewport width, and the open or closed state of their Dropdown_Pickers, THE Control_System SHALL render the two Person_Dropdowns with identical Style_Signatures, whichever UI_Module, Audited_View, or container renders each one.
4. WHILE Custom_Picker_Mode applies, THE Control_System SHALL render every Dropdown with a computed `appearance` value of `base-select`, and every Dropdown_Picker with the same background color, border, box shadow, and option font size as every other Dropdown_Picker in the same Theme, a corner radius of 12 CSS pixels, a padding of 6 CSS pixels on every side, and a width at least equal to the width of its Dropdown.
5. WHILE Custom_Picker_Mode applies, THE Control_System SHALL render every option of every Dropdown_Picker at least 44 CSS pixels tall, and SHALL show the whole label of every option, wrapping a label that is wider than the option onto more lines.
6. WHILE Custom_Picker_Mode applies, THE Control_System SHALL mark the selected option of every Dropdown_Picker, meaning the option that holds the current value of the Dropdown, with a check mark that has the geometry and stroke width of the Selected_Icon at the right end of the option, and SHALL show that check mark on no other option.
7. WHILE Custom_Picker_Mode applies and the viewport is an Audit_Width wide and at least 568 CSS pixels tall, WHEN the user opens a Dropdown whose border box lies inside the viewport, THE Control_System SHALL show the whole Dropdown_Picker inside the viewport once it has finished opening, at most 8 CSS pixels below or above the Dropdown, with the selected option in view and every other option reachable by scrolling inside the Dropdown_Picker.
8. WHILE Forced_Colors does not apply, THE Control_System SHALL draw the Dropdown_Indicator of every closed Dropdown with the geometry and stroke width of the chevron Icon of the Icon_Registry, pointing downward and in the text color of that Dropdown, at the same rendered size and the same distance from the right border edge in every Dropdown, with its vertical center within 1 CSS pixel of the vertical center of the Dropdown.
9. WHILE Custom_Picker_Mode applies and the Dropdown_Picker of a Dropdown is open, THE Control_System SHALL show the Dropdown_Indicator of that Dropdown pointing upward, rotated 180 degrees from the closed orientation of criterion 10.8.
10. THE Control_System SHALL give every Single_Line_Input that is not Hidden a border-box height of 44 CSS pixels, which is the Dropdown height of criterion 18.3, at every Audit_Width.
11. WHILE the browser lacks Customizable_Select_Support and Forced_Colors does not apply, THE Control_System SHALL render every closed Dropdown with the Style_Signature and the Dropdown_Indicator that the same Dropdown has in Custom_Picker_Mode in the same Interaction_State, Theme, and viewport width.
12. WHILE the browser lacks Customizable_Select_Support, WHEN the user opens an enabled Dropdown, THE Control_System SHALL open the native picker of the browser for that Dropdown and SHALL show no other list of options.
13. WHILE Forced_Colors applies, THE Control_System SHALL render every Dropdown with the native appearance of the browser, shown by a computed `appearance` value of `auto`, SHALL open the native picker of the browser for every Dropdown, and SHALL show the browser's own arrow in place of the Dropdown_Indicator.
14. WHILE Custom_Picker_Mode applies, WHEN an option of an open Dropdown_Picker receives focus through keyboard input, THE Control_System SHALL draw an outline with the color, width, and style of the Focus_Ring of the current Theme inside the bounds of that option.
15. WHILE Custom_Picker_Mode applies, THE Control_System SHALL render the label of every enabled option and every option group label in every Dropdown_Picker at a Contrast_Ratio of at least 4.5:1, and the check mark of criterion 10.6 and the outline of criterion 10.14 at a Contrast_Ratio of at least 3:1, against the background of the option or option group, in each of the rest, hover, keyboard-focus, and selected states of the option and in both Themes.
16. WHILE Forced_Colors does not apply, IF the label of the selected option is wider than the space before the Dropdown_Indicator of a closed Dropdown, THEN THE Control_System SHALL show that label on one line from its first character, cut off before the Dropdown_Indicator, without changing the width or height of the Dropdown.

### Requirement 11: Dropdown and Disclosure Animation

**User Story:** As a user, I want dropdown lists and expandable sections to open and close with a short animation, so that the interface feels polished without slowing me down.

#### Acceptance Criteria

1. WHILE Custom_Picker_Mode applies and Reduced_Motion does not apply, WHEN a Dropdown_Picker that has no running Open_Close_Animation opens, THE Control_System SHALL fade the Dropdown_Picker from an opacity of 0 to 1, move the Dropdown_Picker vertically into its open position from a start position that is 4 to 8 CSS pixels closer to the Dropdown, and turn the Dropdown_Indicator to point upward, each starting when the Dropdown_Picker opens and lasting from 120 to 200 milliseconds.
2. WHILE Custom_Picker_Mode applies and Reduced_Motion does not apply, WHEN a Dropdown_Picker that has no running Open_Close_Animation closes and its Dropdown stays in the page, THE Control_System SHALL fade the Dropdown_Picker from an opacity of 1 to 0 and turn the Dropdown_Indicator to point downward, each starting when the Dropdown_Picker closes and lasting from 80 to 150 milliseconds.
3. WHILE the App runs in Chrome and Reduced_Motion does not apply, WHEN a Disclosure that has no running Open_Close_Animation opens, THE Control_System SHALL grow the height that the Disclosure_Content takes up on the page from 0 CSS pixels to its full height, showing only the part of the Disclosure_Content that fits in that height, and SHALL turn the Disclosure_Indicator to the orientation that it keeps while the Disclosure is open, each starting when the Disclosure opens and lasting from 150 to 250 milliseconds.
4. WHILE the App runs in Chrome and Reduced_Motion does not apply, WHEN a Disclosure that has no running Open_Close_Animation closes, THE Control_System SHALL shrink the height that the Disclosure_Content takes up on the page from its full height to 0 CSS pixels, showing only the part of the Disclosure_Content that fits in that height, and SHALL turn the Disclosure_Indicator to the orientation that it keeps while the Disclosure is closed, each starting when the Disclosure closes and lasting from 150 to 250 milliseconds.
5. WHILE Reduced_Motion applies, WHEN a Dropdown_Picker or a Disclosure opens or closes, THE Control_System SHALL show the Dropdown_Picker or the Disclosure_Content with the opacity, position, and height of the new state, and the Dropdown_Indicator or the Disclosure_Indicator in the orientation of the new state, in the first frame that the browser renders after the change, also when Reduced_Motion began to apply after the page loaded.
6. WHILE an Open_Close_Animation of a Dropdown_Picker runs, THE Control_System SHALL handle pointer and keyboard input with the same results, and show the same Dropdown value and keyboard focus, as after that Open_Close_Animation ends, so that a pointer press on a closing Dropdown_Picker reaches the element under the Dropdown_Picker.
7. WHILE no Open_Close_Animation of a Disclosure runs, THE Control_System SHALL show all of the Disclosure_Content while the Disclosure is open, also after the Disclosure_Content changes height, none of the Disclosure_Content while the Disclosure is closed, and the Disclosure_Indicator in the orientation of the current state, in every browser, including a browser in which the Control_System runs no Open_Close_Animation.
8. WHILE an Open_Close_Animation of a Disclosure runs, THE Control_System SHALL handle pointer and keyboard input with the same results, and give the Disclosure the same open state, as after that Open_Close_Animation ends, so that the `open` attribute is present on an opening Disclosure and absent from a closing Disclosure, and the Controls in the Disclosure_Content of a closing Disclosure are not reachable with the Tab key and do not respond to pointer presses.
9. IF a Dropdown_Picker or a Disclosure opens or closes while an Open_Close_Animation of it runs, THEN THE Control_System SHALL animate the Dropdown_Picker or the Disclosure from its current opacity, position, height, and Dropdown_Indicator or Disclosure_Indicator orientation to those of the new state, ending no later than the longest duration that criteria 11.1 to 11.4 allow for that opening or closing, counted from the change.
10. WHEN the App inserts a Disclosure that is already open into the page, including when a re-render replaces the Disclosure, THE Control_System SHALL show all of the Disclosure_Content, and the Disclosure_Indicator in the orientation that it keeps while the Disclosure is open, in the first frame that the browser renders, without an Open_Close_Animation.

### Requirement 12: Unified Disclosures

**User Story:** As a user, I want every expandable section to look and work the same, so that I recognize one at a glance.

#### Acceptance Criteria

1. WHILE two Disclosures are both open or both closed and their summaries share an Interaction_State, a Theme, and a viewport width, THE Control_System SHALL render the two summaries with identical Style_Signatures, whichever UI_Module, Audited_View, or container renders each Disclosure.
2. THE Control_System SHALL render the Disclosure_Indicator as the only Icon in every Disclosure summary, immediately before the summary text and with the same Icon name and size in every summary, and SHALL render no default disclosure marker of the browser in any Disclosure summary.
3. THE App SHALL keep every Disclosure as a `details` element whose first child is a `summary` element, and SHALL keep the text of each summary unchanged as the only visible text of that summary: 匯出與重新載入, 畫面偏好, 料理筆記, 常用食材，點一下加進來, and AI 辨識結果.
4. WHEN the user activates a Disclosure summary with a click or tap anywhere inside the summary, including on the Disclosure_Indicator but excluding a click that the Swipe_Contract suppresses, or with the Enter key or the Space key while the summary has keyboard focus, THE Control_System SHALL toggle the `open` attribute of that Disclosure's `details` element, SHALL keep keyboard focus on that summary after an Enter or Space activation, and SHALL leave every other Disclosure open or closed as it was.
5. WHILE a Disclosure is closed and no Open_Close_Animation runs on it, THE Control_System SHALL render its Disclosure_Indicator pointing right, which is the closed orientation of Requirement 11, SHALL show none of the Disclosure_Content, and SHALL keep every Control in the Disclosure_Content unreachable with the Tab key and absent from the accessibility tree.
6. WHILE a Disclosure is open and no Open_Close_Animation runs on it, THE Control_System SHALL render its Disclosure_Indicator pointing down, which is the open orientation of Requirement 11, and SHALL show the Disclosure_Content below the summary with no part of it clipped.
7. WHEN the App renders a Disclosure, THE App SHALL render it open only if it is the AI 辨識結果 Disclosure and the 候選品項 list of the receipt review shows the empty message 目前沒有候選品項, SHALL render it closed in every other case, and SHALL run no Open_Close_Animation for that render.
8. THE Control_System SHALL render the `details` element of every Disclosure with no border on any side, so that no box surrounds the summary and the Disclosure_Content together.

### Requirement 13: Tabs and Segmented Controls

**User Story:** As a user, I want tabs and filters to mark the selected item the same way everywhere, so that I always know where I am and which filter is on.

#### Acceptance Criteria

1. WHILE two Segments share an Interaction_State, a Theme, and a viewport width, THE Control_System SHALL render the two Segments with identical Style_Signatures, whether each Segment belongs to the Mode_Switch or to a Segmented_Filter.
2. THE Control_System SHALL mark every Selected_Item, whether it is at rest, hovered, pressed, focused, or disabled, at every Audit_Width and in both Themes, with a Selected_Indicator that no unselected item of its Selection_Group shows in any Interaction_State and that consists of at least one of the following: the Selected_Icon; a bar at least 3 CSS pixels thick that runs parallel to one edge of the Selected_Item for at least half the length of that edge; or a border at least 1 CSS pixel wider on one side than the border on that side of the same item while it is not selected.
3. WHILE two Selected_Items that are each a Segment, a Chip, or a Choice_Card share a Theme and a viewport width, THE Control_System SHALL render the two Selected_Items with the same background color, the same border width, border style, and border color, and the same Selected_Indicator in form, position, color, and thickness or Icon size, whether or not either Selected_Item is disabled.
4. THE Control_System SHALL render every Tab and every Segment with the same number of leading Icons and the same number of trailing Icons as every other item of its Selection_Group at each Audit_Width, not counting the Selected_Icon.
5. WHILE two Tabs share a Theme and a viewport width, THE Control_System SHALL give the two Tabs, in each of the hover, pressed, focus-visible, and selected Interaction_States, the same value of every Style_Signature property that either Tab changes from its rest Interaction_State, other than the background color and text color of a Date_Button, and, in the selected Interaction_State, the same Selected_Indicator in form, position, color, and thickness or Icon size.
6. WHILE Forced_Colors does not apply, THE Control_System SHALL fill the Date_Button of the nth day of the trip, at rest and whether or not it is a Selected_Item, with the coral color of the current Theme when n divided by 3 leaves a remainder of 1, with the blue color when the remainder is 2, and with the green color when the remainder is 0.
7. THE Control_System SHALL keep, on every retained Tab, Segment, Chip, and Choice_Card, the role, every `data-*` attribute and value (including `data-tab`, `data-day`, `data-shop-filter`, and `data-gear-filter`), every `name` and `value` attribute and value, and the presence and value of `aria-current` and `aria-pressed` that the item has before this feature for the same route, stored data, and selection.
8. WHILE Forced_Colors does not apply, THE Control_System SHALL draw the Selected_Indicator of every Selected_Item at a Contrast_Ratio of at least 3:1 against each background color next to the Selected_Indicator, in both Themes.
9. WHILE Forced_Colors applies, THE Control_System SHALL draw the Selected_Indicator of every Selected_Item in a color that differs from each background color next to the Selected_Indicator.

### Requirement 14: Card Actions Without Duplicates

**User Story:** As a user, I want every icon and button on a card to do one distinct job for that card, so that cards are quick to scan and I never have to guess between two buttons.

#### Acceptance Criteria

1. THE Control_System SHALL render no Duplicate_Card_Action on any Card.
2. THE Control_System SHALL render on each Card only Card_Actions whose activation opens or closes a form, dialog, Confirmation_Step, Disclosure, or text input for the item that the Card shows, opens the route, page, or map location of that item, or changes stored data of that item.
3. WHILE a Card shows both an Edit_Card_Action and a Delete_Card_Action, THE Control_System SHALL place the Edit_Card_Action before the Delete_Card_Action both in document order and in reading order, where reading order runs left to right along a line and then down to the next line.
4. THE Control_System SHALL show the Edit_Icon as the only Icon of every Edit_Card_Action and the Delete_Icon as the only Icon of every Delete_Card_Action, where the Delete_Icon is a trash Icon whose Icon name and SVG geometry differ from those of the Close_Icon, so that every Swipe_Action cloned from these Card_Actions shows the same Icon.
5. THE Control_System SHALL render every Edit_Card_Action and every Delete_Card_Action of every List_Card, including the text-only 編輯旅伴 Text_Link of the Member_Card and the text-only 移除 Button of the Settlement_Row, as an Icon_Button that keeps the accessible name that the Card_Action had before this feature, with the non-destructive Style_Signature on each Edit_Card_Action and the destructive Style_Signature on each Delete_Card_Action.
6. THE Control_System SHALL render the Edit_Card_Action of every Summary_Card as a Compact Secondary Button and the Delete_Card_Action of every Summary_Card as a Compact Danger Button, each showing its Icon as the leading Icon followed by a text label at every Audit_Width at which the Card_Action is not Hidden.
7. THE Control_System SHALL render the Icon that marks the activity type of every Activity_Card with an Icon name and SVG geometry that no other Icon on that Activity_Card uses, for every combination of activity type (集合, 採買補給, 營地時光, 一起吃飯, 星空時間, or 在路上) and 這一站誰參加 option (全體旅伴, 指定車輛（可複選）, or 保留原旅伴名單).
8. THE Control_System SHALL render, in the Local_Planner and in Account_Mode, exactly one 查看採買清單 Text_Link in the view of the 料理菜單 Section_Tab, as a `button` element with the accessible name 查看採買清單, placed in the heading of the 一起煮，一起吃 section outside every Meal_Card, that selects the 採買清單 Section_Tab when activated and is not Hidden at any Audit_Width for any user, whether the section shows any Meal_Card or none.
9. THE Control_System SHALL render on every Account_Trip_Card exactly one Control that opens the trip page of that trip, which is the 開啟旅行手冊 Button, and SHALL show the trip title as a heading that is not a link.

### Requirement 15: Removal of Unnecessary Tabs and Icons

**User Story:** As a user, I want tabs and icons that do nothing for me removed, so that each screen shows only what I need.

#### Acceptance Criteria

1. THE Control_System SHALL render every Section_Tab, in the Local_Planner and in Account_Mode, with the label and, on the 裝備分工 Section_Tab, the count badge that the Section_Tab shows before this feature, and with no element or text for the `01` to `07` ordinal number, which is Hidden at every Audit_Width before this feature.
2. THE Control_System SHALL render every Gear_Row with the item name, the quantity, the 每人一份 tag or the Person_Dropdown, and the edit and delete Card_Actions that the Gear_Row shows before this feature, and with no element for the item type Icon before the item name (`bag` on personal items and `tent` on shared items), which is Hidden at every Audit_Width before this feature.
3. THE App SHALL remove from the page, rather than hide, every Control, Icon, and other element that the Candidate column of the Removal candidates table and the chosen option name for removal for each Approved_Removal, on every Audited_View where those elements render before this feature, at every Audit_Width and in both Themes, except that RC1 leaves Account_Mode unchanged.
4. THE App SHALL keep every Removal_Candidate that is not an Approved_Removal, which is RC7, on the same Audited_Views and not Hidden at the same Audit_Widths as before this feature.
5. THE App SHALL keep, for every Control that an Approved_Removal removes, at least one other Control of the same Local_Planner or Account_Mode that has the same Control_Action before this feature, or the same Card_Action_Target for a Card_Action, where such a Control exists and no Approved_Removal removes it, not Hidden at any Audit_Width for every user who could see the removed Control.
6. THE App SHALL keep on the account home exactly one JSON import Control (從 JSON 備份檔匯入) and exactly one file input of that Control, with the import behavior that they have before this feature, Hidden at every Audit_Width in both Themes and unreachable with the Tab key.
7. THE App SHALL keep in the page every Control, Card, section, heading, and text of each Audited_View that an Approved_Removal changes, other than the elements that the Removal candidates table names for removal and the changes that other criteria of this document require, including the title text of every Account_Trip_Card and the 規劃中的旅行 and 已完成的回憶 sections of the account home with their counts and Account_Trip_Cards.
8. THE App SHALL show the text 僅可檢視卡片 directly after the status tag on the cover of every Account_Trip_Card whose trip the signed-in account cannot edit, fully visible at every Audit_Width, and on no other Account_Trip_Card.
9. THE App SHALL render in the Local_Planner at least one Control with the visible label 前往登入 that navigates to `/login` when activated, on at least one Audited_View of the Local_Planner and not Hidden at any Audit_Width.

### Requirement 16: Color Contrast and Themes

**User Story:** As a user who reads outdoors or uses the dark theme, I want every control to stay legible, so that I can read labels and icons in both themes.

#### Acceptance Criteria

1. THE Control_System SHALL render the visible text of every enabled Control, other than text inside an Illustration, with a Contrast_Ratio of at least 4.5:1 against the Effective_Background of that text, in the rest, hover, pressed, focus-visible, and selected Interaction_States, on every Audited_View at every Audit_Width, and in both Themes, including the labels of the Swipe_Actions in an open Action_Panel, the counts inside Tabs and Segments, and the options of every open Dropdown_Picker.
2. THE Control_System SHALL render each of the following with a Contrast_Ratio of at least 3:1 against its Effective_Background on every Audited_View at every Audit_Width in both Themes: every Icon that is not Hidden inside an enabled Control in the rest, hover, pressed, focus-visible, and selected Interaction_States, including the Icons of the Swipe_Actions in an open Action_Panel; every Dropdown_Indicator of an enabled Dropdown; every Selected_Indicator drawn as a line, a border, or a mark; and every Informative_Icon outside Controls.
3. WHEN the Theme changes, whether through the Theme_Switch or through a direct change of `html[data-theme]`, THE Control_System SHALL, within 300 milliseconds and without reloading the page, render every Control that is not Hidden on the current Audited_View with the Style_Signature that the same Control has in the same Interaction_State when that Audited_View is loaded in the new Theme.
4. WHILE Forced_Colors applies, THE Control_System SHALL render every Button and every Icon_Button with a border at least 1 CSS pixel wide on all four sides, in a border style other than none or hidden, and in a border color that differs from the background color of that Control.
5. WHILE a Control shows a companion's representative color or a per-day color, THE Control_System SHALL render the background of the Person_Dropdown, the Date_Button, or the Avatar that shows that color in exactly the value that the current Theme gave that color before this feature, in the rest and selected Interaction_States, and SHALL meet criteria 16.1 and 16.2 on that background for every color that the App can assign to a companion or a day, in both Themes.
6. WHILE the dark Theme applies, THE Control_System SHALL render every Button, including the scene-motion toggle, with the same background color, text color, border color, and box shadow in each Interaction_State as every other Button that shares its Button_Variant and Button_Size.

### Requirement 17: Compatibility with Mobile Smooth Swipe

**User Story:** As a phone user, I want swipe-to-edit and swipe-to-delete to keep working exactly as they do now, so that the restyle does not change the gesture.

#### Acceptance Criteria

1. THE App SHALL meet every acceptance criterion of mobile-smooth-swipe Requirements 1 to 6 on every Swipe_Row of every Audited_View, in both Themes, at every Audit_Width.
2. THE Control_System SHALL render every Swipe_Toggle with `‹` as its only text and no Icon, and with `顯示編輯與刪除操作` as its accessible name.
3. THE Control_System SHALL keep the `data-swipe-row` attribute on every List_Card other than a Transfer_Row and on every Summary_Card, except on an Expense_Row or Settlement_Row while it shows its removal confirmation, and SHALL keep inside each of those Cards every retained Card_Action that the action allowlist of the Swipe_Controller matches, with the `data-action` or `data-xp` value that the Card_Action has before this feature.
4. THE Control_System SHALL give every Edit_Card_Action that the Swipe_Controller clones an accessible name that contains 編輯, and every Delete_Card_Action that the Swipe_Controller clones an accessible name that contains 移除 or 刪除.
5. WHILE the viewport is at most 760 CSS pixels wide, THE Control_System SHALL render every Swipe_Action with a border box 68 CSS pixels wide, at the same position and size within its Action_Panel in every Interaction_State.
6. WHEN a Swipe_Action receives keyboard focus, THE Control_System SHALL draw the Focus_Ring with the outline width, outline style, and color shared by every Control in the current Theme, at an outline offset of −3 CSS pixels, and SHALL draw a line 2 CSS pixels wide in the page background color of the current Theme along the inner edge of the Focus_Ring, with a Contrast_Ratio of at least 3:1 between the Focus_Ring and that line in both Themes.
7. THE Control_System SHALL render every delete Swipe_Action with the Destructive_Color of the current Theme as its background color and every edit Swipe_Action with a background color other than the Destructive_Color, and SHALL render the label of every Swipe_Action at a Contrast_Ratio of at least 4.5:1 and its Icon at a Contrast_Ratio of at least 3:1 against that background color, in both Themes.
8. THE Schedule_Bar SHALL meet every acceptance criterion of mobile-smooth-swipe Requirement 7 for every trip length from 1 to 31 days, in both Themes, at every Audit_Width and every other viewport width from 320 to 1440 CSS pixels, with the styles that this feature gives the Add_Stop_Button and the Date_Tabs.
9. THE Control_System SHALL render every Swipe_Action with exactly one Icon above one label and no other content: the Edit_Icon above 編輯 on every edit Swipe_Action and the Delete_Icon above 刪除 on every delete Swipe_Action, on every Card type including Member_Cards, Settlement_Rows, Account_Trip_Cards, and Admin_User_Rows, and whatever words the name of the item contains.
10. WHILE two Swipe_Actions are both edit Swipe_Actions or both delete Swipe_Actions and share an Interaction_State, a Theme, and a viewport width, THE Control_System SHALL render the two Swipe_Actions with identical Style_Signatures, whichever Card, UI_Module, or Control_Family the Card_Action that each was cloned from belongs to.

### Requirement 18: Compatibility with Existing Behavior and Tests

**User Story:** As the developer who maintains this app, I want existing behavior and tests to keep working, so that the visual cleanup does not break features.

#### Acceptance Criteria

1. THE App SHALL pass every test that passes in the Baseline_Result for a Test_Environment and is not a Changed_Test, in each of two Test_Runs on the same files in that Test_Environment, with the test's own code and the hooks and helpers it runs unchanged from the Baseline_App, apart from the hook and helper edits that the Control_Inventory lists under criterion 18.9.
2. THE Test_Suite SHALL contain, in place of every Changed_Test, an updated test that keeps unchanged every step that the Control_Inventory does not list for that Changed_Test, that carries a title describing the approved behavior where the Control_Inventory lists the title as changed, that checks, in place of each listed step, the outcome that the Approved_Removal, the approved option of the Open_Decision, or the criterion cited for that step requires, and that passes in each of the two Test_Runs of criterion 18.1.
3. WHILE Forced_Colors does not apply, THE Control_System SHALL render every closed Person_Dropdown that is not Hidden 156 CSS pixels wide and 44 CSS pixels tall with a 1 CSS pixel border on each side, and every other closed Dropdown that is not Hidden 44 CSS pixels tall, measured as the outer size including the border after every transition on the Dropdown has finished, in the rest, hover, focus-visible, and disabled Interaction_States, in both Themes, and at every Audit_Width.
4. THE Control_System SHALL give every Control on every Audited_View in both Themes, and every option and option group label that a Dropdown_Picker lists, a computed font family whose first family is `jf open 粉圓`, with the `jf open 粉圓` font face loaded.
5. THE App SHALL keep the scroll width of the document, and of every open dialog, at most 1 CSS pixel greater than its visible width excluding any scrollbar, on every Audited_View at every Audit_Width in both Themes, with every Disclosure closed and with every Disclosure open, measured after every running animation has finished.
6. WHILE the browser prints a page of the App, THE App SHALL show every Retained_Control, every Card, and all text outside Controls that the Baseline_App shows in print on the same Audited_View at the same Audit_Width and in the same Theme, with every Disclosure closed and with every Disclosure open, except text that an Approved_Removal or a criterion of Requirements 1 to 17 removes, and SHALL hide every other Control.
7. THE App SHALL keep, on every Retained_Control, the element type, the role, and every `id`, `name`, `type`, `href`, `title`, `data-*`, and `aria-*` attribute value that the Control has in the Baseline_App, and, on every Dropdown, the value, text, and `data-*` attributes of every option, apart from the accessible-name changes that criterion 7.2 allows and the `data-swipe-label` values that criterion 17.9 sets.
8. THE App SHALL write the visible text, the accessible name, and the tooltip of every Control that this feature adds or relabels, and every notice and confirmation text that this feature adds or changes, in Traditional Chinese characters with no Simplified Chinese character forms, using Latin letters only in names and abbreviations that the Baseline_App already shows, such as JSON, AI, and Google Maps.
9. THE Control_Inventory SHALL record every Baseline_Result with its Test_Environment, and SHALL list every Changed_Test with each step or title that changes, the ID of the Approved_Removal or Open_Decision or the number of the criterion that changes that step or title, and each edit to a test hook or helper that the updated test needs.
10. WHEN a Retained_Control is activated by pointer or keyboard, THE App SHALL produce the same change to stored data, navigation, download, and notification, open or close the same dialog or panel, and leave keyboard focus on the same element as the Baseline_App does for the same activation with the same stored data, the same save state (saved, saving, or not saved), and, in Account_Mode, the same Access_Case, including any browser confirmation prompt or Confirmation_Step that the Baseline_App shows first, with the same choices and the same outcome for each choice, whatever look, label, Icons, or Control_Family the other criteria of this document give that Control and the dialogs and panels that it opens.
11. THE App SHALL show, hide, enable, and disable every Retained_Control on every Audited_View at every Audit_Width as the Baseline_App does with the same stored data, the same save state, and, in Account_Mode, the same Access_Case.
