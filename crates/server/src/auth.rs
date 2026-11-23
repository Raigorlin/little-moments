//! 帳號端點（design 3.3 與 A8）：註冊（任務 14.1）。登入、換發、登出與 `GET /api/me` 由任務 14.2 加入，以這裡的
//! `synthetic_email()` 組成 email、以 `session_dto()` 組成回應的 Session。
//!
//! # 註冊（`POST /api/auth/signup`，需求 3）
//!
//! Public_Endpoint：不使用 `AuthUser`，所以不看 `Authorization` 標頭（需求 5.8）。請求內容是 `SignupRequest`，不是
//! JSON、缺少欄位或型別不符時 `ApiJson` 回應 400 `invalid_request`。之後依序處理，只回應第一個不通過的（需求 3.1）：
//!
//! 1. `account_rules::check_signup()`：帳號名稱的格式與保留字、顯示名稱、密碼（需求 3.2 至 3.5）。
//! 2. 沒有邀請而 `LM_PUBLIC_SIGNUP` 是 `false`：不呼叫 Auth_Service（需求 3.7）。
//! 3. 附邀請：任務 16.1 改成檢查連結（需求 30.13），並在步驟 5 的交易中加入旅行；在那之前一律回應 501，不呼叫
//!    Auth_Service，所以 `LM_PUBLIC_SIGNUP` 是 `false` 時也不能以任意的邀請註冊。
//! 4. 以 admin API 建立 email 為 Synthetic_Email、email 已確認的使用者：密碼原樣，`user_metadata` 是
//!    `{"username": <帳號名稱>}`（需求 3.1）。
//! 5. 一個交易：取得 advisory lock，`app.profiles` 沒有任何一列時角色是 admin、否則是 member（需求 3.8、3.9），新增
//!    `app.profiles`（顯示名稱是經 Participant_Name 的值），提交。
//! 6. 交易失敗時（沒有提交）刪除步驟 4 的使用者，使這個帳號名稱可以再註冊，回應原本的錯誤；刪除也失敗時在記錄中寫下
//!    使用者的 id（需求 3.10）。COMMIT 的結果不明時（例如連線在送出 COMMIT 之後中斷），刪除使用者也經
//!    `on delete cascade` 刪除已提交的 `app.profiles`，所以同樣不留下帳號。
//! 7. 以 Synthetic_Email 與原樣的密碼登入取得 Session，回應 200 的 `SignupResponse`；`trip_id` 在任務 16.1 之前一律
//!    是 `null`。
//!
//! | 情況 | 狀態 | `code` | `field` | 訊息 |
//! | --- | --- | --- | --- | --- |
//! | 請求內容的格式不正確（需求 5.9） | 400 | `invalid_request` | `null` | 資料格式不正確。 |
//! | 需求 3.2 至 3.5 | 400 | 見 `account_rules` | 見 `account_rules` | 見 `account_rules` |
//! | 沒有邀請而 `LM_PUBLIC_SIGNUP` 是 `false`（需求 3.7） | 403 | `signup_invite_only` | `null` | 目前只接受以邀請連結註冊。 |
//! | 附邀請（任務 16.1 之前） | 501 | `not_implemented` | `null` | 以邀請連結註冊尚未提供。 |
//! | Auth_Service 已有這個 email，包括同時進行、先建立使用者的另一個註冊；或 `app.profiles` 已有這個帳號名稱（需求 3.6） | 409 | `username_taken` | `username` | 這個帳號名稱已被使用。 |
//! | Auth_Service 拒收 email、無法連線或回報其他錯誤（需求 3.11）；步驟 5 的 Database 錯誤（需求 3.10） | 500 | `signup_unavailable` | `null` | 註冊暫時無法使用，請聯絡管理員。 |
//! | 已提交，但無法取得 Session（需求 3.16） | 503 | `signup_login_unavailable` | `null` | 帳號已建立，但暫時無法登入，請稍後到登入頁登入。 |
//!
//! 409 的 `field` 是 `username`，因為錯誤所指的是帳號名稱這個欄位（需求 5.5）。
//!
//! # 用戶端中斷連線時也執行到底
//!
//! 用戶端在收到回應之前中斷連線時，hyper 會丟棄處理函式的 future。若在步驟 4 之後、步驟 5 提交之前被丟棄，步驟 6 的
//! 補償不會執行，Auth_Service 留下沒有 `app.profiles` 的使用者，這個帳號名稱就再也無法註冊（需求 3.6）。所以
//! `signup_handler()` 以 `tokio::spawn` 在獨立的 task 中執行整個流程。
//!
//! # 記錄（需求 3.11、5.10）
//!
//! 記錄不含密碼與 token：`SignupRequest` 的 `Debug` 含密碼，所以不記錄請求；`AuthError` 與 sqlx 的錯誤說明也不含
//! 密碼。500 與 503 的原因以 error 或 warn 層級記下；Auth_Service 拒收 email 時指出 `LM_AUTH_EMAIL_DOMAIN`。

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use lm_core::api::{ProfileDto, SessionDto, SignupRequest, SignupResponse};
use lm_core::ids::UserId;
use lm_core::model::Role;
use lm_supabase::gotrue::{AuthError, GoTrueSession};
// sqlx 的 JsonValue 就是 serde_json::Value，lm-supabase 的 create_user() 以它接收 user_metadata
use sqlx::types::JsonValue;

use crate::account_rules::{self, Violation};
use crate::config::Config;
use crate::error::ApiError;
use crate::extract::ApiJson;
use crate::repo;
use crate::state::AppState;

/// `POST /api/auth/signup`（見模組說明）。
pub async fn signup_handler(
    State(st): State<AppState>,
    ApiJson(request): ApiJson<SignupRequest>,
) -> Result<Json<SignupResponse>, ApiError> {
    // 用戶端中斷連線時，這個 future 會被丟棄；spawn 的 task 不會（見模組說明）
    match tokio::spawn(async move { signup(&st, request).await }).await {
        Ok(result) => result.map(Json),
        Err(error) => Err(ApiError::internal(error)),
    }
}

/// 註冊的流程：模組說明的步驟 1 至 7。
async fn signup(st: &AppState, request: SignupRequest) -> Result<SignupResponse, ApiError> {
    let SignupRequest {
        username,
        display_name,
        password,
        invite,
    } = request;
    // 1. 需求 3.2 至 3.5；帳號名稱與密碼都原樣使用
    let display_name = account_rules::check_signup(&username, &display_name, &password)?;
    // 2. 需求 3.7
    if invite.is_none() && !st.config.public_signup {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "signup_invite_only",
            "目前只接受以邀請連結註冊。",
        ));
    }
    // 3. 任務 16.1 換成 invites::check_usable()（需求 30.13），並在 create_profile() 的交易中加入旅行
    if invite.is_some() {
        return Err(ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            "not_implemented",
            "以邀請連結註冊尚未提供。",
        ));
    }

    // 4. 需求 3.1、3.6、3.11
    let email = synthetic_email(&st.config, &username);
    let meta: JsonValue = [("username", username.as_str())].into_iter().collect();
    let user = st
        .auth
        .create_user(&email, &password, &meta)
        .await
        .map_err(|error| create_user_failed(&st.config, error))?;

    // 5、6. 需求 3.8、3.9、3.10
    let role = match create_profile(st, user, &username, &display_name).await {
        Ok(role) => role,
        Err(error) => {
            if let Err(delete_error) = st.auth.delete_user(user).await {
                tracing::error!(
                    %user,
                    error = %delete_error,
                    "could not delete the Auth_Service user after the signup transaction failed; \
                     delete this user so that the username can be registered again"
                );
            }
            return Err(error);
        }
    };
    tracing::info!(%user, %username, role = role.as_str(), "account created");

    // 7. 交易已提交：取得 Session 失敗時保留帳號（需求 3.16）
    let session = st
        .auth
        .password_grant(&email, &password)
        .await
        .map_err(|error| {
            tracing::warn!(%user, %error, "account created, but the password grant failed");
            signup_login_unavailable()
        })?;
    if session.user_id != user {
        tracing::error!(
            %user,
            session_user = %session.user_id,
            "the password grant after signup returned a session for another user"
        );
        return Err(signup_login_unavailable());
    }
    let profile = ProfileDto {
        id: user,
        username,
        display_name,
        role,
    };
    Ok(SignupResponse {
        session: session_dto(st, session, profile),
        trip_id: None,
    })
}

/// 步驟 5：在一個交易中新增 `user` 的 `app.profiles`，回傳角色（需求 3.8、3.9）。失敗時交易沒有提交（sqlx 在
/// `Transaction` 被丟棄時回滾），錯誤已轉成回應（`transaction_failed()`）。
async fn create_profile(
    st: &AppState,
    user: UserId,
    username: &str,
    display_name: &str,
) -> Result<Role, ApiError> {
    let committed: sqlx::Result<Role> = async {
        let mut tx = st.db.begin().await?;
        repo::lock_first_admin(&mut tx).await?;
        let role = if repo::profile_count(&mut tx).await? == 0 {
            Role::Admin
        } else {
            Role::Member
        };
        repo::insert_profile(&mut tx, user, username, display_name, role).await?;
        tx.commit().await?;
        Ok(role)
    }
    .await;
    committed.map_err(transaction_failed)
}

/// Synthetic_Email：`<帳號名稱>@<LM_AUTH_EMAIL_DOMAIN>`（需求 3.1、3.12）。
pub fn synthetic_email(config: &Config, username: &str) -> String {
    format!("{username}@{}", config.auth_email_domain)
}

/// 回應中的 Session：Auth_Service 的 token、到期時間（Unix 秒；Auth_Service 沒有回傳時以目前時間加上有效秒數），以及
/// `session.user_id` 的帳號資料 `user`。
pub fn session_dto(st: &AppState, session: GoTrueSession, user: ProfileDto) -> SessionDto {
    let now_unix = st.clock.now_ms().div_euclid(1000);
    SessionDto {
        expires_at: session.expiry(now_unix),
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user,
    }
}

/// 步驟 4 失敗（需求 3.6、3.11）：email 已存在時 409；其他記錄原因後 500。
fn create_user_failed(config: &Config, error: AuthError) -> ApiError {
    match error {
        AuthError::AlreadyExists => {
            tracing::debug!("signup rejected: Auth_Service already has this email");
            username_taken()
        }
        AuthError::InvalidEmail => {
            tracing::error!(
                %error,
                domain = %config.auth_email_domain,
                "Auth_Service rejected the synthetic email; LM_AUTH_EMAIL_DOMAIN is probably misconfigured"
            );
            signup_unavailable()
        }
        error => {
            tracing::error!(%error, "Auth_Service could not create the user for a signup");
            signup_unavailable()
        }
    }
}

/// 步驟 5 的 Database 錯誤：`app.profiles` 已有這個帳號名稱時 409（需求 3.6）；其他記下 SQLSTATE 與約束名稱後 500
/// （需求 3.10）。
fn transaction_failed(error: sqlx::Error) -> ApiError {
    if repo::is_username_taken(&error) {
        tracing::info!("signup rejected: app.profiles already has this username");
        return username_taken();
    }
    match error.as_database_error() {
        Some(database) => tracing::error!(
            %error,
            sqlstate = database.code().as_deref(),
            constraint = database.constraint(),
            "signup transaction failed"
        ),
        None => tracing::error!(%error, "signup transaction failed"),
    }
    signup_unavailable()
}

/// 409：帳號名稱已被使用（需求 3.6）。
fn username_taken() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "username_taken",
        "這個帳號名稱已被使用。",
    )
    .with_field("username")
}

/// 500：Auth_Service 或 Database 無法完成註冊（需求 3.10、3.11）。
fn signup_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "signup_unavailable",
        "註冊暫時無法使用，請聯絡管理員。",
    )
}

/// 503：帳號已建立，但無法取得 Session（需求 3.16）。
fn signup_login_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "signup_login_unavailable",
        "帳號已建立，但暫時無法登入，請稍後到登入頁登入。",
    )
}

/// 需求 3.2 至 3.5 不通過：400，`code`、`field` 與訊息見 `account_rules`。
impl From<Violation> for ApiError {
    fn from(violation: Violation) -> Self {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            violation.code(),
            violation.message(),
        )
        .with_field(violation.field())
    }
}
