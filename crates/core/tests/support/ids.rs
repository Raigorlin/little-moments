//! 產生器的 id 配置，以及依序產生採買品項 id 的決定性 `IdSource`（[`SeqIds`]）。
//!
//! 每個 id 都是 `TT000000-0000-4000-8000-NNNNNNNNNNNN` 形式的 UUID：`TT` 是 [`Tag`]（哪一種列），`NNNNNNNNNNNN` 是
//! 從 1 起的序號，所以失敗案例中的 id 一看就知道是哪一種列的第幾個。`arb_state()` 依建立的順序為每一種列編號，
//! Ordinal 另外打散（見 `state`）。
//!
//! `arb_state()` 只使用 [`Tag::Trip`] 到 [`Tag::Settlement`]；[`Tag::NewShopping`] 保留給 [`SeqIds`]，所以 `SeqIds`
//! 回傳的 id 不會與產生的狀態中任何一列重複。之後的產生器需要新列或不存在的 id 時，在 `Tag` 加上還沒使用的值。

use lm_core::ids::{IdSource, ShoppingId};
use uuid::Uuid;

/// id 的種類：UUID 的第一個位元組。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Tag {
    Trip = 0x01,
    Person = 0x02,
    Vehicle = 0x03,
    Place = 0x04,
    Route = 0x05,
    Stop = 0x06,
    Activity = 0x07,
    Meal = 0x08,
    Shopping = 0x09,
    Gear = 0x0a,
    Expense = 0x0b,
    Settlement = 0x0c,
    /// [`SeqIds`] 回傳的採買品項 id（採買同步新增的 Meal_Item）；`arb_state()` 不使用。
    NewShopping = 0xf0,
}

/// 種類 `tag` 的第 `n` 個 UUID：`TT000000-0000-4000-8000-NNNNNNNNNNNN`，`n` 最多 48 位元。
pub fn uuid(tag: Tag, n: u64) -> Uuid {
    assert!(n < 1 << 48, "序號 {n} 超過 48 位元");
    Uuid::from_u128(
        (u128::from(tag as u8) << 120) | (0x4000_u128 << 64) | (0x8000_u128 << 48) | u128::from(n),
    )
}

/// [`uuid()`] 轉成 id 型別，例如 `let person: PersonId = id(Tag::Person, 1);`。
pub fn id<T: From<Uuid>>(tag: Tag, n: u64) -> T {
    T::from(uuid(tag, n))
}

/// `id` 是不是種類 `tag` 的 UUID。
pub fn has_tag(id: Uuid, tag: Tag) -> bool {
    id.as_bytes()[0] == tag as u8
}

/// 依序產生採買品項 id 的決定性 `IdSource`：第 k 次（從 1 起）回傳 `id(Tag::NewShopping, k)`。
///
/// 回傳的 id 不與 `arb_state()` 產生的任何一列重複，彼此也不重複（`sync_meal_ingredients()` 以 `debug_assert!`
/// 檢查這兩件事）。同一個測試案例中多次執行採買同步時（例如套用同步的結果之後再同步一次），請一直使用同一個
/// `SeqIds`：新的 `SeqIds` 從頭編號，會回傳已經在狀態中的 id。
#[derive(Clone, Debug, Default)]
pub struct SeqIds {
    taken: u64,
}

impl SeqIds {
    /// 還沒有回傳任何 id 的 `SeqIds`。
    pub fn new() -> SeqIds {
        SeqIds::default()
    }

    /// 目前為止回傳了幾個 id。
    pub fn taken(&self) -> u64 {
        self.taken
    }
}

impl IdSource for SeqIds {
    fn shopping_id(&mut self) -> ShoppingId {
        self.taken += 1;
        id(Tag::NewShopping, self.taken)
    }
}
