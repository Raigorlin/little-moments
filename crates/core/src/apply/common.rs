//! 處理函式共用的規則（design 1.5「所有命令共同的規則」）：新列的 id 與暫時的 Ordinal、日期範圍、時刻的輸入，以及
//! 文字的長度與 U+0000。

use std::collections::BTreeMap;
use std::ops::RangeInclusive;

use crate::command::{
    optional_time, Input, Rejection, DUPLICATE_ID, DUPLICATE_ID_MESSAGE, UNSTORABLE_TEXT,
};
use crate::model::{Date, TripState};
use crate::text::char_count;
use crate::time::Hm;

/// 新列的暫時 Ordinal：目前最大的 Ordinal 加 1，所以同一個命令中依建立的順序遞增（需求 7.18）。
pub(super) fn next_ordinal(d: &TripState) -> u64 {
    d.max_ordinal() + 1
}

/// 新列的 id 已被同一種列使用（包括同一個命令中先新增的列）時 409 `duplicate_id`，不覆寫既有的列（需求 7.22）。
pub(super) fn ensure_new<K: Ord, V>(rows: &BTreeMap<K, V>, id: &K) -> Result<(), Rejection> {
    if rows.contains_key(id) {
        Err(Rejection::conflict(DUPLICATE_ID, DUPLICATE_ID_MESSAGE))
    } else {
        Ok(())
    }
}

/// `day` 在旅行範圍內（含頭尾）。
pub(super) fn in_trip(d: &TripState, day: Date) -> bool {
    d.card.start <= day && day <= d.card.end
}

/// `text` 的 Char_Count 在 `range` 之內。
pub(super) fn fits(text: &str, range: RangeInclusive<usize>) -> bool {
    range.contains(&char_count(text))
}

/// 含有 U+0000 的文字以 400「文字含有無法儲存的字元。」拒絕（需求 8.12）。
pub(super) fn storable(field: &str, text: &str) -> Result<(), Rejection> {
    if text.contains('\0') {
        Err(Rejection::invalid(field, UNSTORABLE_TEXT))
    } else {
        Ok(())
    }
}

/// 必填時刻的輸入。
pub(super) enum RequiredTime {
    Blank,
    Invalid,
}

/// 必填時刻：沒有這個欄位、`null` 或空字串是 `Blank`，不是 Time_Value 是 `Invalid`。
pub(super) fn required_time(input: Option<&Input<Hm>>) -> Result<Hm, RequiredTime> {
    match optional_time(input) {
        Ok(Some(hm)) => Ok(hm),
        Ok(None) => Err(RequiredTime::Blank),
        Err(_) => Err(RequiredTime::Invalid),
    }
}
