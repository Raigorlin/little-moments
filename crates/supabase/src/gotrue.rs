//! Auth_Service（GoTrue）的 REST 呼叫（design 2.2）：lm-server 只經 `AuthBackend` 建立與刪除使用者、以密碼登入、
//! 換發與登出（需求 1.6），`GoTrueHttp` 以 reqwest 實作它。feature `server`，只由 lm-server 啟用（需求 1.10）。
//!
//! # 呼叫
//!
//! | 方法 | 請求 | 金鑰 | 成功時 |
//! | --- | --- | --- | --- |
//! | `create_user` | `POST /auth/v1/admin/users`，內容 `{"email", "password", "email_confirm": true, "user_metadata"}` | `apikey` 與 `Authorization: Bearer` 都是 service key | 200，回傳新使用者的 `id` |
//! | `delete_user` | `DELETE /auth/v1/admin/users/{id}` | 同上 | 200 `{}` |
//! | `password_grant` | `POST /auth/v1/token?grant_type=password`，內容 `{"email", "password"}` | `apikey` 是 anon key | 200，Session |
//! | `refresh` | `POST /auth/v1/token?grant_type=refresh_token`，內容 `{"refresh_token"}` | `apikey` 是 anon key | 200，Session |
//! | `logout` | `POST /auth/v1/logout?scope=local`，沒有內容 | `apikey` 是 anon key，`Authorization: Bearer` 是使用者的 access token | 204 |
//!
//! 密碼原樣送出，不修剪也不正規化（需求 4.1）。每個呼叫從開始連線到讀完回應最多 10 秒，逾時是 `Upstream`（需求 4.11、
//! 4.15）。`GoTrueHttp` 不跟隨重新導向，所以金鑰不會被送到其他位址；也不使用 `HTTP_PROXY`、`HTTPS_PROXY` 等環境變數
//! 指定的代理：Supabase_Stack 只綁 127.0.0.1，與 Database 連線及 Realtime 轉送一樣直接連線。
//!
//! # 錯誤的對應
//!
//! GoTrue 的錯誤回應是 `{"code": <HTTP 狀態>, "error_code": "<錯誤代碼>", "msg": "<說明>"}`，並以 `x-sb-error-code`
//! 標頭重複錯誤代碼（任務 12.5 在 CLI 3.2.0、GoTrue v2.198.0 實測）。這裡依錯誤代碼分類：取 `error_code`，沒有時取
//! 標頭，再沒有時取 OAuth 格式的 `error`；不依數字的 `code` 與 `msg`。例外有兩個：`create_user` 的
//! `validation_failed` 涵蓋拒收 email 與密碼超過 72 個位元組，所以另看 `msg` 是否提到 email address；GoTrue 原樣轉出
//! Postgres 的錯誤時，內容是 `{"code": "<SQLSTATE>", "message": …}`，這時取字串的 `code`。
//!
//! | 呼叫 | 回應 | 結果 |
//! | --- | --- | --- |
//! | 全部 | 429（`over_request_rate_limit` 等） | `RateLimited` |
//! | `create_user` | 500，內容是 GoTrue 原樣轉出的 Postgres 錯誤 `{"code": "23505", …}`：同時建立同一個 email 時後寫入的那一個 | `AlreadyExists` |
//! | 全部 | 其他 5xx | `Upstream` |
//! | `create_user` | 422 `email_exists`（`user_already_exists` 相同） | `AlreadyExists` |
//! | `create_user` | 400 `validation_failed` 而且 `msg` 提到 email address（格式不符、超過 255 個字元），或 400 `email_address_invalid` | `InvalidEmail` |
//! | `create_user` | 422 `weak_password` | `WeakPassword`，內容是 `weak_password.reasons`，例如 `length` |
//! | `delete_user` | 404 `user_not_found` | `Ok(())`：使用者已不存在，與刪除成功相同；需求 3.10 的補償只需要這個帳號名稱可以再註冊 |
//! | `password_grant` | 400 `invalid_credentials`（密碼不正確、email 不存在、密碼是空的或超過 72 個位元組） | `InvalidCredentials` |
//! | `refresh` | 400 `refresh_token_not_found`（不存在、已登出或使用者已刪除）、`refresh_token_already_used`（被輪替掉的 refresh token 在 10 秒的重用間隔之後再用）、`session_not_found`、`session_expired`，以及 `validation_failed`（格式不符，包括空字串） | `InvalidCredentials` |
//! | `logout` | 401 `no_authorization`（token 是空的）、403 `bad_jwt`（簽章不符或已過期）、`session_not_found`（已登出）、`user_not_found`（使用者已刪除） | `InvalidCredentials` |
//! | 全部 | 其他非 2xx，例如 service key 有誤時 admin API 的 403 `bad_jwt` 或 `not_admin`、`create_user` 的密碼超過 72 個位元組（400 `validation_failed`）、重新導向 | `Upstream` |
//! | 全部 | 無法連線、10 秒內沒有回應、讀取回應失敗，或 2xx 的內容無法解析、缺少欄位 | `Upstream` |
//!
//! 舊版 GoTrue 對不正確的密碼與 refresh token 以 OAuth 格式回應 `{"error": "invalid_grant", …}`，`password_grant` 與
//! `refresh` 也把它當成 `InvalidCredentials`。被輪替掉的 refresh token 只要仍是目前那一個的上一代，GoTrue 在重用間隔
//! 之後仍回傳目前的 Session；再早的才是 `refresh_token_already_used`，同時撤銷整個 Session 的 refresh token。
//!
//! # 不洩漏秘密
//!
//! `AuthError` 的 `Display` 與 `Debug`（lm-server 會寫進記錄）只含 HTTP 狀態、錯誤代碼（只保留英數字與底線）、
//! Postgres 的 SQLSTATE 與傳輸錯誤的種類，不含密碼、token、金鑰、email、網址與 GoTrue 的 `msg`。`GoTrueSession` 與
//! `GoTrueHttp` 的 `Debug` 以 `<redacted>` 代替 token 與金鑰；送出的金鑰與 access token 標頭都標成 sensitive。
//!
//! # 與 design 2.2 的差異
//!
//! - `GoTrueHttp::new()` 檢查網址與金鑰並建立 reqwest 用戶端，失敗時回傳 `GoTrueConfigError`；金鑰存成標頭值。
//! - `GoTrueSession` 只保留 lm-server 組成 `SessionDto` 需要的欄位，使用者只保留 id；`expiry()` 在 Auth_Service
//!   沒有回傳 `expires_at` 時以 `expires_in` 算出到期時間。

use std::error::Error as StdError;
use std::fmt;
use std::time::Duration;

use lm_core::ids::UserId;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::{RequestBuilder, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 每個呼叫從開始連線到讀完回應的上限（需求 4.11、4.15）。
const TIMEOUT: Duration = Duration::from_secs(10);

/// Supabase 的 API gateway 與 GoTrue 以這個標頭接收 anon key 或 service key。
const APIKEY: &str = "apikey";

/// GoTrue 以這個標頭重複錯誤回應的 `error_code`。
const ERROR_CODE_HEADER: &str = "x-sb-error-code";

/// Postgres 的 unique_violation。
const UNIQUE_VIOLATION: &str = "23505";

/// lm-server 呼叫 Auth_Service 的介面（需求 1.6）；`GoTrueHttp` 以 HTTP 實作，測試可以換成不連網路的實作。
/// 錯誤的對應見模組說明。
#[async_trait::async_trait]
pub trait AuthBackend: Send + Sync {
    /// 建立 email 已確認的使用者（`POST /auth/v1/admin/users`，service key，`email_confirm: true`），`meta` 存成
    /// 使用者的 `user_metadata`；回傳新使用者的 id。email 已存在時是 `AlreadyExists`，既有使用者的密碼與資料不變。
    async fn create_user(
        &self,
        email: &str,
        password: &str,
        meta: &Value,
    ) -> Result<UserId, AuthError>;

    /// 刪除使用者（`DELETE /auth/v1/admin/users/{id}`，service key）：註冊流程後半失敗時的補償（需求 3.10）。
    /// 使用者已不存在時也回傳 `Ok(())`。
    async fn delete_user(&self, id: UserId) -> Result<(), AuthError>;

    /// 以 email 與原樣的密碼登入（`POST /auth/v1/token?grant_type=password`，anon key，需求 4.1）。
    async fn password_grant(&self, email: &str, password: &str)
        -> Result<GoTrueSession, AuthError>;

    /// 以 refresh token 換發 Session（`POST /auth/v1/token?grant_type=refresh_token`，anon key，需求 4.9）。
    async fn refresh(&self, refresh_token: &str) -> Result<GoTrueSession, AuthError>;

    /// 撤銷這個裝置的 refresh token（`POST /auth/v1/logout?scope=local`，以使用者的 access token，需求 4.11）：
    /// 這次登入取得的與之後換發得到的都失效，同一個帳號的其他 Session 不受影響。已簽發的 access token 仍可使用到到期。
    async fn logout(&self, access_token: &str) -> Result<(), AuthError>;
}

/// 登入或換發得到的 Session（GoTrue 的 token 回應）。`Debug` 不印出 token。
#[derive(Clone, PartialEq, Eq)]
pub struct GoTrueSession {
    /// access token（JWT；CLI 3.2.0 以 ES256 簽章）。
    pub access_token: String,
    /// refresh token（CLI 3.2.0 是 12 個字元）。
    pub refresh_token: String,
    /// `bearer`。
    pub token_type: String,
    /// access token 的有效秒數（Local_Stack 是 3600，需求 4.4）。
    pub expires_in: i64,
    /// access token 的到期時間（Unix 秒）；Auth_Service 沒有回傳時是 `None`，見 `expiry()`。
    pub expires_at: Option<i64>,
    /// 帳號的 id：回應中 `user.id`。
    pub user_id: UserId,
}

impl GoTrueSession {
    /// 給 `SessionDto::expires_at` 的到期時間（Unix 秒）：Auth_Service 回傳的 `expires_at`；沒有回傳時是
    /// `now_unix`（收到回應的時間，Unix 秒）加上 `expires_in`。
    pub fn expiry(&self, now_unix: i64) -> i64 {
        self.expires_at
            .unwrap_or_else(|| now_unix.saturating_add(self.expires_in))
    }
}

impl fmt::Debug for GoTrueSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoTrueSession")
            .field("access_token", &Redacted)
            .field("refresh_token", &Redacted)
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .field("expires_at", &self.expires_at)
            .field("user_id", &self.user_id)
            .finish()
    }
}

/// 呼叫 Auth_Service 的錯誤（對應見模組說明）。`Display` 與 `Debug` 只含 HTTP 狀態、錯誤代碼與傳輸錯誤的種類，
/// 不含密碼、token、金鑰與 email。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthError {
    /// 密碼不正確；refresh token 不存在、已撤銷或超過 10 秒的重用間隔；登出時 access token 無效、已過期或它的
    /// Session 已不存在（需求 4.2、4.9）。
    InvalidCredentials,
    /// email 已存在，包括同時進行、先建立使用者的另一個註冊（需求 3.6）。
    AlreadyExists,
    /// Auth_Service 拒收 email，也就是 `LM_AUTH_EMAIL_DOMAIN` 的設定有誤（需求 3.11）。
    InvalidEmail,
    /// 密碼不符合 Auth_Service 的強度規則；內容是 GoTrue 的原因代碼（`length`、`characters`、`pwned`），以 `, `
    /// 分隔，沒有時是空字串。
    WeakPassword(String),
    /// Auth_Service 回應 429（需求 4.15）。
    RateLimited,
    /// 無法連線、10 秒內沒有回應、5xx、其他沒有對應的錯誤，或無法解析的回應；內容是不含秘密的說明，例如
    /// `HTTP 403（not_admin）` 或 `無法連線（connection refused）`。
    Upstream(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::InvalidCredentials => f.write_str("Auth_Service 拒絕了密碼或 token"),
            AuthError::AlreadyExists => f.write_str("Auth_Service 已有 email 相同的使用者"),
            AuthError::InvalidEmail => {
                f.write_str("Auth_Service 拒收這個 email，請檢查 LM_AUTH_EMAIL_DOMAIN 的設定")
            }
            AuthError::WeakPassword(reasons) if reasons.is_empty() => {
                f.write_str("Auth_Service 拒收這個密碼")
            }
            AuthError::WeakPassword(reasons) => write!(f, "Auth_Service 拒收這個密碼（{reasons}）"),
            AuthError::RateLimited => f.write_str("Auth_Service 以速率限制拒絕（HTTP 429）"),
            AuthError::Upstream(detail) => write!(f, "Auth_Service 呼叫失敗：{detail}"),
        }
    }
}

impl StdError for AuthError {}

/// `GoTrueHttp::new()` 的錯誤；不含金鑰的值。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoTrueConfigError {
    /// 網址無法解析，或不是 http 或 https 的網址。
    InvalidUrl,
    /// 金鑰是空的，或含有不能放在 HTTP 標頭中的字元；內容是哪一把（`anon key` 或 `service key`）。
    InvalidKey(&'static str),
    /// 無法建立 HTTP 用戶端（例如 TLS 無法初始化）；內容是 reqwest 的說明與它的每一層原因。
    Client(String),
}

impl fmt::Display for GoTrueConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GoTrueConfigError::InvalidUrl => {
                f.write_str("Supabase 的網址無效：需要 http:// 或 https:// 的網址")
            }
            GoTrueConfigError::InvalidKey(which) => {
                write!(f, "{which} 是空的，或含有不能放在 HTTP 標頭中的字元")
            }
            GoTrueConfigError::Client(detail) => write!(f, "無法建立 HTTP 用戶端：{detail}"),
        }
    }
}

impl StdError for GoTrueConfigError {}

/// 以 HTTP 呼叫 Auth_Service 的 `AuthBackend`（見模組說明）。`Debug` 不印出金鑰。
pub struct GoTrueHttp {
    /// API gateway 的網址（`SUPABASE_URL`），路徑以 `/` 結尾。
    base: Url,
    /// `apikey: <anon key>`：密碼登入、換發與登出。
    anon_key: HeaderValue,
    /// `apikey: <service key>`：admin API。
    service_key: HeaderValue,
    /// `Authorization: Bearer <service key>`：admin API。
    service_bearer: HeaderValue,
    users_url: Url,
    password_url: Url,
    refresh_url: Url,
    logout_url: Url,
    /// 每個呼叫 10 秒逾時、不跟隨重新導向、不使用代理。
    http: reqwest::Client,
}

impl GoTrueHttp {
    /// `supabase_url` 是 API gateway 的網址（`SUPABASE_URL`，例如 `http://127.0.0.1:54321`；可以有路徑前綴）；
    /// `anon_key` 用於密碼登入、換發與登出，`service_key` 用於 admin API（建立與刪除使用者）。
    pub fn new(
        supabase_url: &str,
        anon_key: &str,
        service_key: &str,
    ) -> Result<Self, GoTrueConfigError> {
        let mut base = Url::parse(supabase_url).map_err(|_| GoTrueConfigError::InvalidUrl)?;
        if !matches!(base.scheme(), "http" | "https") || base.cannot_be_a_base() {
            return Err(GoTrueConfigError::InvalidUrl);
        }
        // 端點接在原本的路徑之後（例如 https://example.com/supabase/auth/v1/…），所以路徑要以 / 結尾
        if !base.path().ends_with('/') {
            let path = format!("{}/", base.path());
            base.set_path(&path);
        }
        base.set_query(None);
        base.set_fragment(None);
        let endpoint = |path: &str| base.join(path).map_err(|_| GoTrueConfigError::InvalidUrl);
        let users_url = endpoint("auth/v1/admin/users")?;
        let password_url = endpoint("auth/v1/token?grant_type=password")?;
        let refresh_url = endpoint("auth/v1/token?grant_type=refresh_token")?;
        let logout_url = endpoint("auth/v1/logout?scope=local")?;

        let anon_key = key_header(anon_key).ok_or(GoTrueConfigError::InvalidKey("anon key"))?;
        let (service_key, service_bearer) = key_header(service_key)
            .zip(sensitive_header(&format!("Bearer {service_key}")))
            .ok_or(GoTrueConfigError::InvalidKey("service key"))?;

        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|error| GoTrueConfigError::Client(error_chain(&error)))?;
        Ok(Self {
            base,
            anon_key,
            service_key,
            service_bearer,
            users_url,
            password_url,
            refresh_url,
            logout_url,
            http,
        })
    }

    /// admin API 的請求：`apikey` 與 `Authorization: Bearer` 都是 service key。
    fn admin(&self, request: RequestBuilder) -> RequestBuilder {
        request
            .header(APIKEY, self.service_key.clone())
            .header(AUTHORIZATION, self.service_bearer.clone())
    }

    /// 公開端點的請求：`apikey` 是 anon key。
    fn public(&self, request: RequestBuilder) -> RequestBuilder {
        request.header(APIKEY, self.anon_key.clone())
    }
}

impl fmt::Debug for GoTrueHttp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoTrueHttp")
            .field("base", &self.base.as_str())
            .field("anon_key", &Redacted)
            .field("service_key", &Redacted)
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl AuthBackend for GoTrueHttp {
    async fn create_user(
        &self,
        email: &str,
        password: &str,
        meta: &Value,
    ) -> Result<UserId, AuthError> {
        let request = self
            .admin(self.http.post(self.users_url.clone()))
            .json(&CreateUserBody {
                email,
                password,
                email_confirm: true,
                user_metadata: meta,
            });
        let (status, body) = exchange(request)
            .await
            .map_err(|failure| failure.into_error(Call::CreateUser))?;
        serde_json::from_slice::<UserBody>(&body)
            .map(|user| user.id)
            .map_err(|_| unexpected_body(status))
    }

    async fn delete_user(&self, id: UserId) -> Result<(), AuthError> {
        let request = self.admin(self.http.delete(format!("{}/{id}", self.users_url)));
        match exchange(request).await {
            Ok(_) => Ok(()),
            Err(Failure::Status(reply))
                if reply.status == StatusCode::NOT_FOUND
                    && reply.code.as_deref() == Some("user_not_found") =>
            {
                Ok(())
            }
            Err(failure) => Err(failure.into_error(Call::DeleteUser)),
        }
    }

    async fn password_grant(
        &self,
        email: &str,
        password: &str,
    ) -> Result<GoTrueSession, AuthError> {
        let request = self
            .public(self.http.post(self.password_url.clone()))
            .json(&PasswordBody { email, password });
        session(request, Call::PasswordGrant).await
    }

    async fn refresh(&self, refresh_token: &str) -> Result<GoTrueSession, AuthError> {
        let request = self
            .public(self.http.post(self.refresh_url.clone()))
            .json(&RefreshBody { refresh_token });
        session(request, Call::Refresh).await
    }

    async fn logout(&self, access_token: &str) -> Result<(), AuthError> {
        // 不能放在標頭中的 token 不可能有效，不必送出
        let bearer = sensitive_header(&format!("Bearer {access_token}"))
            .ok_or(AuthError::InvalidCredentials)?;
        let request = self
            .public(self.http.post(self.logout_url.clone()))
            .header(AUTHORIZATION, bearer);
        exchange(request)
            .await
            .map(|_| ())
            .map_err(|failure| failure.into_error(Call::Logout))
    }
}

/// `create_user` 的請求內容。
#[derive(Serialize)]
struct CreateUserBody<'a> {
    email: &'a str,
    password: &'a str,
    email_confirm: bool,
    user_metadata: &'a Value,
}

/// `password_grant` 的請求內容。
#[derive(Serialize)]
struct PasswordBody<'a> {
    email: &'a str,
    password: &'a str,
}

/// `refresh` 的請求內容。
#[derive(Serialize)]
struct RefreshBody<'a> {
    refresh_token: &'a str,
}

/// 回應中的使用者：只取 `id`。
#[derive(Deserialize)]
struct UserBody {
    id: UserId,
}

/// GoTrue 的 token 回應中用到的欄位。
#[derive(Deserialize)]
struct SessionBody {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: i64,
    expires_at: Option<i64>,
    user: UserBody,
}

impl SessionBody {
    /// token 是空的，或 `expires_in` 不是正數時是 `None`。
    fn into_session(self) -> Option<GoTrueSession> {
        if self.access_token.is_empty() || self.refresh_token.is_empty() || self.expires_in <= 0 {
            return None;
        }
        Some(GoTrueSession {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            token_type: self.token_type,
            expires_in: self.expires_in,
            expires_at: self.expires_at,
            user_id: self.user.id,
        })
    }
}

/// 送出登入或換發的請求，把 2xx 的內容解成 `GoTrueSession`。
async fn session(request: RequestBuilder, call: Call) -> Result<GoTrueSession, AuthError> {
    let (status, body) = exchange(request)
        .await
        .map_err(|failure| failure.into_error(call))?;
    serde_json::from_slice::<SessionBody>(&body)
        .ok()
        .and_then(SessionBody::into_session)
        .ok_or_else(|| unexpected_body(status))
}

/// 2xx 但內容無法解析、缺少欄位，或 token 是空的。
fn unexpected_body(status: StatusCode) -> AuthError {
    AuthError::Upstream(format!("HTTP {} 的內容不是預期的格式", status.as_u16()))
}

/// 呼叫的種類：同一個錯誤代碼在不同的呼叫有不同的意思（見模組說明）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Call {
    CreateUser,
    DeleteUser,
    PasswordGrant,
    Refresh,
    Logout,
}

/// 一次呼叫失敗的原因，還沒依呼叫的種類對應成 `AuthError`。
enum Failure {
    /// 無法連線、逾時或讀取回應失敗；內容是 `Upstream` 的說明。
    Transport(String),
    /// 非 2xx 的回應。
    Status(ErrorReply),
}

impl Failure {
    fn into_error(self, call: Call) -> AuthError {
        match self {
            Failure::Transport(detail) => AuthError::Upstream(detail),
            Failure::Status(reply) => reply.into_error(call),
        }
    }
}

/// 送出請求並讀完回應：2xx 時回傳狀態與內容，其他狀態與傳輸錯誤回傳 `Failure`。
async fn exchange(request: RequestBuilder) -> Result<(StatusCode, Vec<u8>), Failure> {
    let response = request
        .send()
        .await
        .map_err(|error| Failure::Transport(describe_transport(&error)))?;
    let status = response.status();
    let header_code = response
        .headers()
        .get(ERROR_CODE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(clean_code);
    let body = response.bytes().await;
    if status.is_success() {
        return body
            .map(|body| (status, body.to_vec()))
            .map_err(|error| Failure::Transport(describe_transport(&error)));
    }
    // 錯誤回應的內容讀不完時，仍依狀態與標頭分類
    let body = body.map(|body| body.to_vec()).unwrap_or_default();
    Err(Failure::Status(ErrorReply::parse(
        status,
        header_code,
        &body,
    )))
}

/// 非 2xx 的回應中用來分類的部分；不保留 `msg` 與其他內容。
struct ErrorReply {
    status: StatusCode,
    /// `error_code`，沒有時是 `x-sb-error-code` 標頭，再沒有時是 OAuth 格式的 `error`。
    code: Option<String>,
    /// 內容的 `code` 是 SQLSTATE（五個大寫英文字母或數字）時：GoTrue 原樣轉出的 Postgres 錯誤。
    sqlstate: Option<String>,
    /// `msg` 提到 email address：`create_user` 的 `validation_failed` 以它分辨被拒收的是 email 還是密碼。
    about_email: bool,
    /// `weak_password.reasons`。
    reasons: Vec<String>,
}

impl ErrorReply {
    fn parse(status: StatusCode, header_code: Option<String>, body: &[u8]) -> Self {
        let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        let code = text_at(&value, "error_code")
            .and_then(clean_code)
            .or(header_code)
            .or_else(|| text_at(&value, "error").and_then(clean_code));
        let sqlstate = text_at(&value, "code")
            .filter(|code| {
                code.len() == 5
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            })
            .map(str::to_owned);
        let about_email = text_at(&value, "msg")
            .is_some_and(|msg| msg.to_ascii_lowercase().contains("email address"));
        let reasons = value
            .pointer("/weak_password/reasons")
            .and_then(Value::as_array)
            .map(|reasons| {
                reasons
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(clean_code)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            status,
            code,
            sqlstate,
            about_email,
            reasons,
        }
    }

    fn into_error(self, call: Call) -> AuthError {
        if self.status == StatusCode::TOO_MANY_REQUESTS {
            return AuthError::RateLimited;
        }
        if self.status.is_server_error() {
            // 同時建立同一個 email：兩個請求都通過 GoTrue 的重複檢查，後寫入的那一個違反 auth.users 的
            // users_email_partial_key，GoTrue 以 500 原樣回應 Postgres 的錯誤。建立使用者時其他唯一欄位都是空的或由
            // GoTrue 隨機產生，所以 23505 只會是 email 重複（需求 3.6）。
            if call == Call::CreateUser && self.sqlstate.as_deref() == Some(UNIQUE_VIOLATION) {
                return AuthError::AlreadyExists;
            }
            return AuthError::Upstream(self.describe());
        }
        match (call, self.code.as_deref().unwrap_or_default()) {
            (Call::CreateUser, "email_exists" | "user_already_exists") => AuthError::AlreadyExists,
            (Call::CreateUser, "email_address_invalid") => AuthError::InvalidEmail,
            (Call::CreateUser, "validation_failed") if self.about_email => AuthError::InvalidEmail,
            (Call::CreateUser, "weak_password") => AuthError::WeakPassword(self.reasons.join(", ")),
            (Call::PasswordGrant, "invalid_credentials" | "invalid_grant") => {
                AuthError::InvalidCredentials
            }
            (
                Call::Refresh,
                "refresh_token_not_found"
                | "refresh_token_already_used"
                | "session_not_found"
                | "session_expired"
                | "validation_failed"
                | "invalid_grant",
            ) => AuthError::InvalidCredentials,
            (
                Call::Logout,
                "no_authorization" | "bad_jwt" | "session_not_found" | "user_not_found",
            ) => AuthError::InvalidCredentials,
            _ => AuthError::Upstream(self.describe()),
        }
    }

    /// `Upstream` 的說明，例如 `HTTP 403（not_admin）` 或 `HTTP 500（unexpected_failure，SQLSTATE 23514）`。
    fn describe(&self) -> String {
        let details: Vec<String> = self
            .code
            .iter()
            .cloned()
            .chain(
                self.sqlstate
                    .iter()
                    .map(|state| format!("SQLSTATE {state}")),
            )
            .collect();
        let status = self.status.as_u16();
        if details.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}（{}）", details.join("，"))
        }
    }
}

/// `value` 的欄位 `key` 是字串時的內容。
fn text_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// GoTrue 的錯誤代碼只有英數字與底線；含有其他字元或超過 64 個字元時不保留，所以 `AuthError` 只會帶這種代碼。
fn clean_code(text: &str) -> Option<String> {
    let valid = !text.is_empty()
        && text.len() <= 64
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    valid.then(|| text.to_owned())
}

/// 傳輸錯誤的種類，加上底層 I/O 錯誤的種類（例如 `connection refused`）；不含網址、標頭與內容。
fn describe_transport(error: &reqwest::Error) -> String {
    let what = if error.is_timeout() {
        "10 秒內沒有回應"
    } else if error.is_connect() {
        "無法連線"
    } else if error.is_body() || error.is_decode() {
        "讀取回應失敗"
    } else if error.is_builder() {
        "無法建立請求"
    } else {
        "送出請求失敗"
    };
    match io_error_kind(error) {
        Some(kind) => format!("{what}（{kind}）"),
        None => what.to_owned(),
    }
}

/// 錯誤的原因中第一個 I/O 錯誤的種類。
fn io_error_kind(error: &(dyn StdError + 'static)) -> Option<std::io::ErrorKind> {
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return Some(io.kind());
        }
        source = cause.source();
    }
    None
}

/// 錯誤與它的每一層原因，以「：」連接（只用於建立用戶端的錯誤，其中沒有網址與金鑰）。
fn error_chain(error: &(dyn StdError + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push('：');
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// 金鑰的標頭值：不能是空的，標成 sensitive。
fn key_header(key: &str) -> Option<HeaderValue> {
    if key.is_empty() {
        return None;
    }
    sensitive_header(key)
}

/// 標成 sensitive 的標頭值（reqwest 與 http 的 `Debug` 不印出）；含有不能放在標頭中的字元時是 `None`。
fn sensitive_header(value: &str) -> Option<HeaderValue> {
    let mut header = HeaderValue::from_str(value).ok()?;
    header.set_sensitive(true);
    Some(header)
}

/// `Debug` 中代替 token 與金鑰。
struct Redacted;

impl fmt::Debug for Redacted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}
