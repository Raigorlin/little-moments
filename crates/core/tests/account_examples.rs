//! 帳號欄位規則的範例測試（`lm_core::account`，需求 3.2 至 3.5、3.14、4.1、4.2）。
//!
//! 需求 33.1 沒有列出帳號規則，這些案例也不是 Bun_App 測試的移植：輸入與預期值都依需求撰寫。

use lm_core::account::{
    check_display_name, check_password, check_signup, check_username, login_username,
    normalize_username, Violation, PASSWORD_MISMATCH, RESERVED_USERNAMES,
};

/// 需求 3.1：依帳號名稱的格式、保留字、顯示名稱、密碼的順序，只回報第一個不通過的規則；都通過時回傳經
/// Participant_Name 的顯示名稱。
#[test]
fn signup_reports_the_first_failing_rule() {
    let cases = [
        ("Alice", " ", "short", Err(Violation::UsernameFormat)),
        ("admin", " ", "short", Err(Violation::UsernameReserved)),
        ("amy", " ", "short", Err(Violation::DisplayName)),
        ("amy", "Amy", "short", Err(Violation::Password)),
        (
            "amy",
            " Ａｍｙ\u{3000} Lin ",
            "correct horse",
            Ok("Amy Lin".to_owned()),
        ),
    ];
    for (username, display_name, password, expected) in cases {
        assert_eq!(
            check_signup(username, display_name, password),
            expected,
            "{username:?} {display_name:?} {password:?}"
        );
    }
}

/// 需求 3.2、3.3：帳號名稱原樣比對 `^[a-z][a-z0-9-]{2,31}$`，之後才檢查保留字。
#[test]
fn usernames_are_checked_as_given() {
    let thirty_two = format!("a{}", "b".repeat(31));
    let thirty_three = format!("a{}", "b".repeat(32));
    for username in [
        "abc",
        "a-1",
        "a--",
        "invites",
        "admin1",
        thirty_two.as_str(),
    ] {
        assert_eq!(check_username(username), Ok(()), "{username:?}");
    }
    for username in [
        "",
        "ab",
        "Alice",
        " alice",
        "alice ",
        "1abc",
        "-abc",
        "a_b",
        "abc.d",
        "ａbc",
        thirty_three.as_str(),
    ] {
        assert_eq!(
            check_username(username),
            Err(Violation::UsernameFormat),
            "{username:?}"
        );
    }
    for username in RESERVED_USERNAMES {
        assert_eq!(
            check_username(username),
            Err(Violation::UsernameReserved),
            "{username:?}"
        );
    }
    assert_eq!(RESERVED_USERNAMES.len(), 9);
    assert!(RESERVED_USERNAMES.contains(&"invite"));
}

/// 需求 3.4：顯示名稱經 Participant_Name 之後檢查字數、Hidden_Control_Char 與 Participant_Key。
#[test]
fn display_names_are_checked_after_participant_name() {
    let thirty = "安".repeat(30);
    for (display_name, expected) in [
        ("小安", "小安"),
        (" Ａｌｉｃｅ\u{3000} Lin ", "Alice Lin"),
        ("👨\u{200d}👩\u{200d}👧", "👨\u{200d}👩\u{200d}👧"),
        (thirty.as_str(), thirty.as_str()),
    ] {
        assert_eq!(
            check_display_name(display_name),
            Ok(expected.to_owned()),
            "{display_name:?}"
        );
    }
    let thirty_one = "安".repeat(31);
    for display_name in [
        "",
        "   ",
        "\u{3000}",
        "\u{3164}",
        "\u{200b}",
        "小\u{200b}安",
        "小\u{85}安",
        thirty_one.as_str(),
    ] {
        assert_eq!(
            check_display_name(display_name),
            Err(Violation::DisplayName),
            "{display_name:?}"
        );
    }
}

/// 需求 3.5：原樣的密碼是 12–72 個字元，而且 UTF-8 不超過 72 位元組。
#[test]
fn passwords_are_checked_as_given() {
    let seventy_two = "a".repeat(72);
    let cjk_72_bytes = "密".repeat(24);
    let spaced = format!(" {} ", "a".repeat(10));
    for password in [
        "a".repeat(12).as_str(),
        seventy_two.as_str(),
        cjk_72_bytes.as_str(),
        spaced.as_str(),
    ] {
        assert_eq!(check_password(password), Ok(()), "{password:?}");
    }
    let seventy_three = "a".repeat(73);
    // 25 個中文字是 75 位元組；71 個字元、73 位元組
    let cjk_75_bytes = "密".repeat(25);
    let mixed_73_bytes = format!("{}密", "a".repeat(70));
    for password in [
        "",
        "a".repeat(11).as_str(),
        seventy_three.as_str(),
        cjk_75_bytes.as_str(),
        mixed_73_bytes.as_str(),
    ] {
        assert_eq!(
            check_password(password),
            Err(Violation::Password),
            "{password:?}"
        );
    }
}

/// 需求 5.5：每個規則有固定的 `code`、`field` 與訊息。
#[test]
fn violations_have_fixed_codes_fields_and_messages() {
    let cases = [
        (
            Violation::UsernameFormat,
            "invalid_username",
            "username",
            "帳號名稱需為 3–32 個字元：以小寫英文字母開頭，只能使用小寫英文字母、數字或連字號（-）。",
        ),
        (
            Violation::UsernameReserved,
            "reserved_username",
            "username",
            "這個帳號名稱是系統保留字，請換一個。",
        ),
        (
            Violation::DisplayName,
            "invalid_display_name",
            "display_name",
            "請填寫 1–30 個字的顯示名稱，不能只有空白或包含隱藏控制字元。",
        ),
        (
            Violation::Password,
            "invalid_password",
            "password",
            "密碼需為 12–72 個字元，而且不超過 72 個位元組（一個中文字占 3 個位元組）。",
        ),
    ];
    for (violation, code, field, message) in cases {
        assert_eq!(
            (violation.code(), violation.field(), violation.message()),
            (code, field, message)
        );
    }
    // 需求 3.14
    assert_eq!(PASSWORD_MISMATCH, "兩次輸入的密碼不一致。");
}

/// 需求 3.14、4.1：Trim_White，再只把 A–Z 轉成小寫。
#[test]
fn usernames_are_trimmed_and_ascii_lowercased() {
    for (input, expected) in [
        ("  Alice ", "alice"),
        ("\u{3000}ALICE\u{3000}", "alice"),
        ("\tBob-1\n", "bob-1"),
        ("Ａｌｉｃｅ", "Ａｌｉｃｅ"),
        ("ÄLICE", "Älice"),
        (" \u{3000} ", ""),
    ] {
        assert_eq!(normalize_username(input), expected, "{input:?}");
    }
}

/// 需求 4.1、4.2：正規化後的帳號名稱不通過格式或保留字，或密碼是空的、超過 72 位元組時沒有可以登入的帳號；密碼的
/// 字數與前後空白不在這裡檢查。
#[test]
fn login_usernames_need_a_possible_username_and_password() {
    let seventy_two = "a".repeat(72);
    for (username, password, expected) in [
        ("  Alice ", "correct horse", "alice"),
        ("\u{3000}alice\u{3000}", " correct horse ", "alice"),
        ("alice", "short", "alice"),
        ("alice", seventy_two.as_str(), "alice"),
    ] {
        assert_eq!(
            login_username(username, password),
            Some(expected.to_owned()),
            "{username:?} {password:?}"
        );
    }
    let seventy_three = "a".repeat(73);
    let cjk_75_bytes = "密".repeat(25);
    for (username, password) in [
        ("", "correct horse"),
        (" \u{3000} ", "correct horse"),
        ("al", "correct horse"),
        ("a_b", "correct horse"),
        ("Admin", "correct horse"),
        (" Invite ", "correct horse"),
        ("alice", ""),
        ("alice", seventy_three.as_str()),
        ("alice", cjk_75_bytes.as_str()),
    ] {
        assert_eq!(
            login_username(username, password),
            None,
            "{username:?} {password:?}"
        );
    }
}
