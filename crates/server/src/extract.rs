//! 請求擷取器（design 3.1，需求 5.1、5.2、5.6、5.8、5.9、5.10、6.2、7.20）：每個擷取器失敗時都以 `ApiError` 回應，
//! 所以 `/api/*` 的錯誤一律是 JSON。
//!
//! | 擷取器 | 取得 | 失敗時 |
//! | --- | --- | --- |
//! | `AuthUser` | 以 Valid_Access_Token 登入的帳號 | 401 `unauthorized`；無法讀取 JWKS 或 Database 時 500 |
//! | `Option<AuthUser>` | 同上；沒有 Valid_Access_Token 時是 `None`（邀請預覽，需求 5.8） | 無法讀取 JWKS 或 Database 時 500 |
//! | `AdminUser` | 角色為 admin 的 `AuthUser`（Admin_Endpoint，需求 34.1、34.2，design 5.2） | 同 `AuthUser`；角色不是 admin 時 403 `admin_required` |
//! | `TripPath` | 路徑參數 `{id}` 的旅行 id | 不是 UUID 時 404 `trip_not_found` |
//! | `ApiPath<T>` | 其他路徑參數（包裝 axum 的 `Path`） | 400 `invalid_request` |
//! | `ApiQuery<T>` | 查詢參數（包裝 axum 的 `Query`） | 400 `invalid_request` |
//! | `ApiJson<T>` | JSON 請求內容（包裝 axum 的 `Json`） | 400 `invalid_request` |
//!
//! # 判斷順序與處理函式的參數順序
//!
//! design 3.1 依序判斷，回應第一個不通過的：路徑與方法（`/api` 的 fallback，任務 13.3）→ 登入 → 路徑中的旅行 id →
//! 其他路徑參數、查詢參數與請求內容 → 處理函式。axum 依處理函式的參數順序執行擷取器，回應第一個失敗的擷取器，所以
//! 參數必須依這個順序排列：`AuthUser`（或 `Option<AuthUser>`、`AdminUser`）、`TripPath`、`ApiPath`、`ApiQuery`，最後是 `ApiJson`
//! （axum 規定讀取請求內容的擷取器是最後一個參數）。`State` 不會失敗，位置不限。例如：
//!
//! ```ignore
//! async fn changes(State(st): State<AppState>, user: AuthUser, TripPath(trip): TripPath,
//!     ApiQuery(query): ApiQuery<ChangesQuery>) -> Result<Json<ChangesResponse>, ApiError>
//! async fn commands(State(st): State<AppState>, user: AuthUser, TripPath(trip): TripPath,
//!     ApiJson(request): ApiJson<CommandRequest>) -> Result<Json<CommandResponse>, ApiError>
//! async fn preview(State(st): State<AppState>, user: Option<AuthUser>,
//!     ApiPath(token): ApiPath<String>) -> Result<Json<InvitePreview>, ApiError>
//! ```
//!
//! 因此沒有 Valid_Access_Token 的請求，不論旅行 id、查詢參數或內容是否正確，都得到 401（需求 5.9）；旅行 id 不是
//! UUID 的請求不論內容是否正確，都得到與非成員相同的 404（需求 6.2）。Public_Endpoint 的註冊、登入與換發不使用
//! `AuthUser`，所以不看 `Authorization` 標頭（需求 5.8）。
//!
//! # 登入（需求 5.1、5.2、5.6、5.10）
//!
//! 1. 只讀 `Authorization` 標頭，不讀 cookie 與查詢參數：標頭只能有一個，值必須是 `Bearer`、一個空格與不是空的
//!    token；`bearer` 等大小寫不同的寫法不接受。
//! 2. 以路由器狀態中的 `TokenVerifier`（lm-server 使用 `AnyVerifier`）依系統時間驗證簽章與宣告（需求 5.2–5.4）：
//!    `JwtError::Invalid` 是沒有 Valid_Access_Token；`JwtError::Unavailable`（無法讀取 JWKS）回應 500 並記錄。
//! 3. 讀取 `app.profiles` 中 `user_id` 等於 `sub`、而且 `disabled_at` 是空值的列：沒有這一列（包括 Disabled_Account，
//!    需求 40.4）時是沒有 Valid_Access_Token（需求 5.2）；查詢失敗時回應 500 並記錄。帳號名稱、Display_Name 與角色都
//!    取自這一列，不看 token 的其他宣告（需求 5.6）。
//!
//! 每個請求都重新驗證與讀取，不沿用先前請求的結果（需求 6.1）。記錄不含 token；沒有 Valid_Access_Token 的原因只記
//! 在 debug 層級。`Option<AuthUser>` 只把「沒有 Valid_Access_Token」當成未登入：無法讀取 JWKS 或 Database 時仍回應
//! 500（需求 5.10），不把已登入的使用者當成訪客。
//!
//! # 路由器狀態的要求
//!
//! `AuthUser` 從路由器的狀態 `S` 取得連線池與驗證器，所以 `S` 必須滿足 `PgPool: FromRef<S>` 與
//! `Arc<dyn TokenVerifier>: FromRef<S>`：任務 13.3 的 `AppState` 以 `impl FromRef<AppState> for PgPool` 與
//! `impl FromRef<AppState> for Arc<dyn TokenVerifier>` 回傳欄位的複本。其他擷取器不需要狀態。
//!
//! # 路徑參數
//!
//! 含旅行 id 的路由一律把它寫成 `{id}`（例如 `/trips/{id}/invites/{invite_id}/revoke`），`TripPath` 依名稱讀取，與
//! lm-core 的 `TripId` 一樣接受 uuid 能解析的寫法（例如大寫）。只要有一個路徑參數在百分比解碼後不是 UTF-8，axum 就
//! 不提供任何參數：是 `{id}` 時回應 404 `trip_not_found`；是其他參數時無法得知旅行 id，回應 400 `invalid_request`。
//! 兩者都不依旅行是否存在，所以不洩漏旅行是否存在（需求 6.2）。
//!
//! # 格式錯誤（需求 5.9、7.20）
//!
//! `ApiJson` 在 `Content-Type` 不是 `application/json`（或 `+json`）、JSON 語法錯誤、缺少欄位或型別不符，以及內容超過
//! axum 預設的 2 MB 上限時回應 400 `invalid_request`。lm-core 的 `Input<T>` 欄位把無法解析的值保留為 `Bad`，不會在
//! 這裡失敗，由處理函式依各需求回應那個欄位的訊息。`ApiPath` 與 `ApiQuery` 的值無法解析時也是 400。axum 以 5xx 回報
//! 的是路由設定的程式錯誤（例如 `ApiPath` 的型別與路由的參數數量不符），回應 500 並記錄。axum 對 4xx 的說明可能含有
//! 請求的內容（例如型別不符的密碼），所以不寫進記錄，只在 debug 層級記下 axum 的狀態碼。

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use axum::extract::path::ErrorKind;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{
    FromRef, FromRequest, FromRequestParts, OptionalFromRequestParts, Path, Query, Request,
};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use lm_core::api::ProfileDto;
use lm_core::ids::{TripId, UserId};
use lm_core::model::Role;
use lm_supabase::jwt::{JwtError, TokenVerifier};
use sqlx::types::Uuid;
use sqlx::PgPool;

use crate::error::ApiError;

/// 以 Valid_Access_Token 登入的帳號（需求 5.2、5.6）：只以 token 的 `sub` 辨識，帳號名稱、Display_Name 與角色是
/// 這個請求當下 `app.profiles` 中的資料。沒有 Valid_Access_Token 時回應 401（見模組說明）。`Debug` 不印出 access
/// token。
pub struct AuthUser {
    /// 帳號的 id：access token 的 `sub`，也是 `app.profiles.user_id`。
    pub id: UserId,
    /// `app.profiles.username`。
    pub username: String,
    /// `app.profiles.display_name`。
    pub display_name: String,
    /// `app.profiles.role`。
    pub role: Role,
    /// 這個請求的 access token。
    access_token: String,
}

impl AuthUser {
    /// `GET /api/me` 與 Session 中的帳號資料（需求 5.7）。
    pub fn profile(&self) -> ProfileDto {
        ProfileDto {
            id: self.id,
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            role: self.role,
        }
    }

    /// 這個請求的 access token：只用於登出時請 Auth_Service 撤銷這個裝置的 refresh token（需求 4.11），不能寫進記錄
    /// 或回應。
    pub fn access_token(&self) -> &str {
        &self.access_token
    }
}

impl fmt::Debug for AuthUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthUser")
            .field("id", &self.id)
            .field("username", &self.username)
            .field("display_name", &self.display_name)
            .field("role", &self.role)
            .field("access_token", &format_args!("<redacted>"))
            .finish()
    }
}

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    PgPool: FromRef<S>,
    Arc<dyn TokenVerifier>: FromRef<S>,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        authenticate(parts, state)
            .await?
            .ok_or_else(ApiError::unauthorized)
    }
}

/// `Option<AuthUser>`：沒有 Valid_Access_Token 時是 `None`，不回應 401（邀請預覽，需求 5.8）。
impl<S> OptionalFromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    PgPool: FromRef<S>,
    Arc<dyn TokenVerifier>: FromRef<S>,
{
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> Result<Option<Self>, Self::Rejection> {
        authenticate(parts, state).await
    }
}

/// 模組說明「登入」的步驟：有 Valid_Access_Token 時是 `Some`，沒有時是 `None`；無法讀取 JWKS 或 Database 時是
/// 500 的 `ApiError`（已記錄）。
async fn authenticate<S>(parts: &Parts, state: &S) -> Result<Option<AuthUser>, ApiError>
where
    PgPool: FromRef<S>,
    Arc<dyn TokenVerifier>: FromRef<S>,
{
    let Some(token) = bearer_token(&parts.headers) else {
        tracing::debug!("request has no Authorization: Bearer <token> header");
        return Ok(None);
    };
    let verifier = Arc::<dyn TokenVerifier>::from_ref(state);
    let db = PgPool::from_ref(state);
    let claims = match verifier.verify(token).await {
        Ok(claims) => claims,
        Err(JwtError::Invalid(reason)) => {
            tracing::debug!(%reason, "access token rejected");
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let Some(profile) = load_profile(&db, claims.sub).await? else {
        tracing::debug!(user = %claims.sub, "access token subject has no app.profiles row");
        return Ok(None);
    };
    Ok(Some(AuthUser {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        role: profile.role,
        access_token: token.to_owned(),
    }))
}

/// 角色為 admin 的 `AuthUser`（design 5.2）。`AuthUser` 已依需求 5.1–5.6 驗證 token，並在這個請求中從
/// `app.profiles` 讀取角色與 `disabled_at`，所以 Admin 被降為 member 之後的下一個請求就得到 403（需求 34.1）。
/// 先判斷登入（401）再判斷角色（403），兩者都在 `ApiPath`、`ApiQuery` 與 `ApiJson` 的 400 之前（需求 34.2）。
#[derive(Debug)]
pub struct AdminUser(pub AuthUser);

impl<S> FromRequestParts<S> for AdminUser
where
    S: Send + Sync,
    PgPool: FromRef<S>,
    Arc<dyn TokenVerifier>: FromRef<S>,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // 401 在前（需求 34.2）
        let user = <AuthUser as FromRequestParts<S>>::from_request_parts(parts, state).await?;
        if user.role != Role::Admin {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "admin_required",
                "需要管理員權限。",
            ));
        }
        Ok(Self(user))
    }
}

/// `Authorization: Bearer <token>` 中的 token（需求 5.1）：標頭只能有一個，值必須是 `Bearer`、一個空格與不是空的
/// token；其他寫法是 `None`。
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(AUTHORIZATION).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let token = value.to_str().ok()?.strip_prefix("Bearer ")?;
    (!token.is_empty()).then_some(token)
}

/// `app.profiles` 中 `user_id` 是 `id` 的帳號；沒有這一列，或它是 Disabled_Account（`disabled_at` 不是空值）時是
/// `None`。登入與換發 Session 也以它讀取 Session 的帳號資料（`auth`），所以 Disabled_Account 在 `AuthUser`、登入與
/// 換發三處都等同沒有 `app.profiles`（需求 4.2、4.9、5.2、40.4，design 5.2）。
pub async fn load_profile(db: &PgPool, id: UserId) -> sqlx::Result<Option<ProfileDto>> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "select username, display_name, role from app.profiles \
         where user_id = $1 and disabled_at is null",
    )
    .bind(id.0)
    .fetch_optional(db)
    .await?;
    let Some((username, display_name, role)) = row else {
        return Ok(None);
    };
    // app.profiles 的 CHECK 只允許 admin 與 member
    let role = Role::parse(&role).ok_or_else(|| {
        sqlx::Error::Decode(
            format!("app.profiles.role is neither admin nor member: {role:?}").into(),
        )
    })?;
    Ok(Some(ProfileDto {
        id,
        username,
        display_name,
        role,
    }))
}

/// 路徑參數 `{id}` 的旅行 id（design 3.1 的步驟 3）：不是 UUID 時回應 404「找不到這趟旅行。」，與非成員、旅行不存在
/// 或已刪除的回應完全相同（需求 6.2）。放在 `AuthUser` 之後、`ApiPath`、`ApiQuery` 與 `ApiJson` 之前。
#[derive(Clone, Copy, Debug)]
pub struct TripPath(pub TripId);

/// 旅行 id 的路徑參數名稱：含旅行 id 的路由一律寫成 `/trips/{id}/…`。
const TRIP_ID_PARAM: &str = "id";

impl<S> FromRequestParts<S> for TripPath
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // Path 也實作 OptionalFromRequestParts，所以寫明是哪一個 trait
        let Path(params) =
            <Path<HashMap<String, String>> as FromRequestParts<S>>::from_request_parts(
                parts, state,
            )
            .await
            .map_err(|rejection| trip_path_rejected(&rejection))?;
        let Some(value) = params.get(TRIP_ID_PARAM) else {
            return Err(ApiError::internal(
                "TripPath is used on a route without an {id} path parameter",
            ));
        };
        value
            .parse::<Uuid>()
            .map(|id| Self(TripId(id)))
            .map_err(|_| ApiError::trip_not_found())
    }
}

/// axum 無法提供路徑參數時 `TripPath` 的回應（見模組說明的「路徑參數」）。
fn trip_path_rejected(rejection: &PathRejection) -> ApiError {
    if rejection.status().is_server_error() {
        return ApiError::internal(rejection.body_text());
    }
    match rejection {
        PathRejection::FailedToDeserializePathParams(error) => match error.kind() {
            ErrorKind::InvalidUtf8InPathParam { key } if key != TRIP_ID_PARAM => {
                ApiError::invalid_request()
            }
            _ => ApiError::trip_not_found(),
        },
        _ => ApiError::trip_not_found(),
    }
}

/// 旅行 id 以外的路徑參數：包裝 axum 的 `Path`，值無法解析時回應 400 `invalid_request`（需求 5.9）。
#[derive(Debug)]
pub struct ApiPath<T>(pub T);

impl<T, S> FromRequestParts<S> for ApiPath<T>
where
    Path<T>: FromRequestParts<S, Rejection = PathRejection>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        <Path<T> as FromRequestParts<S>>::from_request_parts(parts, state)
            .await
            .map(|Path(value)| Self(value))
            .map_err(|rejection| malformed(rejection.status(), || rejection.body_text()))
    }
}

/// 查詢參數：包裝 axum 的 `Query`，無法解析時回應 400 `invalid_request`（例如 `after` 不是非負整數，需求 5.9）。
#[derive(Debug)]
pub struct ApiQuery<T>(pub T);

impl<T, S> FromRequestParts<S> for ApiQuery<T>
where
    Query<T>: FromRequestParts<S, Rejection = QueryRejection>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        <Query<T> as FromRequestParts<S>>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|rejection| malformed(rejection.status(), || rejection.body_text()))
    }
}

/// JSON 請求內容：包裝 axum 的 `Json`，格式不正確時回應 400 `invalid_request`（需求 5.9、7.20；見模組說明的「格式
/// 錯誤」）。讀取請求內容，所以必須是處理函式的最後一個參數。
#[derive(Debug)]
pub struct ApiJson<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    Json<T>: FromRequest<S, Rejection = JsonRejection>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        <Json<T> as FromRequest<S>>::from_request(req, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|rejection| malformed(rejection.status(), || rejection.body_text()))
    }
}

/// axum 的擷取器拒絕了請求：5xx 是路由設定的程式錯誤，回應 500 並記錄 axum 的說明（其中沒有請求的內容）；其他都是
/// 請求的格式不正確，回應 400 `invalid_request`，只在 debug 層級記下狀態碼。
fn malformed(status: StatusCode, describe: impl FnOnce() -> String) -> ApiError {
    if status.is_server_error() {
        ApiError::internal(describe())
    } else {
        tracing::debug!(%status, "malformed request rejected");
        ApiError::invalid_request()
    }
}
