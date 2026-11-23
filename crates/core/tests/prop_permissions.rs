//! Property 8 的屬性測試（任務 8.4；需求 6.1、6.2、6.4、6.6–6.11、33.5、33.6）：權限判斷與規則表一致。
//!
//! 在測試中以查表另外實作 Permission_Table（design 1.4 的「權限」表格）：每一種命令（以線上格式的 `type` 查表）對
//! 管理者與受邀旅伴的規則，再依身分決定允許、403 與訊息，或 404「找不到這趟旅行。」。輸入是 `arb_state()`、
//! `arb_caps()` 的五種身分與 `arb_command()` 的每一種命令（目標包括自己或別人的旅伴、綁定或未綁定帳號的旅伴，以及
//! 不存在的列），比對 `authorize()` 是否允許，以及拒絕的種類與訊息。`authorize()` 在找目標、驗證與判斷有沒有變化之前
//! 執行（需求 6.4），所以查表也不看目標是否存在、內容是否合法。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_permissions.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::command::{
    Command, Rejection, DENY_LEDGER_REMOVAL, DENY_OTHER_PERSON, DENY_PACKING, DENY_REMOVAL,
    TRIP_NOT_FOUND,
};
use lm_core::model::TripState;
use lm_core::rules::{authorize, Capabilities};
use proptest::prelude::*;

use support::commands::{arb_caps, arb_command, Identity};
use support::state::arb_state;

/// Permission_Table 中一個命令的規則。
#[derive(Clone, Copy, Debug)]
enum Rule {
    /// 管理者與受邀旅伴都可以。
    Both,
    /// 只有管理者；受邀旅伴 403「受邀旅伴可以編輯，但不能刪除既有項目；…」。
    ManagerOnly,
    /// 只能是自己的旅伴（打包與出發確認）；其他人 403「只能變更自己的行前準備。」。
    SelfOnly,
    /// 需綁定旅伴；沒有綁定旅伴的管理員 404。
    LedgerEdit,
    /// 需綁定旅伴的管理者；沒有綁定旅伴的管理員 404，受邀旅伴 403。
    LedgerManage,
    /// 受邀旅伴只能改未綁定帳號的旅伴與自己；其他綁定者 403「只能修改自己的旅伴資料。」。
    OwnOrUnbound,
}

/// design 1.4 的「權限」表格，以命令的 `type` 查表。
const TABLE: &[(&str, Rule)] = &[
    ("update_trip", Rule::Both),
    ("add_person", Rule::Both),
    ("update_person", Rule::OwnOrUnbound),
    ("remove_person", Rule::ManagerOnly),
    ("add_vehicle", Rule::Both),
    ("update_vehicle", Rule::Both),
    ("remove_vehicle", Rule::ManagerOnly),
    ("add_place", Rule::Both),
    ("rename_place", Rule::Both),
    ("remove_place", Rule::Both),
    ("save_route", Rule::Both),
    ("remove_route", Rule::Both),
    ("save_day_setting", Rule::Both),
    ("add_activities", Rule::Both),
    ("update_activity", Rule::Both),
    ("remove_activity", Rule::Both),
    ("set_activity_done", Rule::Both),
    ("add_meal", Rule::Both),
    ("update_meal", Rule::Both),
    ("remove_ingredient_from_meals", Rule::Both),
    ("remove_meal", Rule::ManagerOnly),
    ("add_shopping_item", Rule::Both),
    ("update_shopping_item", Rule::Both),
    ("set_shopping_purchased", Rule::Both),
    ("remove_shopping_item", Rule::ManagerOnly),
    ("add_gear", Rule::Both),
    ("update_gear", Rule::Both),
    ("remove_gear", Rule::ManagerOnly),
    ("set_gear_packed", Rule::SelfOnly),
    ("set_departed", Rule::SelfOnly),
    ("add_expense", Rule::LedgerEdit),
    ("update_expense", Rule::LedgerEdit),
    ("add_settlement", Rule::LedgerEdit),
    ("update_settlement", Rule::LedgerEdit),
    ("remove_expense", Rule::LedgerManage),
    ("remove_settlement", Rule::LedgerManage),
];

/// 權限判斷的結果。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Verdict {
    Allow,
    Forbidden(String),
    NotFound,
}

/// 查表：`identity` 以 `caps` 送出 `cmd` 時 Permission_Table 的結果。
fn expected(state: &TripState, identity: Identity, caps: &Capabilities, cmd: &Command) -> Verdict {
    let kind = serde_json::to_value(cmd).expect("命令可以序列化")["type"]
        .as_str()
        .expect("命令有 type")
        .to_owned();
    let rule = TABLE
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|&(_, rule)| rule)
        .unwrap_or_else(|| panic!("Permission_Table 沒有 {kind}"));
    // 管理者是擁有者或 Admin（包括沒有綁定旅伴的 Admin）；成員是綁定一位旅伴的 Account
    let manager = matches!(
        identity,
        Identity::Owner | Identity::Admin | Identity::UnboundAdmin
    );
    let me = caps.me;
    if !manager && me.is_none() {
        return Verdict::NotFound;
    }
    let forbid = |message: &str| Verdict::Forbidden(message.to_owned());
    match rule {
        Rule::Both => Verdict::Allow,
        Rule::ManagerOnly if manager => Verdict::Allow,
        Rule::ManagerOnly => forbid(DENY_REMOVAL),
        Rule::SelfOnly => {
            let person = match cmd {
                Command::SetGearPacked { person, .. } | Command::SetDeparted { person, .. } => {
                    *person
                }
                _ => unreachable!("只有打包與出發確認是 SelfOnly"),
            };
            if me == Some(person) {
                Verdict::Allow
            } else {
                forbid(DENY_PACKING)
            }
        }
        Rule::LedgerEdit if me.is_some() => Verdict::Allow,
        Rule::LedgerEdit => Verdict::NotFound,
        Rule::LedgerManage if me.is_none() => Verdict::NotFound,
        Rule::LedgerManage if manager => Verdict::Allow,
        Rule::LedgerManage => forbid(DENY_LEDGER_REMOVAL),
        Rule::OwnOrUnbound => {
            let Command::UpdatePerson { id, .. } = cmd else {
                unreachable!("只有修改旅伴是 OwnOrUnbound")
            };
            let other_bound = state.people.get(id).is_some_and(|p| p.bound) && me != Some(*id);
            if !manager && other_bound {
                forbid(DENY_OTHER_PERSON)
            } else {
                Verdict::Allow
            }
        }
    }
}

/// `authorize()` 的結果。
fn actual(state: &TripState, caps: &Capabilities, cmd: &Command) -> Result<Verdict, String> {
    match authorize(state, caps, cmd) {
        Ok(()) => Ok(Verdict::Allow),
        Err(Rejection::Forbidden { message }) => Ok(Verdict::Forbidden(message)),
        Err(Rejection::NotFound { message }) if message == TRIP_NOT_FOUND => Ok(Verdict::NotFound),
        Err(other) => Err(format!(
            "authorize() 只回應 403 或 404「找不到這趟旅行。」：{other:?}"
        )),
    }
}

fn arb_case() -> impl Strategy<Value = (TripState, (Identity, Capabilities), Command)> {
    arb_state().prop_flat_map(|state| {
        let caps = arb_caps(&state);
        let command = arb_command(&state);
        (Just(state), caps, command)
    })
}

// Feature: rust-supabase-rewrite, Property 8: 權限判斷與規則表一致
proptest! {
    /// *For any* 身分（擁有者、管理員、受邀成員、沒有綁定旅伴的管理員、非成員）、任何命令種類、任何目標，
    /// `authorize()` 成功若且唯若以查表實作的「權限」表格允許；被拒絕時的種類（404 或 403）也與表格相同。
    ///
    /// **Validates: Requirements 6.1, 6.2, 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11**
    #[test]
    fn authorize_matches_the_permission_table((state, (identity, caps), cmd) in arb_case()) {
        let verdict = actual(&state, &caps, &cmd).map_err(TestCaseError::fail)?;
        prop_assert_eq!(
            verdict,
            expected(&state, identity, &caps, &cmd),
            "{:?}（{:?}）送出 {:?}",
            identity,
            caps,
            cmd
        );
    }
}
