//! 管理後台規則的範例測試（`lm_core::admin`，需求 35 至 41，design 5.8）。
//!
//! 這些案例不是 Bun_App 測試的移植：輸入與預期值都依需求撰寫。
use lm_core::admin::{
    account_matches, admin_stats, audit_action_label, audit_page_count, check_disable,
    check_role_change, resolve_public_signup, taipei_minute, AdminRejection, AdminUserDto,
    AdminUsersResponse, Policy, ResetPasswordRequest, SettingSource, UpdateUserRequest,
};
use lm_core::ids::UserId;
use lm_core::model::Role;
use uuid::Uuid;

fn id(n: u128) -> UserId {
    UserId(Uuid::from_u128(n))
}

fn user(n: u128, role: Role, disabled: bool) -> AdminUserDto {
    AdminUserDto {
        id: id(n),
        username: format!("user-{n}"),
        display_name: format!("使用者 {n}"),
        role,
        created_at: "2026-03-01T06:05:00.000Z".to_owned(),
        disabled_at: disabled.then(|| "2026-03-02T00:00:00.000Z".to_owned()),
        trip_count: 0,
    }
}

/// 需求 35.4 的三個例子：「Amy」符合 `amy-chen`，「小明」符合「陳小明」，全形的「ＡＭＹ」也符合 `amy-chen`。
#[test]
fn search_matches_the_requirement_examples() {
    assert!(account_matches("Amy", "amy-chen", "Amy Chen"));
    assert!(account_matches("Amy", "amy-chen", "陳"));
    assert!(account_matches("小明", "ming", "陳小明"));
    assert!(account_matches("ＡＭＹ", "amy-chen", "陳"));
}

/// 需求 35.3：搜尋文字經 Trim_White 後是空字串（包括全形空白）時列出全部帳號。
#[test]
fn blank_queries_match_everyone() {
    for query in ["", "   ", "\u{3000}", " \u{3000}\t"] {
        assert!(account_matches(query, "bob", "Bob"), "{query:?}");
    }
}

/// 需求 35.4：搜尋文字前後的空白與大寫不影響結果；Display_Name 前後有空白也符合。
#[test]
fn search_trims_and_lowercases() {
    assert!(account_matches("  BOB\u{3000}", "bob-lin", "林"));
    assert!(account_matches("LIN", "bob", "  Lin  "));
    assert!(account_matches("ｌｉｎ", "bob", "Lin"));
}

/// 需求 35.4：帳號名稱與 Display_Name 都不包含搜尋文字時不符合。
#[test]
fn search_rejects_non_matches() {
    assert!(!account_matches("carol", "amy-chen", "陳小明"));
    assert!(!account_matches("小華", "amy-chen", "陳小明"));
    assert!(!account_matches("amy chen", "amy-chen", "陳小明"));
}

/// 需求 37.2、37.3：stored 優先，其次是 seed，都沒有時是 default 的 open。
#[test]
fn public_signup_resolution_order() {
    assert_eq!(
        resolve_public_signup(Some(Policy::Closed), Some(true)),
        (Policy::Closed, SettingSource::Stored)
    );
    assert_eq!(
        resolve_public_signup(Some(Policy::Open), Some(false)),
        (Policy::Open, SettingSource::Stored)
    );
    assert_eq!(
        resolve_public_signup(None, Some(true)),
        (Policy::Open, SettingSource::Seed)
    );
    assert_eq!(
        resolve_public_signup(None, Some(false)),
        (Policy::Closed, SettingSource::Seed)
    );
    assert_eq!(
        resolve_public_signup(None, None),
        (Policy::Open, SettingSource::Default)
    );
}

/// 需求 37.1：線上格式是小寫的 open／closed，其他寫法不接受。
#[test]
fn policy_wire_format() {
    assert_eq!(serde_json::to_string(&Policy::Open).unwrap(), "\"open\"");
    assert_eq!(
        serde_json::to_string(&Policy::Closed).unwrap(),
        "\"closed\""
    );
    assert_eq!(
        serde_json::to_string(&SettingSource::Default).unwrap(),
        "\"default\""
    );
    assert_eq!(Policy::parse("open"), Some(Policy::Open));
    assert_eq!(Policy::parse("closed"), Some(Policy::Closed));
    assert_eq!(Policy::parse("OPEN"), None);
    assert!(serde_json::from_str::<Policy>("\"OPEN\"").is_err());
}

/// 需求 39.3：自己改角色被拒；自己不改角色（只改名稱）通過。
#[test]
fn role_change_on_self() {
    let me = user(1, Role::Admin, false);
    assert_eq!(
        check_role_change(me.id, &me, Role::Member, 2),
        Err(AdminRejection::SelfRoleChange)
    );
    assert_eq!(check_role_change(me.id, &me, Role::Admin, 1), Ok(()));
}

/// 需求 39.3：降級最後一位有效 Admin 是 409；還有另一位有效 Admin 時通過。
#[test]
fn demoting_admins() {
    let actor = id(9);
    let target = user(2, Role::Admin, false);
    assert_eq!(
        check_role_change(actor, &target, Role::Member, 1),
        Err(AdminRejection::LastAdmin)
    );
    assert_eq!(check_role_change(actor, &target, Role::Member, 2), Ok(()));
}

/// 需求 39.3：停用的 Admin 不算有效的 Admin，所以降級它不受最後一位的限制；升級成員通過。
#[test]
fn disabled_admins_and_promotions() {
    let actor = id(9);
    let disabled_admin = user(3, Role::Admin, true);
    assert_eq!(
        check_role_change(actor, &disabled_admin, Role::Member, 1),
        Ok(())
    );
    let member = user(4, Role::Member, false);
    assert_eq!(check_role_change(actor, &member, Role::Admin, 1), Ok(()));
}

/// 需求 40.3：停用自己 403、停用最後一位有效 Admin 409；一般成員與已停用的帳號通過。
#[test]
fn disable_rules() {
    let me = user(1, Role::Admin, false);
    assert_eq!(
        check_disable(me.id, &me, 2),
        Err(AdminRejection::SelfDisable)
    );
    let actor = id(9);
    let admin = user(2, Role::Admin, false);
    assert_eq!(
        check_disable(actor, &admin, 1),
        Err(AdminRejection::LastAdmin)
    );
    assert_eq!(check_disable(actor, &admin, 2), Ok(()));
    assert_eq!(
        check_disable(actor, &user(4, Role::Member, false), 1),
        Ok(())
    );
    assert_eq!(
        check_disable(actor, &user(5, Role::Member, true), 1),
        Ok(())
    );
    assert_eq!(check_disable(actor, &user(6, Role::Admin, true), 1), Ok(()));
}

/// design 5.7：錯誤代碼與訊息。
#[test]
fn rejection_codes_and_messages() {
    let cases = [
        (
            AdminRejection::SelfRoleChange,
            "self_role_change",
            "不能變更自己的角色。",
        ),
        (
            AdminRejection::SelfDisable,
            "self_disable",
            "不能停用自己的帳號。",
        ),
        (
            AdminRejection::LastAdmin,
            "last_admin",
            "至少需要保留一位管理員。",
        ),
    ];
    for (rejection, code, message) in cases {
        assert_eq!(rejection.code(), code);
        assert_eq!(rejection.message(), message);
    }
}

/// 需求 35.6：帳號總數、使用中、已停用、有效的管理員與旅行總數。
#[test]
fn stats_count_each_group() {
    let resp = AdminUsersResponse {
        users: vec![
            user(1, Role::Admin, false),
            user(2, Role::Admin, true),
            user(3, Role::Member, false),
            user(4, Role::Member, true),
            user(5, Role::Member, false),
        ],
        trip_total: 8,
    };
    let stats = admin_stats(&resp);
    assert_eq!(stats.accounts, 5);
    assert_eq!(stats.active, 3);
    assert_eq!(stats.disabled, 2);
    assert_eq!(stats.admins, 1);
    assert_eq!(stats.trips, 8);

    let empty = admin_stats(&AdminUsersResponse {
        users: Vec::new(),
        trip_total: 0,
    });
    assert_eq!(
        (
            empty.accounts,
            empty.active,
            empty.disabled,
            empty.admins,
            empty.trips
        ),
        (0, 0, 0, 0, 0)
    );
}

/// 需求 41.3：最新 200 筆以內的筆數除以 20 無條件進位，最少 1 頁。
#[test]
fn audit_page_counts() {
    for (total, pages) in [(0, 1), (1, 1), (20, 1), (21, 2), (200, 10), (500, 10)] {
        assert_eq!(audit_page_count(total), pages, "{total}");
    }
}

/// 需求 41.2、41.5：每個操作代碼的中文名稱；不認得的代碼是 None。
#[test]
fn audit_action_labels() {
    let cases = [
        ("account.register", "註冊帳號"),
        ("admin.user.update", "修改帳號"),
        ("admin.user.password_reset", "重設密碼"),
        ("admin.user.disable", "停用帳號"),
        ("admin.user.enable", "啟用帳號"),
        ("admin.settings.public_signup", "變更公開註冊"),
        ("trip.create", "建立旅行"),
        ("trip.delete", "刪除旅行"),
        ("invite.create", "建立邀請連結"),
        ("invite.revoke", "撤銷邀請連結"),
        ("invite.join", "以邀請連結加入旅行"),
    ];
    for (action, label) in cases {
        assert_eq!(audit_action_label(action), Some(label), "{action}");
    }
    assert_eq!(audit_action_label("trip.rename"), None);
}

/// 需求 37.6、41.5：台灣時間（UTC+8）的「YYYY/MM/DD HH:MM」；無法解析時是 None。
#[test]
fn taipei_minutes() {
    assert_eq!(
        taipei_minute("2026-03-01T06:05:00.000Z").as_deref(),
        Some("2026/03/01 14:05")
    );
    assert_eq!(
        taipei_minute("2026-12-31T16:30:59Z").as_deref(),
        Some("2027/01/01 00:30")
    );
    assert_eq!(taipei_minute("2026/03/01 14:05"), None);
    assert_eq!(taipei_minute(""), None);
}

/// 需求 36.7：`Debug` 不印出密碼；請求不接受其他欄位。
#[test]
fn reset_password_request_hides_the_password() {
    let request = ResetPasswordRequest {
        password: "correct horse battery".to_owned(),
    };
    let debug = format!("{request:?}");
    assert!(!debug.contains("correct horse"), "{debug}");
    assert!(debug.contains("<redacted>"), "{debug}");
    assert!(serde_json::from_str::<ResetPasswordRequest>(
        r#"{"password":"correct horse battery","extra":1}"#
    )
    .is_err());
    assert!(serde_json::from_str::<ResetPasswordRequest>("{}").is_err());
}

/// 需求 39.2、39.3：只送出有變更的欄位；不接受其他欄位。
#[test]
fn update_user_request_wire_format() {
    let request = UpdateUserRequest {
        display_name: None,
        role: Some(Role::Member),
    };
    assert_eq!(
        serde_json::to_string(&request).unwrap(),
        r#"{"role":"member"}"#
    );
    assert_eq!(
        serde_json::from_str::<UpdateUserRequest>("{}").unwrap(),
        UpdateUserRequest::default()
    );
    assert!(serde_json::from_str::<UpdateUserRequest>(r#"{"username":"x"}"#).is_err());
    assert!(serde_json::from_str::<UpdateUserRequest>(r#"{"role":"owner"}"#).is_err());
}
