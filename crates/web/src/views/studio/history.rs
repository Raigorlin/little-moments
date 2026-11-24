//! 工作室的「復原」與「重做」（Bun `remember()` 與 `travelHistory()`，rust-schedule-studio Decision D2）。
//!
//! 每一次成功送出的編輯記為一個 [`Edit`]：送出的命令與送出之前計算的反向命令（[`super::inverse`]）。「復原」送出最上面
//! 一筆的反向命令，「重做」再送出它的命令。最多記 60 筆；同一個欄位在 900 毫秒內連續的編輯合併成一筆（保留較早的反向
//! 命令、採用較新的命令）；任何新的編輯清空「重做」。記錄屬於這一次開啟的工作室，離開 Schedule_Tab 時捨棄。
use leptos::prelude::*;
use lm_core::command::Command;

/// 最多記住的編輯數。
pub(super) const HISTORY_MAX: usize = 60;
/// 同一個欄位在這段時間（毫秒）之內的編輯合併成一筆。
pub(super) const COALESCE_MS: f64 = 900.0;

/// 一次編輯。
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Edit {
    /// 合併連續編輯用的欄位 id；`None` 是不合併（新增、刪除等按鈕）。
    pub key: Option<String>,
    /// 依送出順序的命令（「重做」送出這些）。
    pub forward: Vec<Command>,
    /// 依送出順序的反向命令（「復原」送出這些）：最後一個命令的反向在最前面。
    pub inverse: Vec<Command>,
    /// 編輯時選定的第 N 天（0 起）；復原與重做之後回到這一天。
    pub day: usize,
}

/// 「復原」與「重做」的兩疊記錄。
#[derive(Clone, Debug, Default)]
pub(super) struct Stacks {
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    /// 最近一次記錄的欄位 id 與時間（毫秒）
    last: Option<(String, f64)>,
}

impl Stacks {
    /// Bun `remember()`：記下 `edit`，清空「重做」。與上一筆是同一個欄位、而且在 [`COALESCE_MS`] 之內時合併。
    pub(super) fn record(&mut self, edit: Edit, now: f64) {
        let coalesce = match (&edit.key, &self.last) {
            (Some(key), Some((last, at))) => key == last && now - at <= COALESCE_MS,
            _ => false,
        };
        self.last = edit.key.clone().map(|key| (key, now));
        self.redo.clear();
        match self.undo.last_mut() {
            Some(top) if coalesce => {
                top.forward = edit.forward;
                top.day = edit.day;
            }
            _ => {
                self.undo.push(edit);
                if self.undo.len() > HISTORY_MAX {
                    self.undo.remove(0);
                }
            }
        }
    }

    /// 下一次的編輯不與之前的合併（切換日子或分頁、復原或重做之後）。
    pub(super) fn break_coalescing(&mut self) {
        self.last = None;
    }

    /// 「復原」（`backwards`）或「重做」最上面的一筆。
    pub(super) fn top(&self, backwards: bool) -> Option<&Edit> {
        if backwards {
            self.undo.last()
        } else {
            self.redo.last()
        }
    }

    /// 復原或重做成功：最上面的一筆移到另一疊。
    pub(super) fn travel(&mut self, backwards: bool) {
        let (from, to) = if backwards {
            (&mut self.undo, &mut self.redo)
        } else {
            (&mut self.redo, &mut self.undo)
        };
        if let Some(edit) = from.pop() {
            to.push(edit);
        }
        self.last = None;
    }

    /// 兩疊的筆數（復原、重做）。
    pub(super) fn sizes(&self) -> (usize, usize) {
        (self.undo.len(), self.redo.len())
    }
}

/// 工作室的編輯記錄（`Copy`）。按鈕的停用狀態讀取 [`History::sizes`]。
#[derive(Clone, Copy)]
pub(super) struct History {
    stacks: StoredValue<Stacks>,
    sizes: RwSignal<(usize, usize)>,
}

/// 現在的時間（毫秒）。
fn now() -> f64 {
    js_sys::Date::now()
}

impl History {
    pub(super) fn new() -> History {
        History {
            stacks: StoredValue::new(Stacks::default()),
            sizes: RwSignal::new((0, 0)),
        }
    }

    fn sync(&self) {
        if let Some(sizes) = self.stacks.try_with_value(Stacks::sizes) {
            self.sizes.try_set(sizes);
        }
    }

    pub(super) fn record(&self, edit: Edit) {
        let at = now();
        self.stacks.update_value(|stacks| stacks.record(edit, at));
        self.sync();
    }

    pub(super) fn break_coalescing(&self) {
        self.stacks.update_value(Stacks::break_coalescing);
    }

    pub(super) fn top(&self, backwards: bool) -> Option<Edit> {
        self.stacks
            .try_with_value(|stacks| stacks.top(backwards).cloned())
            .flatten()
    }

    pub(super) fn travel(&self, backwards: bool) {
        self.stacks.update_value(|stacks| stacks.travel(backwards));
        self.sync();
    }

    /// 可以復原的筆數與可以重做的筆數。
    pub(super) fn sizes(&self) -> (usize, usize) {
        self.sizes.get()
    }
}

#[cfg(test)]
mod tests {
    use lm_core::command::TripPatch;

    use super::*;

    fn edit(key: Option<&str>, caption: &str, old: &str) -> Edit {
        let patch = |text: &str| Command::UpdateTrip {
            patch: TripPatch {
                caption: Some(text.to_owned()),
                ..TripPatch::default()
            },
        };
        Edit {
            key: key.map(str::to_owned),
            forward: vec![patch(caption)],
            inverse: vec![patch(old)],
            day: 0,
        }
    }

    #[test]
    fn edits_of_the_same_field_within_900_ms_coalesce() {
        let mut stacks = Stacks::default();
        stacks.record(edit(Some("caption"), "a", ""), 0.0);
        stacks.record(edit(Some("caption"), "ab", "a"), 500.0);
        assert_eq!(stacks.sizes(), (1, 0));
        // 保留較早的反向命令、採用較新的命令
        assert_eq!(stacks.top(true), Some(&edit(Some("caption"), "ab", "")));
        // 超過 900 毫秒、另一個欄位或沒有欄位 id 時不合併
        stacks.record(edit(Some("caption"), "abc", "ab"), 1_500.0);
        stacks.record(edit(Some("headline"), "x", ""), 1_600.0);
        stacks.record(edit(None, "y", ""), 1_700.0);
        stacks.record(edit(None, "z", ""), 1_800.0);
        assert_eq!(stacks.sizes(), (5, 0));
        stacks.break_coalescing();
        stacks.record(edit(Some("caption"), "q", ""), 1_900.0);
        stacks.record(edit(Some("caption"), "qq", ""), 2_000.0);
        assert_eq!(stacks.sizes(), (6, 0));
    }

    #[test]
    fn undo_moves_the_top_edit_to_redo_and_new_edits_clear_redo() {
        let mut stacks = Stacks::default();
        stacks.record(edit(None, "a", ""), 0.0);
        stacks.record(edit(None, "b", "a"), 10.0);
        stacks.travel(true);
        assert_eq!(stacks.sizes(), (1, 1));
        assert_eq!(stacks.top(false), Some(&edit(None, "b", "a")));
        stacks.travel(false);
        assert_eq!(stacks.sizes(), (2, 0));
        stacks.travel(true);
        stacks.record(edit(None, "c", "a"), 20.0);
        assert_eq!(stacks.sizes(), (2, 0));
        // 空的一疊不動
        stacks.travel(false);
        assert_eq!(stacks.sizes(), (2, 0));
    }

    #[test]
    fn history_keeps_the_latest_60_edits() {
        let mut stacks = Stacks::default();
        for i in 0..65 {
            stacks.record(edit(None, &i.to_string(), ""), f64::from(i));
        }
        assert_eq!(stacks.sizes(), (HISTORY_MAX, 0));
        assert_eq!(stacks.undo[0], edit(None, "5", ""));
    }
}
