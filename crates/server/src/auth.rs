//! 帳號端點（design 3.3 與 A8）：註冊（任務 14.1），以及登入、換發、登出與 `GET /api/me`（任務 14.2）。帳號欄位的
//! 規則在 lm-core 的 `account`，LM_Web 的註冊表單也使用它（需求 3.14）。
//!
//! | 端點 | 身分 | 成功時 |
//! | --- | --- | --- |
//! | `POST /api/auth/signup` | Public_Endpoint | 200 `SignupResponse` |
//! | `POST /api/auth/login` | Public_Endpoint | 200 `SessionDto` |
//! | `POST /api/auth/refresh` | Public_Endpoint | 200 `SessionDto` |
//! | `POST /api/auth/logout` | `AuthUser` | 200 `{}` |
//! | `GET /api/me` | `AuthUser` | 200 `ProfileDto` |
//!
//! 三個 Public_Endpoint 的處理函式不使用 `AuthUser`，所以不看 `Authorization` 標頭：標頭缺少、格式不對，或其中的
//! token 過期、無效都不影響結果（需求 5.8）。登出與 `GET /api/me` 以 `AuthUser` 取得帳號，沒有 Valid_Access_Token
//! 時回應 401 `unauthorized`（需求 5.1）。回應中的帳號資料一律讀自 `app.profiles`（需求 5.6）；`synthetic_email()`
//! 組成 Auth_Service 的 email，`session_dto()` 組成回應的 Session。
//!
//! # 註冊（`POST /api/auth/signup`，需求 3）
//!
//! 請求內容是 `SignupRequest`，不是 JSON、缺少欄位或型別不符時 `ApiJson` 回應 400 `invalid_request`。之後依序處理，
//! 只回應第一個不通過的（需求 3.1）：
//!
//! 1. lm-core 的 `account::check_signup()`：帳號名稱的格式與保留字、顯示名稱、密碼（需求 3.2 至 3.5）。LM_Web 的
//!    註冊表單以同一份規則檢查（需求 3.14）。
//! 2. 沒有邀請而 `LM_PUBLIC_SIGNUP` 是 `false`：不呼叫 Auth_Service（需求 3.7）。
//! 3. 附邀請：`invites::check_usable()` 不加鎖檢查連結是 Active_Invite、旅行沒有被刪除（需求 30.13）；不通過時不呼叫
//!    Auth_Service。這個註冊不受 `LM_PUBLIC_SIGNUP` 影響（需求 30.12）。
//! 4. 以 admin API 建立 email 為 Synthetic_Email、email 已確認的使用者：密碼原樣，`user_metadata` 是
//!    `{"username": <帳號名稱>}`（需求 3.1）。
//! 5. 一個交易：取得 advisory lock，`app.profiles` 沒有任何一列時角色是 admin、否則是 member（需求 3.8、3.9），新增
//!    `app.profiles`（顯示名稱是經 Participant_Name 的值）；附邀請時以 `invites::join_in_tx()` 鎖住旅行、再驗證連結、
//!    檢查旅伴名字與角色、新增綁定這個帳號的旅伴、標記連結已使用並寫入 Change_Set（需求 30.10、30.12）；提交。
//! 6. 交易失敗時（沒有提交，所以也沒有旅伴、Change_Set 與連結的使用紀錄，不推送）刪除步驟 4 的使用者，使這個帳號
//!    名稱可以再註冊，回應原本的錯誤（例如「邀請連結無效或已過期。」）；刪除也失敗時在記錄中寫下
//!    使用者的 id（需求 3.10）。COMMIT 的結果不明時（例如連線在送出 COMMIT 之後中斷），刪除使用者也經
//!    `on delete cascade` 刪除已提交的 `app.profiles`，所以同樣不留下帳號。
//! 7. 以 Synthetic_Email 與原樣的密碼登入取得 Session，回應 200 的 `SignupResponse`；`trip_id` 是附邀請時加入的旅行，
//!    沒有邀請時是 `null`。
//!
//! | 情況 | 狀態 | `code` | `field` | 訊息 |
//! | --- | --- | --- | --- | --- |
//! | 請求內容的格式不正確（需求 5.9） | 400 | `invalid_request` | `null` | 資料格式不正確。 |
//! | 需求 3.2 至 3.5 | 400 | 見 lm-core 的 `account` | 見 lm-core 的 `account` | 見 lm-core 的 `account` |
//! | 沒有邀請而 `LM_PUBLIC_SIGNUP` 是 `false`（需求 3.7） | 403 | `signup_invite_only` | `null` | 目前只接受以邀請連結註冊。 |
//! | 附邀請，連結不存在、已撤銷、已過期、已使用或旅行已被刪除（需求 30.13，步驟 3 或 5） | 404 | `invite_invalid` | `null` | 邀請連結無效或已過期。 |
//! | 附邀請，旅伴名字或角色不符合需求 19.1–19.7（需求 30.15，步驟 5） | 400 或 409 | 見 lm-core 的 `Rejection` | 見 lm-core | 見 lm-core |
//! | Auth_Service 已有這個 email，包括同時進行、先建立使用者的另一個註冊；或 `app.profiles` 已有這個帳號名稱（需求 3.6） | 409 | `username_taken` | `username` | 這個帳號名稱已被使用。 |
//! | Auth_Service 拒收 email、無法連線或回報其他錯誤（需求 3.11）；步驟 3 或 5 的 Database 錯誤（需求 3.10） | 500 | `signup_unavailable` | `null` | 註冊暫時無法使用，請聯絡管理員。 |
//! | 已提交，但無法取得 Session（需求 3.16） | 503 | `signup_login_unavailable` | `null` | 帳號已建立，但暫時無法登入，請稍後到登入頁登入。 |
//!
//! 409 的 `field` 是 `username`，因為錯誤所指的是帳號名稱這個欄位（需求 5.5）。
//!
//! # 登入（`POST /api/auth/login`，需求 4.1、4.2、4.15）
//!
//! 請求內容是 `LoginRequest`。需求 4.2 把帳號名稱或密碼「缺少」也算成帳號或密碼不正確，但 `ApiJson<LoginRequest>`
//! 在缺少欄位時回應 400 `invalid_request`，所以先以 `ApiJson` 解析成 JSON 值，再由 `login_fields()` 讀取兩個欄位：
//!
//! | 請求內容 | 回應 |
//! | --- | --- |
//! | 不是 JSON：`Content-Type` 不是 `application/json`、語法錯誤或超過大小上限（需求 5.9） | 400 `invalid_request` |
//! | 不是 JSON 物件（例如陣列或 `null`），或 `username`、`password` 不是字串也不是 `null`（型別不符，需求 5.9） | 400 `invalid_request` |
//! | `username` 或 `password` 不存在或是 `null`（缺少，需求 4.2） | 401 `invalid_credentials` |
//!
//! 型別不符先於缺少判斷；其他欄位不看。之後依序：
//!
//! 1. lm-core 的 `account::login_username()`：帳號名稱經 Trim_White 並把 A–Z 轉成小寫。正規化後的帳號名稱是空的、
//!    格式不符或是保留字，或密碼是空的、UTF-8 超過 72 位元組時，不呼叫 Auth_Service（需求 4.2）。
//! 2. 以這個帳號名稱的 Synthetic_Email 與原樣（不修剪、不正規化）的密碼呼叫 `password_grant`（需求 4.1）；密碼不正確
//!    或沒有這個 email 時是 `InvalidCredentials`。
//! 3. 讀取 `app.profiles` 中 Session 的使用者：有這一列時回應 `SessionDto`；沒有時與密碼不正確相同（需求 4.2），並
//!    撤銷這個 Session（見「沒有 `app.profiles` 的使用者」）。
//!
//! # 換發（`POST /api/auth/refresh`，需求 4.9、4.15）
//!
//! 請求內容是 `RefreshRequest`；不是 JSON、缺少欄位或型別不符時 `ApiJson` 回應 400 `invalid_request`（需求 5.9）。
//! refresh token 是空字串時不呼叫 Auth_Service；其他以 `refresh` 換發，refresh token 不存在、已撤銷（例如這個裝置
//! 已登出）、在 10 秒的重用間隔之後重複使用，或 Auth_Service 的使用者已刪除時是 `InvalidCredentials`。換發成功之後
//! 與登入的步驟 3 相同：`app.profiles` 沒有這個使用者（Account 已不存在）時回應 401，並撤銷這個 Session。
//!
//! # 登入與換發的錯誤
//!
//! | 情況 | 狀態 | `code` | 訊息 |
//! | --- | --- | --- | --- |
//! | 登入：需求 4.2 的每一種情況，包括 Auth_Service 的使用者沒有 `app.profiles` | 401 | `invalid_credentials` | 帳號或密碼不正確。 |
//! | 換發：refresh token 是空的或被 Auth_Service 拒絕，或 Account 已不存在（需求 4.9） | 401 | `invalid_refresh_token` | 登入已失效，請重新登入。 |
//! | Auth_Service 以速率限制拒絕（需求 4.15） | 429 | `auth_rate_limited` | 嘗試次數過多，暫時無法登入，請稍後再試。 |
//! | Auth_Service 無法連線、10 秒內沒有回應、回應 5xx 或其他沒有對應的錯誤（需求 4.15） | 503 | `auth_unavailable` | 暫時無法登入，請稍後再試。 |
//! | 讀取 `app.profiles` 失敗（需求 5.10） | 500 | `internal_error` | 伺服器暫時無法處理，請稍後再試。 |
//!
//! `field` 都是 `null`。登入的 401 不論原因都是同一個回應，不透露帳號是否存在。換發的 401 不使用 `unauthorized`，讓
//! 記錄與除錯分得出被拒絕的是 refresh token 而不是 access token；LM_Web 只依狀態碼判斷換發被拒絕，並顯示自己的訊息
//! （需求 4.9）。
//!
//! # 沒有 `app.profiles` 的使用者
//!
//! 登入或換發成功，但 `app.profiles` 沒有 Session 的使用者時（例如註冊的補償刪除失敗而留下的使用者，或
//! `app.profiles` 已被刪除的 Account），這個 Session 不交給用戶端，所以另以 `tokio::spawn` 請 Auth_Service 撤銷它
//! （`logout`）；不等待結果，401 不因此延遲，撤銷失敗時只記錄。讀取 `app.profiles` 失敗時不撤銷：換發時 Auth_Service
//! 已輪替 refresh token，用戶端之後仍可以原本的 refresh token 重試（需求 4.13），撤銷會讓它被登出。
//!
//! # 登出（`POST /api/auth/logout`，需求 4.11）
//!
//! 以這個請求的 access token 呼叫 `logout`（`scope=local`）：撤銷這個裝置的 refresh token，也就是這次登入取得的與之後
//! 換發得到的每一個，之後以它們換發得到 401；同一個帳號在其他瀏覽器或裝置的 Session 不受影響。Auth_Service 拒絕
//! （例如這個 Session 已結束）、回應錯誤、無法連線或 10 秒內沒有回應時也回應 200 `{}`；已簽發的 access token 仍可
//! 使用到到期（design R10）。
//!
//! # `GET /api/me`（需求 5.7）
//!
//! `AuthUser` 在每個請求讀取 `app.profiles`，所以回應的是 Database 中這個 Account 目前的 `ProfileDto`。
//!
//! # 用戶端中斷連線時也執行到底
//!
//! 用戶端在收到回應之前中斷連線時，hyper 會丟棄處理函式的 future。
//!
//! - 註冊：若在步驟 4 之後、步驟 5 提交之前被丟棄，步驟 6 的補償不會執行，Auth_Service 留下沒有 `app.profiles` 的
//!   使用者，這個帳號名稱就再也無法註冊（需求 3.6）。所以 `signup_handler()` 以 `tokio::spawn` 在獨立的 task 中執行
//!   整個流程。
//! - 登出：撤銷 refresh token 是登出的目的，所以 `logout_handler()` 也在獨立的 task 中呼叫 `logout`。
//! - 登入與換發不必：被丟棄時用戶端沒有收到新的 Session，Auth_Service 中多出的 Session 不會被使用；換發時用戶端仍
//!   可以原本的 refresh token 重試。
//!
//! # 記錄（需求 3.11、5.10）
//!
//! 記錄不含密碼與 token：不記錄請求內容（`SignupRequest` 與 `RefreshRequest` 的 `Debug` 含密碼或 token），登入被拒絕
//! 時也不記錄送來的帳號名稱，因為使用者可能把密碼打在帳號名稱的欄位；`AuthError` 與 sqlx 的錯誤說明不含密碼與
//! token，`GoTrueSession` 的 `Debug` 不印出 token。500 與 503 的原因以 error 或 warn 層級記下；Auth_Service 拒收
//! email 時指出 `LM_AUTH_EMAIL_DOMAIN`。

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use lm_core::account::{self, Violation};
use lm_core::api::{
    InviteJoin, ProfileDto, RefreshRequest, SessionDto, SignupRequest, SignupResponse,
};
use lm_core::ids::UserId;
use lm_core::model::Role;
use lm_supabase::gotrue::{AuthError, GoTrueSession};
// sqlx 的 JsonValue 就是 serde_json::Value：lm-supabase 的 create_user() 以它接收 user_metadata，登入的請求內容也先
// 解析成它
use sqlx::types::JsonValue;

use crate::config::Config;
use crate::error::ApiError;
use crate::extract::{load_profile, ApiJson, AuthUser};
use crate::invites::{self, JoinError, Joined};
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
    let display_name = account::check_signup(&username, &display_name, &password)?;
    // 2. 需求 3.7
    if invite.is_none() && !st.config.public_signup {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "signup_invite_only",
            "目前只接受以邀請連結註冊。",
        ));
    }
    // 3. 需求 30.13：先不加鎖檢查連結，步驟 5 的交易中會再驗證一次
    if let Some(invite) = &invite {
        invites::check_usable(&st.db, &invite.token)
            .await
            .map_err(join_failed)?;
    }

    // 4. 需求 3.1、3.6、3.11
    let email = synthetic_email(&st.config, &username);
    let meta: JsonValue = [("username", username.as_str())].into_iter().collect();
    let user = st
        .auth
        .create_user(&email, &password, &meta)
        .await
        .map_err(|error| create_user_failed(&st.config, error))?;

    // 5、6. 需求 3.8、3.9、3.10、30.12
    let (role, joined) = match create_profile(st, user, &username, &display_name, invite.as_ref())
        .await
    {
        Ok(created) => created,
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
    if let Some(Joined::Added { trip, seq }) = joined {
        tracing::info!(%trip, %user, seq, "joined a trip with an invite while signing up");
    }

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
        trip_id: joined.map(Joined::trip),
    })
}

/// 步驟 5：在一個交易中新增 `user` 的 `app.profiles`（需求 3.8、3.9），附邀請時以這個帳號加入旅行（需求 30.12），
/// 回傳角色與加入的結果。失敗時交易沒有提交（sqlx 在 `Transaction` 被丟棄時回滾），錯誤已轉成回應
/// （`join_failed()`）。
async fn create_profile(
    st: &AppState,
    user: UserId,
    username: &str,
    display_name: &str,
    invite: Option<&InviteJoin>,
) -> Result<(Role, Option<Joined>), ApiError> {
    let committed: Result<(Role, Option<Joined>), JoinError> = async {
        let mut tx = st.db.begin().await?;
        repo::lock_first_admin(&mut tx).await?;
        let role = if repo::profile_count(&mut tx).await? == 0 {
            Role::Admin
        } else {
            Role::Member
        };
        repo::insert_profile(&mut tx, user, username, display_name, role).await?;
        let joined = match invite {
            Some(invite) => Some(
                invites::join_in_tx(
                    &mut tx,
                    st.clock.as_ref(),
                    user,
                    &invite.token,
                    &invite.name,
                    &invite.role,
                )
                .await?,
            ),
            None => None,
        };
        tx.commit().await?;
        Ok((role, joined))
    }
    .await;
    committed.map_err(join_failed)
}

/// `POST /api/auth/login`（見模組說明的「登入」）。
pub async fn login_handler(
    State(st): State<AppState>,
    ApiJson(body): ApiJson<JsonValue>,
) -> Result<Json<SessionDto>, ApiError> {
    let (Some(username), Some(password)) = login_fields(&body)? else {
        tracing::debug!("login rejected: the username or the password is missing");
        return Err(invalid_credentials());
    };
    // 1. 需求 4.1、4.2
    let Some(username) = account::login_username(username, password) else {
        tracing::debug!("login rejected without asking Auth_Service");
        return Err(invalid_credentials());
    };
    // 2. 需求 4.1、4.2、4.15；密碼原樣
    let email = synthetic_email(&st.config, &username);
    let session = st
        .auth
        .password_grant(&email, password)
        .await
        .map_err(|error| match error {
            AuthError::InvalidCredentials => {
                tracing::debug!("login rejected by Auth_Service");
                invalid_credentials()
            }
            error => auth_unavailable("password_grant", error),
        })?;
    // 3. 需求 4.2
    let Some(profile) = session_profile(&st, &session).await? else {
        return Err(invalid_credentials());
    };
    tracing::info!(user = %profile.id, username = %profile.username, "logged in");
    Ok(Json(session_dto(&st, session, profile)))
}

/// 登入的請求內容中的帳號名稱與密碼（見模組說明的「登入」）：欄位不存在或是 `null` 時是 `None`；內容不是 JSON 物件，
/// 或欄位不是字串也不是 `null` 時是 400 `invalid_request`。
fn login_fields(body: &JsonValue) -> Result<(Option<&str>, Option<&str>), ApiError> {
    if !body.is_object() {
        return Err(ApiError::invalid_request());
    }
    Ok((text_field(body, "username")?, text_field(body, "password")?))
}

/// JSON 物件 `body` 的文字欄位 `name`（見 `login_fields()`）。
fn text_field<'a>(body: &'a JsonValue, name: &str) -> Result<Option<&'a str>, ApiError> {
    match body.get(name) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(text)) => Ok(Some(text)),
        Some(_) => Err(ApiError::invalid_request()),
    }
}

/// `POST /api/auth/refresh`（見模組說明的「換發」）。
pub async fn refresh_handler(
    State(st): State<AppState>,
    ApiJson(request): ApiJson<RefreshRequest>,
) -> Result<Json<SessionDto>, ApiError> {
    if request.refresh_token.is_empty() {
        tracing::debug!("refresh rejected: the refresh token is empty");
        return Err(refresh_rejected());
    }
    let session = st
        .auth
        .refresh(&request.refresh_token)
        .await
        .map_err(|error| match error {
            AuthError::InvalidCredentials => {
                tracing::debug!("refresh rejected by Auth_Service");
                refresh_rejected()
            }
            error => auth_unavailable("refresh", error),
        })?;
    let Some(profile) = session_profile(&st, &session).await? else {
        return Err(refresh_rejected());
    };
    Ok(Json(session_dto(&st, session, profile)))
}

/// 登入或換發得到的 Session 的帳號資料（需求 4.2、4.9）：`app.profiles` 沒有 Session 的使用者時是 `None`，並撤銷這個
/// Session（見模組說明的「沒有 `app.profiles` 的使用者」）；讀取失敗時是 500。
async fn session_profile(
    st: &AppState,
    session: &GoTrueSession,
) -> Result<Option<ProfileDto>, ApiError> {
    let profile = load_profile(&st.db, session.user_id).await?;
    if profile.is_none() {
        let user = session.user_id;
        tracing::warn!(
            %user,
            "Auth_Service user has no app.profiles row, so its session is revoked instead of returned; \
             delete this Auth_Service user if the account was removed"
        );
        let auth = st.auth.clone();
        let access_token = session.access_token.clone();
        tokio::spawn(async move {
            if let Err(error) = auth.logout(&access_token).await {
                tracing::warn!(
                    %user,
                    %error,
                    "could not revoke the session of an Auth_Service user without app.profiles"
                );
            }
        });
    }
    Ok(profile)
}

/// `POST /api/auth/logout`（見模組說明的「登出」）：一律回應 200 `{}`。
pub async fn logout_handler(State(st): State<AppState>, user: AuthUser) -> Json<JsonValue> {
    // 用戶端中斷連線時，這個 future 會被丟棄；spawn 的 task 不會（見模組說明）
    if let Err(error) = tokio::spawn(async move { logout(&st, &user).await }).await {
        tracing::error!(%error, "the logout task failed");
    }
    Json(JsonValue::Object(Default::default()))
}

/// 請 Auth_Service 撤銷 `user` 這個裝置的 refresh token（需求 4.11）；失敗時只記錄。
async fn logout(st: &AppState, user: &AuthUser) {
    match st.auth.logout(user.access_token()).await {
        Ok(()) => tracing::info!(user = %user.id, "logged out"),
        Err(AuthError::InvalidCredentials) => tracing::info!(
            user = %user.id,
            "logged out; Auth_Service refused to revoke the refresh tokens because the session has \
             already ended or the access token has just expired"
        ),
        Err(error) => tracing::warn!(
            user = %user.id,
            %error,
            "logged out, but Auth_Service could not revoke the refresh tokens of this device"
        ),
    }
}

/// `GET /api/me`（需求 5.7）：`AuthUser` 在這個請求讀取的 `app.profiles`。
pub async fn me(user: AuthUser) -> Json<ProfileDto> {
    Json(user.profile())
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

/// 步驟 3 或步驟 5 失敗：連結無效或旅伴名字、角色不通過時回應原本的錯誤；Database 錯誤見 `transaction_failed()`
/// （需求 3.10）。
fn join_failed(error: JoinError) -> ApiError {
    match error {
        JoinError::Rejected(error) => error,
        JoinError::Database(error) => transaction_failed(error),
    }
}

/// 步驟 3 或步驟 5 的 Database 錯誤：`app.profiles` 已有這個帳號名稱時 409（需求 3.6）；其他記下 SQLSTATE 與約束名稱後 500
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

/// 401：登入時需求 4.2 的每一種情況，包括帳號不存在與密碼不正確；每一種的回應都相同。
fn invalid_credentials() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "invalid_credentials",
        "帳號或密碼不正確。",
    )
}

/// 401：refresh token 無法換發 Session，或 Account 已不存在（需求 4.9）。
fn refresh_rejected() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "invalid_refresh_token",
        "登入已失效，請重新登入。",
    )
}

/// 登入與換發時 Auth_Service 無法使用（需求 4.15）：速率限制時 429，其他 503，都不是 401。`call` 是記錄中的呼叫名稱。
fn auth_unavailable(call: &'static str, error: AuthError) -> ApiError {
    if error == AuthError::RateLimited {
        tracing::warn!(call, "Auth_Service rejected the call with its rate limit");
        return ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "auth_rate_limited",
            "嘗試次數過多，暫時無法登入，請稍後再試。",
        );
    }
    tracing::error!(call, %error, "Auth_Service is unavailable");
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "auth_unavailable",
        "暫時無法登入，請稍後再試。",
    )
}

/// 需求 3.2 至 3.5 不通過：400，`code`、`field` 與訊息見 lm-core 的 `account`。
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
