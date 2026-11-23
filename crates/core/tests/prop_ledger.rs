//! Property 15 的屬性測試（任務 7.2；需求 29.6、29.7、33.5、33.6）：分帳金額守恆。
//!
//! 輸入是共用產生器 `arb_state()` 的支出與還款：0–6 位旅伴、0–5 筆支出與 0–5 筆還款，金額包括 NT$0.01 與
//! NT$1,000,000 兩個邊界；每筆支出至少有一位分攤旅伴，還款的付款人與收款人是不同的旅伴。檢查：
//!
//! - 每筆支出的 `split_evenly()`：每位分攤旅伴各一項，總和等於金額，任兩人相差最多 1 分；每人先得到 ⌊金額 ÷ 人數⌋ 分，
//!   餘下的 r 分依旅伴 id 的小寫十六進位字串遞增，各 1 分給排在前面的 r 位（需求 29.6）。`arb_state()` 最多 6 位旅伴，
//!   id 依建立的順序編號，所以另外直接產生一筆分攤：1–100 位 id 任意的分攤旅伴與 1–100,000,000 分的金額。
//! - `summarize()` 的淨額總和為 0。淨額依需求 29.7 是已付 − 分攤 + 已還出 − 已收回，所以也檢查每一分錢都恰好算進一次：
//!   已付與分攤的總和都等於支出金額的總和，已還出與已收回的總和都等於還款金額的總和。只檢查淨額總和時，完全不計算帳目，
//!   或把每筆支出都算兩次的 `summarize()` 也會通過其餘的檢查。
//! - 建議轉帳全部記成還款之後再 `summarize()`：每個人的淨額都是 0，也沒有建議轉帳（需求 29.7）。每筆建議轉帳都要能記成
//!   一筆還款：付款人與收款人是兩位不同的旅伴，金額大於 0。單筆還款最多 NT$1,000,000，一筆建議轉帳可能超過（使用者要
//!   分成幾筆記錄）；這裡把還款直接放進 Trip_State，不經命令的驗證，所以不檢查這個上限。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_ledger.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use std::collections::{BTreeMap, BTreeSet};

use lm_core::ids::{PersonId, SettlementId};
use lm_core::ledger::{split_evenly, summarize, Balance, LedgerSummary, Transfer};
use lm_core::limits::{AMOUNT_CENTS, EXPENSE_PARTICIPANTS};
use lm_core::model::{Row, Settlement, TripState};
use proptest::collection::btree_set;
use proptest::prelude::*;
use uuid::Uuid;

use support::ids::{id, Tag};
use support::state::arb_state;

// Feature: rust-supabase-rewrite, Property 15: 分帳金額守恆
proptest! {
    /// *For any* 支出與還款，`summarize()` 的淨額總和為 0；每筆 `split_evenly()` 的總和等於金額，任兩人相差最多 1 分；
    /// 依建議轉帳全部執行後，每個人的淨額都是 0。
    ///
    /// **Validates: Requirements 29.6, 29.7**
    #[test]
    fn ledger_conserves_money_and_suggested_transfers_settle_everyone(
        state in arb_state(),
        (amount_cents, participants) in arb_split(),
    ) {
        // 每筆 split_evenly()：狀態中的每筆支出，以及直接產生的一筆分攤
        for expense in state.expenses.values() {
            check_split(
                expense.amount_cents,
                &expense.participants,
                &format!("支出 {}", expense.id),
            )?;
        }
        check_split(amount_cents, &participants, "直接產生的分攤")?;

        // summarize() 的淨額總和為 0
        let summary = summarize(&state);
        check_conservation(&state, &summary, "帳本")?;

        // 依建議轉帳全部執行後，每個人的淨額都是 0
        let settled = record_transfers(&state, &summary.transfers)?;
        let after = summarize(&settled);
        check_conservation(&settled, &after, "建議轉帳記成還款之後的帳本")?;
        let unsettled: Vec<&Balance> = after
            .balances
            .iter()
            .filter(|balance| balance.net_cents != 0)
            .collect();
        prop_assert!(
            unsettled.is_empty(),
            "建議轉帳 {:?} 全部記成還款之後，這些旅伴的淨額不是 0：{unsettled:#?}",
            summary.transfers
        );
        prop_assert!(
            after.transfers.is_empty(),
            "建議轉帳全部記成還款之後仍有建議轉帳：{:?}",
            after.transfers
        );
    }
}

// ── 輸入 ──

/// 直接產生的一筆分攤，範圍依需求 29.2：1–100 位分攤旅伴，id 一半是任意的 UUID，一半只有最後兩個位元組不同（前 14 個
/// 位元組都是 0）；金額 1–100,000,000 分，包括兩個邊界，以及常常少於人數、有人分到 0 分的小金額。
fn arb_split() -> impl Strategy<Value = (i64, BTreeSet<PersonId>)> {
    let amount = prop_oneof![
        1 => Just(*AMOUNT_CENTS.start()),
        1 => Just(*AMOUNT_CENTS.end()),
        3 => 1..=300_i64,
        3 => AMOUNT_CENTS,
    ];
    let person =
        prop_oneof![any::<u128>(), 0..=0xffff_u128].prop_map(|n| PersonId(Uuid::from_u128(n)));
    (amount, btree_set(person, EXPENSE_PARTICIPANTS))
}

// ── 檢查 ──

/// 需求 29.6 的 `split_evenly(amount_cents, participants)`：每位分攤旅伴各一項，總和等於金額，任兩人相差最多 1 分；每人
/// 先得到 ⌊金額 ÷ 人數⌋ 分，餘下的 r 分依旅伴 id 的小寫十六進位字串遞增，各 1 分給排在前面的 r 位。不依賴結果的順序。
fn check_split(
    amount_cents: i64,
    participants: &BTreeSet<PersonId>,
    what: &str,
) -> Result<(), TestCaseError> {
    let shares = split_evenly(amount_cents, participants);
    let amount_of: BTreeMap<PersonId, i64> = shares
        .iter()
        .map(|share| (share.person, share.amount_cents))
        .collect();
    prop_assert!(
        shares.len() == participants.len() && amount_of.keys().eq(participants),
        "{what}：分攤旅伴 {participants:?} 應該各有一項：{shares:?}"
    );

    // 分攤金額依旅伴 id 的小寫十六進位字串遞增排列
    let mut ranked: Vec<PersonId> = participants.iter().copied().collect();
    ranked.sort_by_cached_key(PersonId::to_string);
    let amounts: Vec<i64> = ranked.iter().map(|person| amount_of[person]).collect();
    prop_assert_eq!(
        amounts.iter().sum::<i64>(),
        amount_cents,
        "{}：分攤金額 {:?} 的總和應該等於金額",
        what,
        amounts
    );
    let gap = amounts
        .iter()
        .max()
        .zip(amounts.iter().min())
        .map(|(max, min)| max - min);
    prop_assert!(
        gap.is_some_and(|gap| gap <= 1),
        "{what}：分攤金額 {amounts:?} 中有兩人相差超過 1 分"
    );

    let count = amounts.len() as i64;
    let (base, remainder) = (amount_cents / count, amount_cents % count);
    let expected: Vec<i64> = (0..count)
        .map(|rank| base + i64::from(rank < remainder))
        .collect();
    prop_assert_eq!(
        &amounts,
        &expected,
        "{}：{} 分由 {} 人分攤時每人 {} 分，餘下的 {} 分應該各 1 分給 id 最小的旅伴（金額依 id 遞增排列）",
        what,
        amount_cents,
        count,
        base,
        remainder
    );
    Ok(())
}

/// `summarize()` 的淨額總和為 0，而且每一分錢都恰好算進一次：支出的總金額 `total_cents`、已付的總和與分攤的總和都等於
/// 支出金額的總和；還款的總金額 `total_settled_cents`、已還出的總和與已收回的總和都等於還款金額的總和；每位旅伴的淨額
/// 是已付 − 分攤 + 已還出 − 已收回（需求 29.7）。
fn check_conservation(
    state: &TripState,
    summary: &LedgerSummary,
    what: &str,
) -> Result<(), TestCaseError> {
    let expenses: i64 = state
        .expenses
        .values()
        .map(|expense| expense.amount_cents)
        .sum();
    let settlements: i64 = state
        .settlements
        .values()
        .map(|settlement| settlement.amount_cents)
        .sum();
    let total = |cents: fn(&Balance) -> i64| -> i64 { summary.balances.iter().map(cents).sum() };
    for (name, actual, expected) in [
        ("支出的總金額", summary.total_cents, expenses),
        ("已付的總和", total(|balance| balance.paid_cents), expenses),
        ("分攤的總和", total(|balance| balance.share_cents), expenses),
        ("還款的總金額", summary.total_settled_cents, settlements),
        (
            "已還出的總和",
            total(|balance| balance.sent_cents),
            settlements,
        ),
        (
            "已收回的總和",
            total(|balance| balance.received_cents),
            settlements,
        ),
    ] {
        prop_assert_eq!(actual, expected, "{}的{}", what, name);
    }
    for balance in &summary.balances {
        prop_assert_eq!(
            balance.net_cents,
            balance.paid_cents - balance.share_cents + balance.sent_cents - balance.received_cents,
            "{}：淨額應該是已付 − 分攤 + 已還出 − 已收回：{:?}",
            what,
            balance
        );
    }
    prop_assert_eq!(
        total(|balance| balance.net_cents),
        0,
        "{}的淨額總和應該為 0：{:#?}",
        what,
        summary.balances
    );
    Ok(())
}

// ── 執行建議轉帳 ──

/// `state` 加上 `transfers` 記成的還款（需求 29.7「建議轉帳全部記錄為還款」）：每筆建議轉帳是一筆付款人 `from`、收款人
/// `to`、金額 `amount_cents` 的新還款，日期是旅行的最後一天，依序取得還沒有用過的 id，以及 `state` 的所有列之後的
/// Ordinal。每筆建議轉帳都要能記成還款：付款人與收款人是兩位不同的旅伴，金額大於 0（需求 29.3）。
fn record_transfers(state: &TripState, transfers: &[Transfer]) -> Result<TripState, TestCaseError> {
    let mut settled = state.clone();
    for (transfer, ordinal) in transfers.iter().zip(state.max_ordinal() + 1..) {
        prop_assert!(
            transfer.from != transfer.to
                && transfer.amount_cents > 0
                && state.people.contains_key(&transfer.from)
                && state.people.contains_key(&transfer.to),
            "建議轉帳 {transfer:?} 應該是兩位不同的旅伴之間、大於 0 的金額"
        );
        let unused = (1..)
            .map(|n| id::<SettlementId>(Tag::Settlement, n))
            .find(|candidate| !settled.settlements.contains_key(candidate))
            .expect("還有沒用過的還款 id");
        settled.put(Row::Settlement(Settlement {
            id: unused,
            day: state.card.end,
            from: transfer.from,
            to: transfer.to,
            amount_cents: transfer.amount_cents,
            note: String::new(),
            ordinal,
            version: ordinal,
        }));
    }
    Ok(settled)
}
