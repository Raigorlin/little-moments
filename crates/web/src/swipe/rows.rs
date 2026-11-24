//! 在 DOM 裡準備、更新與還原可滑動的列（design 4.2）。
//!
//! Every write is guarded by a read of the current value: `DOMTokenList.add`
//! and `setAttribute` queue a mutation record even when the value does not
//! change, and the controller's `MutationObserver` calls `reconcile` once per
//! batch, so an unguarded write would loop forever.

use wasm_bindgen::JsCast;
use web_sys::{Element, HtmlElement};

use super::physics::{is_danger, swipe_label, ActionRole};

/// A Schedule_Row.
pub const ROW: &str = "[data-swipe-row]";
/// A Row_Action inside a Schedule_Row.
pub const ROW_ACTION: &str = "[data-row-action]";
/// A pointer going down inside one of these does not start a gesture (Requirement 5.1).
pub const INTERACTIVE: &str = "button,a,input,select,textarea,summary";

const PANEL_CLASS: &str = "swipe-actions";
const TOGGLE_CLASS: &str = "swipe-toggle";
const COPY_CLASS: &str = "swipe-action";
const DANGER_CLASS: &str = "swipe-action-danger";
const PANEL_LABEL: &str = "滑動操作";
const TOGGLE_LABEL: &str = "顯示編輯與刪除操作";
const TOGGLE_TEXT: &str = "‹";

/// What a `.swipe-action` copy of one Row_Action must look like.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionSpec {
    /// The original's `aria-label`, or its trimmed text when it has none.
    pub label: String,
    pub role: ActionRole,
    /// Whether the copy gets `swipe-action-danger` (Requirement 4.4).
    pub danger: bool,
    pub disabled: bool,
}

impl ActionSpec {
    pub fn new(action: &str, label: String, has_danger_class: bool, disabled: bool) -> ActionSpec {
        let role = action_role(action);
        let danger = is_danger(has_danger_class, swipe_label(role, &label));
        ActionSpec {
            label,
            role,
            danger,
            disabled,
        }
    }

    /// `data-swipe-label` (Requirement 4.3).
    pub fn swipe_label(&self) -> &'static str {
        swipe_label(self.role, &self.label)
    }

    /// The copy's `aria-label`: the original's label, or the swipe label when
    /// the original has none, as in Bun's `label || swipeLabel`.
    pub fn aria_label(&self) -> &str {
        if self.label.is_empty() {
            self.swipe_label()
        } else {
            &self.label
        }
    }
}

/// Maps a `data-row-action` value to its role.
pub fn action_role(action: &str) -> ActionRole {
    match action {
        "edit" => ActionRole::Edit,
        "delete" => ActionRole::Delete,
        _ => ActionRole::Other,
    }
}

/// Prepares, refreshes or un-prepares every row under `root` (and `root`
/// itself). Idempotent: a second pass writes nothing.
pub fn reconcile(root: &Element) {
    // Step 1: a row that lost `data-swipe-row` goes back to its plain markup.
    for row in matching(root, ".swipe-row:not([data-swipe-row])") {
        unprepare(&row);
    }
    for row in matching(root, ROW) {
        reconcile_row(&row);
    }
}

fn reconcile_row(row: &Element) {
    // Step 2: the originals, excluding copies inside this row's panels.
    let originals: Vec<Element> = query_all(row, ROW_ACTION)
        .into_iter()
        .filter(|action| !inside_panel(row, action))
        .collect();

    // Step 3.
    if originals.is_empty() {
        unprepare(row);
        return;
    }

    let specs: Vec<ActionSpec> = originals.iter().map(spec_of).collect();
    let open = row.class_list().contains("swipe-open");

    // Step 5 first, so step 4 has a panel to fill.
    let Some(panel) = ensure_single_child(row, PANEL_CLASS, "div") else {
        return;
    };
    set_attr(&panel, "role", "group");
    set_attr(&panel, "aria-label", PANEL_LABEL);
    set_attr(&panel, "aria-hidden", bool_str(!open));

    // Step 4: rebuild the copies only when they differ (Requirement 4.9).
    if !copies_match(&panel, &specs) {
        rebuild_copies(&panel, &originals, &specs);
    }

    if let Some(toggle) = ensure_single_child(row, TOGGLE_CLASS, "button") {
        set_attr(&toggle, "type", "button");
        set_attr(&toggle, "aria-label", TOGGLE_LABEL);
        set_attr(&toggle, "aria-expanded", bool_str(open));
        if toggle.text_content().as_deref() != Some(TOGGLE_TEXT) {
            toggle.set_text_content(Some(TOGGLE_TEXT));
        }
    }

    // Step 6 (Requirement 4.5).
    for original in &originals {
        set_attr(original, "data-swipe-original", "true");
    }
    set_style(row, "--swipe-count", &specs.len().to_string());
    add_class(row, "swipe-row");
    set_attr(row, "data-swipe-ready", "true");
}

/// Returns a row to its plain markup. The controller ends its own settle
/// bookkeeping; this removes the `swipe-settling` class it leaves behind.
pub fn unprepare(row: &Element) {
    for child in element_children(row) {
        let classes = child.class_list();
        if classes.contains(PANEL_CLASS) || classes.contains(TOGGLE_CLASS) {
            child.remove();
        }
    }
    for class in [
        "swipe-row",
        "swipe-open",
        "swipe-dragging",
        "swipe-settling",
    ] {
        remove_class(row, class);
    }
    remove_attr(row, "data-swipe-ready");
    remove_style(row, "--swipe-count");
    remove_style(row, "--swipe-x");
    for original in query_all(row, "[data-swipe-original]") {
        remove_attr(&original, "data-swipe-original");
    }
}

/// Opens or closes a row: `swipe-open`, the panel's `aria-hidden` and the
/// toggle's `aria-expanded` change together (Requirement 5.10).
pub fn set_open(row: &Element, open: bool) {
    if open {
        add_class(row, "swipe-open");
    } else {
        remove_class(row, "swipe-open");
    }
    for child in element_children(row) {
        let classes = child.class_list();
        if classes.contains(PANEL_CLASS) {
            set_attr(&child, "aria-hidden", bool_str(!open));
        } else if classes.contains(TOGGLE_CLASS) {
            set_attr(&child, "aria-expanded", bool_str(open));
        }
    }
}

/// Closes every prepared row under `root` except `except`. The rows are read
/// from the DOM on each call.
pub fn close_rows(root: &Element, except: Option<&Element>) {
    for row in matching(root, ".swipe-row") {
        if except != Some(&row) {
            set_open(&row, false);
        }
    }
}

fn spec_of(original: &Element) -> ActionSpec {
    let label = original
        .get_attribute("aria-label")
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| {
            original
                .text_content()
                .map(|text| text.trim().to_owned())
                .unwrap_or_default()
        });
    ActionSpec::new(
        &original
            .get_attribute("data-row-action")
            .unwrap_or_default(),
        label,
        original.class_list().contains("danger"),
        original.has_attribute("disabled"),
    )
}

fn copies_match(panel: &Element, specs: &[ActionSpec]) -> bool {
    let copies = element_children(panel);
    copies.len() == specs.len()
        && copies
            .iter()
            .zip(specs)
            .enumerate()
            .all(|(index, (copy, spec))| {
                copy.get_attribute("aria-label").as_deref() == Some(spec.aria_label())
                    && copy.get_attribute("data-swipe-label").as_deref() == Some(spec.swipe_label())
                    && copy.class_list().contains(DANGER_CLASS) == spec.danger
                    && copy.has_attribute("disabled") == spec.disabled
                    && copy.get_attribute("data-swipe-index") == Some(index.to_string())
            })
}

fn rebuild_copies(panel: &Element, originals: &[Element], specs: &[ActionSpec]) {
    panel.set_text_content(None);
    for (index, (original, spec)) in originals.iter().zip(specs).enumerate() {
        let Some(copy) = original
            .clone_node_with_deep(true)
            .ok()
            .and_then(|node| node.dyn_into::<Element>().ok())
        else {
            continue;
        };
        // Keep only the outermost `svg` descendants, as Bun's `replaceChildren(...icons)`.
        let icons: Vec<Element> = query_all(&copy, "svg")
            .into_iter()
            .filter(|svg| {
                svg.parent_element()
                    .and_then(|parent| parent.closest("svg").ok().flatten())
                    .is_none()
            })
            .collect();
        copy.set_text_content(None);
        for icon in &icons {
            let _ = copy.append_child(icon);
        }
        for name in ["id", "data-row-action", "data-swipe-original"] {
            remove_attr(&copy, name);
        }
        set_attr(&copy, "aria-label", spec.aria_label());
        set_attr(&copy, "data-swipe-label", spec.swipe_label());
        add_class(&copy, COPY_CLASS);
        if spec.danger {
            add_class(&copy, DANGER_CLASS);
        } else {
            remove_class(&copy, DANGER_CLASS);
        }
        if spec.disabled {
            set_attr(&copy, "disabled", "");
        } else {
            remove_attr(&copy, "disabled");
        }
        set_attr(&copy, "data-swipe-index", &index.to_string());
        let _ = panel.append_child(&copy);
    }
}

/// Keeps the first direct child of `row` with `class`, removes the rest, and
/// appends a new `tag` element when there is none (Requirement 4.8).
fn ensure_single_child(row: &Element, class: &str, tag: &str) -> Option<Element> {
    let mut found = None;
    for child in element_children(row) {
        if child.class_list().contains(class) {
            if found.is_none() {
                found = Some(child);
            } else {
                child.remove();
            }
        }
    }
    if found.is_some() {
        return found;
    }
    let element = row.owner_document()?.create_element(tag).ok()?;
    element.set_class_name(class);
    row.append_child(&element).ok()?;
    Some(element)
}

/// Whether `action` sits inside a `.swipe-actions` panel within `row`.
fn inside_panel(row: &Element, action: &Element) -> bool {
    action
        .closest(".swipe-actions")
        .ok()
        .flatten()
        .is_some_and(|panel| row.contains(Some(panel.as_ref())))
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

/// Direct element children, through `:scope > *` so no `HtmlCollection` feature is needed.
fn element_children(parent: &Element) -> Vec<Element> {
    query_all(parent, ":scope > *")
}

fn bool_str(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn set_attr(element: &Element, name: &str, value: &str) {
    if element.get_attribute(name).as_deref() != Some(value) {
        let _ = element.set_attribute(name, value);
    }
}

fn remove_attr(element: &Element, name: &str) {
    if element.has_attribute(name) {
        let _ = element.remove_attribute(name);
    }
}

fn add_class(element: &Element, class: &str) {
    let classes = element.class_list();
    if !classes.contains(class) {
        let _ = classes.add_1(class);
    }
}

fn remove_class(element: &Element, class: &str) {
    let classes = element.class_list();
    if classes.contains(class) {
        let _ = classes.remove_1(class);
    }
}

fn set_style(element: &Element, property: &str, value: &str) {
    let Some(element) = element.dyn_ref::<HtmlElement>() else {
        return;
    };
    let style = element.style();
    if style.get_property_value(property).ok().as_deref() != Some(value) {
        let _ = style.set_property(property, value);
    }
}

fn remove_style(element: &Element, property: &str) {
    let Some(element) = element.dyn_ref::<HtmlElement>() else {
        return;
    };
    let style = element.style();
    if style
        .get_property_value(property)
        .is_ok_and(|value| !value.is_empty())
    {
        let _ = style.remove_property(property);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_action_values_map_to_roles() {
        assert_eq!(action_role("edit"), ActionRole::Edit);
        assert_eq!(action_role("delete"), ActionRole::Delete);
        assert_eq!(action_role("toggle"), ActionRole::Other);
        assert_eq!(action_role(""), ActionRole::Other);
    }

    #[test]
    fn edit_copy_is_labelled_edit_and_not_danger() {
        let spec = ActionSpec::new("edit", "編輯路線".into(), false, false);
        assert_eq!(spec.swipe_label(), "編輯");
        assert_eq!(spec.aria_label(), "編輯路線");
        assert!(!spec.danger);
    }

    #[test]
    fn edit_role_wins_over_a_delete_word() {
        let spec = ActionSpec::new("edit", "編輯移除清單".into(), false, false);
        assert_eq!(spec.swipe_label(), "編輯");
        assert!(!spec.danger);
    }

    #[test]
    fn delete_labels_are_danger() {
        for label in ["移除地點", "刪除路線"] {
            let spec = ActionSpec::new("delete", label.into(), false, true);
            assert_eq!(spec.swipe_label(), "刪除");
            assert!(spec.danger);
            assert!(spec.disabled);
        }
    }

    #[test]
    fn danger_class_marks_other_actions() {
        let spec = ActionSpec::new("other", "完成".into(), true, false);
        assert_eq!(spec.swipe_label(), "操作");
        assert!(spec.danger);
    }

    #[test]
    fn empty_label_falls_back_to_swipe_label() {
        let spec = ActionSpec::new("other", String::new(), false, false);
        assert_eq!(spec.aria_label(), "操作");
    }
}
