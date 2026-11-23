//! `/api/*` 的錯誤回應（design 3.1，需求 5.5、5.9、5.10、7.15）。
//!
//! `ApiError` 是 HTTP 狀態加上 lm-core 的 `api::ApiError` 內容：回應的 `Content-Type` 一律是 `application/json`，內容
//! 只有 `code`、`message` 與 `field` 三個欄位（需求 5.5）。`code` 由小寫英文字母、數字與底線組成、以字母開頭，debug
//! 建置在建立時檢查；`message` 可以直接顯示給使用者，不含 Database、Auth_Service 或程式內部的錯誤文字；`field` 是
//! 錯誤所指的輸入欄位，不屬於單一欄位時是 `null`。回應不含 `Set-Cookie`（需求 5.6）。
//!
//! # 共用的錯誤（`field` 都是 `null`）
//!
//! | 建立方式 | 狀態 | `code` | `message` | 情況 |
//! | --- | --- | --- | --- | --- |
//! | `unauthorized()`、`From<JwtError>` 的 `Invalid` | 401 | `unauthorized` | 請先登入。 | 需求 5.1 |
//! | `api_not_found()` | 404 | `api_not_found` | 找不到這個 API。 | `/api` 的 fallback（任務 13.3，需求 5.9） |
//! | `method_not_allowed()` | 405 | `method_not_allowed` | 不支援這個操作。 | `/api` 的 method-not-allowed fallback |
//! | `invalid_request()` | 400 | `invalid_request` | 資料格式不正確。 | 需求 5.9、7.20 |
//! | `trip_not_found()` | 404 | `trip_not_found` | 找不到這趟旅行。 | 需求 6.2、6.3 |
//! | `internal(原因)`、`From<sqlx::Error>`、`From<JwtError>` 的 `Unavailable` | 500 | `internal_error` | 伺服器暫時無法處理，請稍後再試。 | 需求 5.10、7.16 |
//!
//! 其他需求指定的錯誤（例如註冊的 409 `username_taken`、500「註冊暫時無法使用，請聯絡管理員。」，登入的 503
//! `auth_unavailable` 與 429 `auth_rate_limited`）以 `ApiError::new(狀態, 代碼, 訊息)` 建立，屬於某個欄位時加上
//! `with_field()`。design 虛擬碼中的 `ApiError::forbidden(代碼, 訊息)`、`conflict`、`unavailable` 與兩個參數的
//! `internal` 都寫成 `ApiError::new(StatusCode::…, 代碼, 訊息)`；這裡的 `internal()` 只用於未預期的錯誤。
//!
//! # `Rejection` 的對應（需求 7.15）
//!
//! 狀態與訊息沿用 `Rejection`；400 與 409 保留它的 `code` 與 `field`，沒有代碼的 403 與 404 依訊息補上固定的代碼：
//!
//! | `Rejection` | 狀態 | `code` | `field` |
//! | --- | --- | --- | --- |
//! | `Invalid` | 400 | 它的 `code`（lm-core 一律是 `invalid`） | 它的 `field` |
//! | `Forbidden`，訊息是 `DENY_REMOVAL` | 403 | `deny_removal` | `null` |
//! | `Forbidden`，訊息是 `DENY_PACKING` | 403 | `deny_packing` | `null` |
//! | `Forbidden`，訊息是 `DENY_OTHER_PERSON` | 403 | `deny_other_person` | `null` |
//! | `Forbidden`，訊息是 `DENY_LEDGER_REMOVAL` | 403 | `deny_ledger_removal` | `null` |
//! | `Forbidden`，其他訊息（例如「只能勾選自己的個人裝備或負責的共用裝備。」） | 403 | `forbidden` | `null` |
//! | `NotFound`，訊息是 `TRIP_NOT_FOUND` | 404 | `trip_not_found` | `null` |
//! | `NotFound`，其他訊息（例如「找不到這個活動。」） | 404 | `not_found` | `null` |
//! | `Conflict` | 409 | 它的 `code`（例如 `duplicate_id`、`limit_reached`、`validation_failed`） | `null` |
//!
//! 所以 `Rejection::not_found(TRIP_NOT_FOUND)` 與 `ApiError::trip_not_found()` 的回應完全相同（需求 6.2）。
//!
//! # 記錄（需求 5.10）
//!
//! 500 的錯誤以 tracing 的 error 層級記下原因：`internal()` 記下傳入的原因，`From<sqlx::Error>` 另記下 Postgres 的
//! SQLSTATE 與約束名稱。記錄的只有錯誤本身的說明，不含請求的標頭與內容，所以沒有 access token、refresh token 與
//! 密碼：sqlx 的錯誤說明不含查詢的參數，lm-supabase 的 `JwtError` 與 `AuthError` 也不含秘密。401 的原因只記在 debug
//! 層級。

use std::fmt;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use lm_core::api::ApiError as ErrorBody;
use lm_core::command::{
    Rejection, DENY_LEDGER_REMOVAL, DENY_OTHER_PERSON, DENY_PACKING, DENY_REMOVAL, TRIP_NOT_FOUND,
};
use lm_supabase::jwt::JwtError;

/// `/api/*` 的錯誤回應：HTTP 狀態與 `{code, message, field}`（見模組說明）。
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    /// `status` 的錯誤，`field` 是 `null`。`code` 必須由小寫英文字母、數字與底線組成、以字母開頭（需求 5.5）；
    /// `message` 必須可以直接顯示給使用者。
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self::with_body(status, code, message.into(), None)
    }

    /// 錯誤所指的輸入欄位，例如註冊時的 `username`（需求 5.5）。
    pub fn with_field(mut self, field: &str) -> Self {
        self.body.field = Some(field.to_owned());
        self
    }

    /// 401：沒有 `Authorization: Bearer <token>`，或其中的 token 不是 Valid_Access_Token（需求 5.1）。
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "請先登入。")
    }

    /// 404：`/api/*` 下不存在的路徑（需求 5.9）。
    pub fn api_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "api_not_found", "找不到這個 API。")
    }

    /// 405：路徑存在，但不支援這個方法（需求 5.9）。
    pub fn method_not_allowed() -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "不支援這個操作。",
        )
    }

    /// 400：路徑參數（旅行 id 除外）、查詢參數或請求內容的格式不正確（需求 5.9、7.20）。
    pub fn invalid_request() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "資料格式不正確。",
        )
    }

    /// 404：不是成員、旅行不存在或已刪除，或旅行 id 不是 UUID；這幾種情況的回應完全相同（需求 6.2、6.3）。
    pub fn trip_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "trip_not_found", TRIP_NOT_FOUND)
    }

    /// 500：未預期的錯誤（需求 5.10）。`error` 的 `Display` 以 error 層級寫進記錄，所以不能含 token、密碼與金鑰；
    /// 回應只有固定的訊息。
    pub fn internal(error: impl fmt::Display) -> Self {
        tracing::error!(%error, "unexpected error while handling an API request");
        Self::internal_error()
    }

    /// 500 `internal_error` 的回應本身；呼叫端負責記錄原因。
    fn internal_error() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "伺服器暫時無法處理，請稍後再試。",
        )
    }

    fn with_body(status: StatusCode, code: &str, message: String, field: Option<String>) -> Self {
        debug_assert!(
            is_code(code),
            "錯誤代碼必須由小寫英文字母、數字與底線組成、以字母開頭：{code:?}"
        );
        Self {
            status,
            body: ErrorBody {
                code: code.to_owned(),
                message,
                field,
            },
        }
    }
}

impl IntoResponse for ApiError {
    /// `Json` 設定 `Content-Type: application/json`；內容只有字串與 `null`，序列化不會失敗。
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

/// 命令被拒絕（需求 7.15）：對應見模組說明。
impl From<Rejection> for ApiError {
    fn from(rejection: Rejection) -> Self {
        match rejection {
            Rejection::Invalid {
                code,
                field,
                message,
            } => Self::with_body(StatusCode::BAD_REQUEST, &code, message, field),
            Rejection::Forbidden { message } => Self::with_body(
                StatusCode::FORBIDDEN,
                forbidden_code(&message),
                message,
                None,
            ),
            Rejection::NotFound { message } => Self::with_body(
                StatusCode::NOT_FOUND,
                not_found_code(&message),
                message,
                None,
            ),
            Rejection::Conflict { code, message } => {
                Self::with_body(StatusCode::CONFLICT, &code, message, None)
            }
        }
    }
}

/// Database 無法使用、查詢失敗或提交時約束檢查失敗（需求 5.10、7.16）：記錄錯誤，回應 500。
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        match error.as_database_error() {
            Some(database) => tracing::error!(
                %error,
                sqlstate = database.code().as_deref(),
                constraint = database.constraint(),
                "database error while handling an API request"
            ),
            None => tracing::error!(%error, "database error while handling an API request"),
        }
        Self::internal_error()
    }
}

/// access token 驗證失敗：無效的 token 回應 401（需求 5.1），無法讀取 JWKS 時回應 500 並記錄（需求 5.10）。
impl From<JwtError> for ApiError {
    fn from(error: JwtError) -> Self {
        match error {
            JwtError::Invalid(reason) => {
                tracing::debug!(%reason, "access token rejected");
                Self::unauthorized()
            }
            JwtError::Unavailable(_) => Self::internal(error),
        }
    }
}

/// 403 的代碼：lm-core 共用的拒絕文案各有一個代碼，其他是 `forbidden`。
fn forbidden_code(message: &str) -> &'static str {
    match message {
        DENY_REMOVAL => "deny_removal",
        DENY_PACKING => "deny_packing",
        DENY_OTHER_PERSON => "deny_other_person",
        DENY_LEDGER_REMOVAL => "deny_ledger_removal",
        _ => "forbidden",
    }
}

/// 404 的代碼：「找不到這趟旅行。」是 `trip_not_found`，找不到旅行中的某一列是 `not_found`。
fn not_found_code(message: &str) -> &'static str {
    match message {
        TRIP_NOT_FOUND => "trip_not_found",
        _ => "not_found",
    }
}

/// 需求 5.5 的代碼格式：小寫英文字母開頭，其餘是小寫英文字母、數字或底線。
fn is_code(code: &str) -> bool {
    let mut chars = code.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
