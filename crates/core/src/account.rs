//! 帳號欄位的規則：註冊時的帳號名稱、顯示名稱與密碼（需求 3.2 至 3.5），以及登入時的帳號名稱與密碼（需求 4.1、
//! 4.2）。LM_Server 的註冊與登入，和 LM_Web 的註冊表單（需求 3.14），都以這裡的規則檢查（需求 1.3、1.5）。
//!
//! 只依賴 `text` 與 `limits`，不讀取 Database 或 Auth_Service；每個規則都有固定的 `code`、`field` 與訊息。
//!
//! # 註冊（需求 3.1 至 3.5、3.14）
//!
//! `check_signup()` 依下表的順序檢查，回傳第一個不通過的規則（`Violation`）：
//!
//! | 依序檢查 | 不通過時的 `code` | `field` | 訊息 |
//! | --- | --- | --- | --- |
//! | 帳號名稱原樣符合 `^[a-z][a-z0-9-]{2,31}$`，不去除空白也不轉換大小寫（需求 3.2） | `invalid_username` | `username` | 帳號名稱需為 3–32 個字元：以小寫英文字母開頭，只能使用小寫英文字母、數字或連字號（-）。 |
//! | 帳號名稱不是保留字（需求 3.3） | `reserved_username` | `username` | 這個帳號名稱是系統保留字，請換一個。 |
//! | 顯示名稱經 Participant_Name 後是 1–30 個字、沒有 Hidden_Control_Char，而且 Participant_Key 經 Trim_White 後不是空的（需求 3.4） | `invalid_display_name` | `display_name` | 請填寫 1–30 個字的顯示名稱，不能只有空白或包含隱藏控制字元。 |
//! | 原樣的密碼（不去除空白、不做 Unicode 正規化）是 12–72 個字元，而且 UTF-8 不超過 72 位元組（需求 3.5） | `invalid_password` | `password` | 密碼需為 12–72 個字元，而且不超過 72 個位元組（一個中文字占 3 個位元組）。 |
//!
//! - LM_Server 原樣檢查請求中的帳號名稱與密碼，所以 `Alice` 與 ` alice` 都不符合格式（需求 3.2）。
//! - LM_Web 的註冊表單先以 `normalize_username()` 處理帳號名稱（密碼不做任何修改），再以 `check_signup()` 檢查，最後
//!   確認兩次輸入的密碼完全相同，不同時顯示 `PASSWORD_MISMATCH`（需求 3.14）。
//!
//! # 登入（需求 4.1、4.2）
//!
//! `login_username()` 以 `normalize_username()`（Trim_White，再把 A–Z 轉成小寫）處理帳號名稱，密碼原樣。正規化後的
//! 帳號名稱不通過 `check_username()`（空字串、格式不符或是保留字），或密碼是空的、UTF-8 超過 72 位元組時，沒有任何
//! 帳號能以這組帳號名稱與密碼登入，結果是 `None`：LM_Server 不詢問 Auth_Service，回應與密碼不正確相同的 401。密碼的
//! 字數不在這裡檢查，例如少於 12 個字元的密碼由 Auth_Service 判斷是否正確。

use crate::limits::{DISPLAY_NAME_CHARS, PASSWORD_CHARS, PASSWORD_MAX_BYTES, USERNAME_CHARS};
use crate::text::{char_count, has_control_chars, participant_key, participant_name, trim_white};

/// 保留的帳號名稱（需求 3.3）：現行的 8 個，加上 `invite`，因為 `/invite/<token>` 與 `/<帳號名稱>/home` 共用第一段
/// 路徑。每一個都符合帳號名稱的格式，所以格式之後才檢查。
pub const RESERVED_USERNAMES: [&str; 9] = [
    "api", "admin", "setup", "login", "register", "logout", "demo", "assets", "invite",
];

/// 兩次輸入的密碼不同時，LM_Web 的註冊表單顯示的訊息（需求 3.14）。註冊的請求只有一個密碼，所以 LM_Server 不使用。
pub const PASSWORD_MISMATCH: &str = "兩次輸入的密碼不一致。";

/// 不通過的規則（見模組說明的表）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Violation {
    /// 帳號名稱不符合格式（需求 3.2）。
    UsernameFormat,
    /// 帳號名稱是保留字（需求 3.3）。
    UsernameReserved,
    /// 顯示名稱（需求 3.4）。
    DisplayName,
    /// 密碼（需求 3.5）。
    Password,
}

impl Violation {
    /// 錯誤回應的 `code`（需求 5.5）。
    pub const fn code(self) -> &'static str {
        match self {
            Violation::UsernameFormat => "invalid_username",
            Violation::UsernameReserved => "reserved_username",
            Violation::DisplayName => "invalid_display_name",
            Violation::Password => "invalid_password",
        }
    }

    /// 錯誤回應的 `field`：`SignupRequest` 中的欄位名稱。
    pub const fn field(self) -> &'static str {
        match self {
            Violation::UsernameFormat | Violation::UsernameReserved => "username",
            Violation::DisplayName => "display_name",
            Violation::Password => "password",
        }
    }

    /// 給使用者看的訊息。
    pub const fn message(self) -> &'static str {
        match self {
            Violation::UsernameFormat => {
                "帳號名稱需為 3–32 個字元：以小寫英文字母開頭，只能使用小寫英文字母、數字或連字號（-）。"
            }
            Violation::UsernameReserved => "這個帳號名稱是系統保留字，請換一個。",
            Violation::DisplayName => {
                "請填寫 1–30 個字的顯示名稱，不能只有空白或包含隱藏控制字元。"
            }
            Violation::Password => {
                "密碼需為 12–72 個字元，而且不超過 72 個位元組（一個中文字占 3 個位元組）。"
            }
        }
    }
}

/// 依需求 3.2 至 3.5 的順序檢查註冊的三個欄位，回傳第一個不通過的規則；都通過時回傳經 Participant_Name 的顯示名稱
/// （存進 `app.profiles` 的值，需求 3.1）。帳號名稱與密碼都原樣檢查。
pub fn check_signup(
    username: &str,
    display_name: &str,
    password: &str,
) -> Result<String, Violation> {
    check_username(username)?;
    let display_name = check_display_name(display_name)?;
    check_password(password)?;
    Ok(display_name)
}

/// 帳號名稱（需求 3.2、3.3）：原樣比對 `^[a-z][a-z0-9-]{2,31}$`（`Alice`、` alice` 與空字串都不符合），再檢查保留字。
pub fn check_username(username: &str) -> Result<(), Violation> {
    let mut chars = username.chars();
    let format = USERNAME_CHARS.contains(&char_count(username))
        && chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !format {
        return Err(Violation::UsernameFormat);
    }
    if RESERVED_USERNAMES.contains(&username) {
        return Err(Violation::UsernameReserved);
    }
    Ok(())
}

/// 顯示名稱（需求 3.4）：經 Participant_Name 之後檢查，回傳正規化後的名稱。只有空白、全形空白或 U+3164 這類
/// Default_Ignorable_Code_Point 的名稱，Participant_Key 經 Trim_White 後是空的。
pub fn check_display_name(display_name: &str) -> Result<String, Violation> {
    let name = participant_name(display_name);
    let valid = DISPLAY_NAME_CHARS.contains(&char_count(&name))
        && !has_control_chars(&name)
        && !trim_white(&participant_key(&name)).is_empty();
    if valid {
        Ok(name)
    } else {
        Err(Violation::DisplayName)
    }
}

/// 密碼（需求 3.5）：原樣是 12–72 個字元，而且 UTF-8 不超過 72 位元組（例如 25 個中文字是 75 位元組，不通過）。
pub fn check_password(password: &str) -> Result<(), Violation> {
    if PASSWORD_CHARS.contains(&char_count(password)) && password.len() <= PASSWORD_MAX_BYTES {
        Ok(())
    } else {
        Err(Violation::Password)
    }
}

/// 登入與 LM_Web 註冊表單的帳號名稱（需求 3.14、4.1）：Trim_White，再把 A–Z 轉成小寫；其他字元不變，包括全形的
/// 英文字母。例如 `"  Alice "` 與 `"\u{3000}ALICE\u{3000}"` 都成為 `"alice"`。
pub fn normalize_username(username: &str) -> String {
    trim_white(username).to_ascii_lowercase()
}

/// 登入時以 Synthetic_Email 送給 Auth_Service 的帳號名稱（需求 4.1、4.2）：`normalize_username()` 的結果。正規化後
/// 的帳號名稱不通過 `check_username()`，或密碼是空的、UTF-8 超過 72 位元組時是 `None`（見模組說明的「登入」）。
pub fn login_username(username: &str, password: &str) -> Option<String> {
    let username = normalize_username(username);
    let password_possible = !password.is_empty() && password.len() <= PASSWORD_MAX_BYTES;
    (password_possible && check_username(&username).is_ok()).then_some(username)
}
