//! API 用戶端：只連同源的 `/api/*`（需求 6.15），解析 `ApiError`（需求 5.5）。
//!
//! 需要 access token 的端點（需求 5.1）以 [`Api`] 送出：帶 `Authorization: Bearer <access token>`，離到期不到 60 秒時先
//! 換發（需求 4.5）；回應 401 時換發一次、以新的 access token 重試同一個請求一次，請求內容不變，所以 Command 沿用原本的
//! Command_Id；重試仍回應 401 時依需求 4.9 處理（需求 4.8）。換發與 Session 的保存都在 `session.rs`。
//!
//! 網址一律是 `/api` 加上這裡組出的路徑（不含 scheme 與主機），由瀏覽器依目前的頁面解析成同源的網址；路徑中來自網址的
//! 值（邀請 token）經 URL 編碼。access token 只放在 `Authorization` 標頭，不放進網址或 cookie（需求 5.6）。
use std::pin::pin;
use std::time::Duration;

use futures::future::{select, Either};
use gloo_net::http::Request;
use gloo_timers::future::TimeoutFuture;
use leptos_router::location::Url;
use lm_core::admin::{
    AdminSettingsResponse, AdminUserDto, AdminUsersResponse, AuditPage, Policy,
    ResetPasswordRequest, UpdateUserRequest,
};
use lm_core::api::{
    ApiError, ChangesResponse, CommandRequest, CommandResponse, CreateTripRequest, HeadResponse,
    InviteCreated, InviteListItem, InvitePreview, JoinRequest, JoinResponse, LoginRequest,
    ProfileDto, RefreshRequest, SessionDto, SignupRequest, SignupResponse, TripSummary,
};
use lm_core::ids::{TripId, UserId};
use lm_core::model::Seq;
use lm_core::sync::Snapshot;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::Serialize;
use uuid::Uuid;

use crate::session::{use_auth, Auth, Refresh};

/// 網路錯誤（例如離線，或沒有收到回應）時的訊息。
const NETWORK_MESSAGE: &str = "無法連線到伺服器，請檢查網路後再試一次。";
/// 送出後沒有在時限內收到回應時的訊息。
const TIMEOUT_MESSAGE: &str = "伺服器沒有及時回應，請檢查網路後再試一次。";
/// 送出後這麼久沒有回應就停止等待，視為逾時（需求 13.9、17.9）。
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// 沒有 Session，或換發後仍被拒絕時的訊息；與 LM_Server 的 401 相同（需求 5.1）。
const UNAUTHORIZED_MESSAGE: &str = "請先登入。";
/// 回應不是預期的格式（例如 gateway 的 502 頁面）時的訊息；與 LM_Server 的 500 相同（需求 5.10）。
const UNEXPECTED_MESSAGE: &str = "伺服器暫時無法處理，請稍後再試。";

/// 請求失敗：LM_Server 的錯誤回應（`ApiError` 的三個欄位加上狀態碼），或沒有收到回應。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiFailure {
    /// HTTP 狀態碼；網路錯誤時是 `None`
    pub status: Option<u16>,
    pub code: String,
    /// 可以直接顯示給使用者的訊息
    pub message: String,
    pub field: Option<String>,
}

impl ApiFailure {
    fn network() -> Self {
        Self {
            status: None,
            code: "network_error".to_owned(),
            message: NETWORK_MESSAGE.to_owned(),
            field: None,
        }
    }

    /// 送出後沒有在時限內收到回應。與網路錯誤相同，沒有狀態碼；LM_Server 可能已經處理了這個請求。
    fn timeout() -> Self {
        Self {
            status: None,
            code: "timeout".to_owned(),
            message: TIMEOUT_MESSAGE.to_owned(),
            field: None,
        }
    }
    /// 網路錯誤或逾時：沒有收到 LM_Server 的回應。
    pub fn is_network(&self) -> bool {
        self.status.is_none()
    }
    /// 沒有可用的 Session：這個分頁沒有 Session、已經登出，或換發被拒絕（已依需求 4.9 處理）。
    fn unauthorized() -> Self {
        Self {
            status: Some(401),
            code: "unauthorized".to_owned(),
            message: UNAUTHORIZED_MESSAGE.to_owned(),
            field: None,
        }
    }

    fn unexpected(status: u16) -> Self {
        Self {
            status: Some(status),
            code: "invalid_response".to_owned(),
            message: UNEXPECTED_MESSAGE.to_owned(),
            field: None,
        }
    }

    fn from_error(status: u16, error: ApiError) -> Self {
        Self {
            status: Some(status),
            code: error.code,
            message: error.message,
            field: error.field,
        }
    }

    /// 網路錯誤、429 或 5xx：之後可以以相同的內容（Command 用同一個 Command_Id）再送一次（需求 4.13、13.9）。
    pub fn is_retryable(&self) -> bool {
        matches!(self.status, None | Some(429) | Some(500..=599))
    }

    /// 401：Session 已失效。`Api` 已換發並重試過，也已依需求 4.9 處理，呼叫端保留 Pending_Command，不顯示這則訊息。
    pub fn is_unauthorized(&self) -> bool {
        self.status == Some(401)
    }
}

#[derive(Clone, Copy, Debug)]
enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

/// 送出一個 `/api` 之下的請求，回傳狀態碼與內容；沒有收到回應時是網路錯誤。`path` 以 `/` 開頭，例如 `/me`。
async fn fetch(
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, String), ApiFailure> {
    debug_assert!(path.starts_with('/') && !path.starts_with("//"));
    let url = format!("/api{path}");
    let mut builder = match method {
        Method::Get => Request::get(&url),
        Method::Post => Request::post(&url),
        Method::Patch => Request::patch(&url),
        Method::Delete => Request::delete(&url),
    };
    if let Some(token) = token {
        builder = builder.header("Authorization", &format!("Bearer {token}"));
    }
    let sent = match body {
        Some(body) => {
            builder
                .header("Content-Type", "application/json")
                .body(body)
                .map_err(|_| ApiFailure::network())?
                .send()
                .await
        }
        None => builder.send().await,
    };
    let response = sent.map_err(|_| ApiFailure::network())?;
    let status = response.status();
    let text = response.text().await.map_err(|_| ApiFailure::network())?;
    Ok((status, text))
}

/// 與 [`fetch`] 相同，但 `timeout` 之內沒有收到回應時停止等待，回報逾時（[`ApiFailure::timeout`]）。
/// 瀏覽器中的請求不會因此取消，所以呼叫端重送時要讓 LM_Server 能辨認是同一個請求（例如同一個旅行 id 或 Command_Id）。
async fn fetch_within(
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
    timeout: Option<Duration>,
) -> Result<(u16, String), ApiFailure> {
    let request = fetch(method, path, token, body);
    let Some(timeout) = timeout else {
        return request.await;
    };
    let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
    match select(pin!(request), pin!(TimeoutFuture::new(millis))).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => Err(ApiFailure::timeout()),
    }
}
/// 2xx 時解析成 `T`；其他狀態碼解析 `ApiError`（需求 5.5），不是這個格式時以狀態碼與通用的訊息回報。
fn decode<T: DeserializeOwned>(status: u16, text: &str) -> Result<T, ApiFailure> {
    if (200..300).contains(&status) {
        return serde_json::from_str(text).map_err(|_| ApiFailure::unexpected(status));
    }
    Err(serde_json::from_str::<ApiError>(text)
        .map(|error| ApiFailure::from_error(status, error))
        .unwrap_or_else(|_| ApiFailure::unexpected(status)))
}

fn to_json(value: &impl Serialize) -> String {
    // lm-core 的請求型別都是普通的 struct 與 enum，序列化不會失敗
    serde_json::to_string(value).expect("API 請求可以序列化成 JSON")
}

/// `POST /api/auth/refresh`（Public_Endpoint，不帶 access token）。由 `session.rs` 的換發使用。
pub(crate) async fn refresh_session(refresh_token: &str) -> Result<SessionDto, ApiFailure> {
    let body = to_json(&RefreshRequest {
        refresh_token: refresh_token.to_owned(),
    });
    let (status, text) = fetch(Method::Post, "/auth/refresh", None, Some(&body)).await?;
    decode(status, &text)
}

/// `POST /api/auth/logout`，以目前的 access token 送出；不換發、401 也不重試（需求 4.8、4.12）。
pub(crate) async fn logout_request(access_token: &str) -> Result<(), ApiFailure> {
    let (status, text) = fetch(Method::Post, "/auth/logout", Some(access_token), None).await?;
    decode::<IgnoredAny>(status, &text).map(|_| ())
}

/// 這個分頁的 API 用戶端。`Copy`，可以直接放進事件處理與 async 區塊。
#[derive(Clone, Copy)]
pub struct Api {
    auth: Auth,
}

/// 取得以 App 的登入狀態送出請求的 API 用戶端。
pub fn use_api() -> Api {
    Api::new(use_auth())
}

// 各端點由之後的畫面與同步引擎（任務 18.5 起）使用
#[allow(dead_code)]
impl Api {
    pub fn new(auth: Auth) -> Self {
        Self { auth }
    }

    /// 需要 access token 的請求（需求 4.5、4.8）。
    async fn authed<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
    ) -> Result<T, ApiFailure> {
        self.authed_within(method, path, body, None).await
    }
    /// 與 [`Api::authed`] 相同；`timeout` 是每一次送出（包括 401 後的重試）等待回應的時限，不包括換發。
    async fn authed_within<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
        timeout: Option<Duration>,
    ) -> Result<T, ApiFailure> {
        let token = self
            .auth
            .access_token()
            .await
            .ok_or_else(ApiFailure::unauthorized)?;
        let (status, text) =
            fetch_within(method, path, Some(&token), body.as_deref(), timeout).await?;
        if status != 401 {
            return decode(status, &text);
        }
        // 換發一次；同時回應 401 的其他請求共用同一個換發（需求 4.8）
        match self.auth.refresh_after_unauthorized(&token).await {
            Refresh::Ok => {}
            Refresh::Rejected => return Err(ApiFailure::unauthorized()),
            // 網路錯誤、429 或 5xx：Session 保留，之後再換發（需求 4.13）
            Refresh::Unavailable(failure) => return Err(failure),
        }
        let token = self
            .auth
            .access_token_now()
            .ok_or_else(ApiFailure::unauthorized)?;
        let (status, text) =
            fetch_within(method, path, Some(&token), body.as_deref(), timeout).await?;
        if status == 401 {
            self.auth.reject_current();
            return Err(ApiFailure::unauthorized());
        }
        decode(status, &text)
    }

    /// Public_Endpoint 的請求：不需要 access token，LM_Server 也不以 401 回應（需求 5.8）。
    async fn public<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<String>,
    ) -> Result<T, ApiFailure> {
        let (status, text) = fetch(method, path, token, body.as_deref()).await?;
        decode(status, &text)
    }

    /// `POST /api/auth/login`。成功時由呼叫端以 `Auth::set()` 保存 Session（需求 4.3）。
    pub async fn login(&self, request: &LoginRequest) -> Result<SessionDto, ApiFailure> {
        self.public(Method::Post, "/auth/login", None, Some(to_json(request)))
            .await
    }

    /// `POST /api/auth/signup`。成功時由呼叫端以 `Auth::set()` 保存 Session（需求 4.3）。
    pub async fn signup(&self, request: &SignupRequest) -> Result<SignupResponse, ApiFailure> {
        self.public(Method::Post, "/auth/signup", None, Some(to_json(request)))
            .await
    }

    /// `GET /api/me`
    pub async fn me(&self) -> Result<ProfileDto, ApiFailure> {
        self.authed(Method::Get, "/me", None).await
    }

    /// `GET /api/trips`
    pub async fn trips(&self) -> Result<Vec<TripSummary>, ApiFailure> {
        self.authed(Method::Get, "/trips", None).await
    }

    /// `POST /api/trips`。每次送出最多等待 [`REQUEST_TIMEOUT`]，逾時與網路錯誤相同（需求 17.9）；旅行 id 由呼叫端
    /// 在開啟表單時產生，重送時 LM_Server 依需求 17.4 回傳已建立的旅行，不會建立第二趟。
    pub async fn create_trip(
        &self,
        request: &CreateTripRequest,
    ) -> Result<TripSummary, ApiFailure> {
        self.authed_within(
            Method::Post,
            "/trips",
            Some(to_json(request)),
            Some(REQUEST_TIMEOUT),
        )
        .await
    }

    /// `DELETE /api/trips/{id}`。每次送出最多等待 [`REQUEST_TIMEOUT`]，逾時與網路錯誤相同（需求 17.10）。
    pub async fn delete_trip(&self, trip: TripId) -> Result<(), ApiFailure> {
        self.authed_within::<IgnoredAny>(
            Method::Delete,
            &format!("/trips/{trip}"),
            None,
            Some(REQUEST_TIMEOUT),
        )
        .await
        .map(|_| ())
    }

    /// `GET /api/trips/{id}/snapshot`
    pub async fn snapshot(&self, trip: TripId) -> Result<Snapshot, ApiFailure> {
        self.authed(Method::Get, &format!("/trips/{trip}/snapshot"), None)
            .await
    }

    /// `GET /api/trips/{id}/changes?after=N`
    pub async fn changes(&self, trip: TripId, after: Seq) -> Result<ChangesResponse, ApiFailure> {
        self.authed(
            Method::Get,
            &format!("/trips/{trip}/changes?after={after}"),
            None,
        )
        .await
    }

    /// `GET /api/trips/{id}/head`
    pub async fn head(&self, trip: TripId) -> Result<Seq, ApiFailure> {
        self.authed::<HeadResponse>(Method::Get, &format!("/trips/{trip}/head"), None)
            .await
            .map(|head| head.seq)
    }

    /// `POST /api/trips/{id}/commands`。請求內容只序列化一次，401 後的重試送出同一份內容與 Command_Id（需求 4.8）。
    /// 每次送出最多等待 [`REQUEST_TIMEOUT`]，逾時與網路錯誤相同，由送出佇列以同一個 Command_Id 重送（需求 13.9）。
    pub async fn command(
        &self,
        trip: TripId,
        request: &CommandRequest,
    ) -> Result<CommandResponse, ApiFailure> {
        self.authed_within(
            Method::Post,
            &format!("/trips/{trip}/commands"),
            Some(to_json(request)),
            Some(REQUEST_TIMEOUT),
        )
        .await
    }

    /// `GET /api/trips/{id}/invites`
    pub async fn invites(&self, trip: TripId) -> Result<Vec<InviteListItem>, ApiFailure> {
        self.authed(Method::Get, &format!("/trips/{trip}/invites"), None)
            .await
    }

    /// `POST /api/trips/{id}/invites`
    pub async fn create_invite(&self, trip: TripId) -> Result<InviteCreated, ApiFailure> {
        self.authed(Method::Post, &format!("/trips/{trip}/invites"), None)
            .await
    }

    /// `POST /api/trips/{id}/invites/{invite_id}/revoke`
    pub async fn revoke_invite(&self, trip: TripId, invite: Uuid) -> Result<(), ApiFailure> {
        self.authed::<IgnoredAny>(
            Method::Post,
            &format!("/trips/{trip}/invites/{invite}/revoke"),
            None,
        )
        .await
        .map(|_| ())
    }

    /// `GET /api/invites/{token}`（Public_Endpoint）：已登入時帶 access token，回應才有 `already_member`（需求 5.8）。
    pub async fn invite_preview(&self, token: &str) -> Result<InvitePreview, ApiFailure> {
        let access_token = self.auth.access_token().await;
        self.public(
            Method::Get,
            &format!("/invites/{}", Url::escape(token)),
            access_token.as_deref(),
            None,
        )
        .await
    }

    /// `POST /api/invites/{token}/join`
    pub async fn join_invite(
        &self,
        token: &str,
        request: &JoinRequest,
    ) -> Result<JoinResponse, ApiFailure> {
        self.authed(
            Method::Post,
            &format!("/invites/{}/join", Url::escape(token)),
            Some(to_json(request)),
        )
        .await
    }

    // ── Admin_Endpoint（需求 34–41，design 5.3）。寫入的請求每次送出最多等待 REQUEST_TIMEOUT，逾時與網路錯誤
    // 相同；重送同樣的內容得到同樣的結果（design 5.4）。

    /// `GET /api/admin/users`
    pub async fn admin_users(&self) -> Result<AdminUsersResponse, ApiFailure> {
        self.authed(Method::Get, "/admin/users", None).await
    }

    /// `PATCH /api/admin/users/{id}`：只送出有變更的欄位（需求 39.2）。
    pub async fn update_user(
        &self,
        user: UserId,
        request: &UpdateUserRequest,
    ) -> Result<AdminUserDto, ApiFailure> {
        self.authed_within(
            Method::Patch,
            &format!("/admin/users/{user}"),
            Some(to_json(request)),
            Some(REQUEST_TIMEOUT),
        )
        .await
    }

    /// `POST /api/admin/users/{id}/password`。新密碼只在請求內容中（需求 36.7）。
    pub async fn reset_password(
        &self,
        user: UserId,
        request: &ResetPasswordRequest,
    ) -> Result<(), ApiFailure> {
        self.authed_within::<IgnoredAny>(
            Method::Post,
            &format!("/admin/users/{user}/password"),
            Some(to_json(request)),
            Some(REQUEST_TIMEOUT),
        )
        .await
        .map(|_| ())
    }

    /// `POST /api/admin/users/{id}/disable`
    pub async fn disable_user(&self, user: UserId) -> Result<AdminUserDto, ApiFailure> {
        self.authed_within(
            Method::Post,
            &format!("/admin/users/{user}/disable"),
            None,
            Some(REQUEST_TIMEOUT),
        )
        .await
    }

    /// `POST /api/admin/users/{id}/enable`
    pub async fn enable_user(&self, user: UserId) -> Result<AdminUserDto, ApiFailure> {
        self.authed_within(
            Method::Post,
            &format!("/admin/users/{user}/enable"),
            None,
            Some(REQUEST_TIMEOUT),
        )
        .await
    }

    /// `GET /api/admin/settings`
    pub async fn admin_settings(&self) -> Result<AdminSettingsResponse, ApiFailure> {
        self.authed(Method::Get, "/admin/settings", None).await
    }

    /// `PATCH /api/admin/settings`，內容為 `{"public_signup": "open"|"closed"}`（需求 37.4）。
    pub async fn set_public_signup(
        &self,
        policy: Policy,
    ) -> Result<AdminSettingsResponse, ApiFailure> {
        let body = serde_json::json!({ "public_signup": policy.as_str() }).to_string();
        self.authed_within(
            Method::Patch,
            "/admin/settings",
            Some(body),
            Some(REQUEST_TIMEOUT),
        )
        .await
    }

    /// `GET /api/admin/audit?page=N`
    pub async fn admin_audit(&self, page: u32) -> Result<AuditPage, ApiFailure> {
        self.authed(Method::Get, &format!("/admin/audit?page={page}"), None)
            .await
    }
}
