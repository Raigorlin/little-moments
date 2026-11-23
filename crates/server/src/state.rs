//! 路由器的狀態（design 3.1，任務 13.3）：`/api/*` 的處理函式以 `State<AppState>` 取得連線池、Auth_Service 的用戶端、
//! access token 的驗證器、設定與時鐘（design 的虛擬碼寫成 `st.db`、`st.auth`、`st.config`、`st.clock`）。複製
//! `AppState` 只增加連線池與 `Arc` 的參考計數。
//!
//! # 擷取器需要的 `FromRef`
//!
//! 任務 13.2 的 `AuthUser` 從路由器的狀態取得連線池與驗證器，所以 `AppState` 實作
//! `FromRef<AppState> for PgPool` 與 `FromRef<AppState> for Arc<dyn TokenVerifier>`，回傳欄位的複本。
//!
//! # 不在記憶體保存登入狀態與旅行資料（需求 1.11）
//!
//! - 登入狀態只在瀏覽器的 Session 與 Auth_Service 中：每個請求都以 `verifier` 重新驗證 access token，再讀取
//!   `app.profiles`。`AnyVerifier` 以 `SUPABASE_JWT_SECRET` 驗證 HS256；ES256 的公鑰取自 JWKS，快取只是讀到的公鑰的
//!   複本，重新啟動後第一次需要時重新讀取。
//! - 旅行資料、Change_Log 與 Head 只在 Database 中。
//!
//! 所以 lm-server 重新啟動之後，之前簽發、尚未過期的 access token 照常有效，已提交的資料也照常讀得到。

use std::fmt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::FromRef;
use lm_supabase::gotrue::{AuthBackend, GoTrueConfigError, GoTrueHttp};
use lm_supabase::jwt::{AnyVerifier, JwtConfigError, TokenVerifier};
use sqlx::PgPool;

use crate::config::{Config, Secret};

/// 路由器的狀態（見模組說明）。
#[derive(Clone)]
pub struct AppState {
    /// Database 的連線池。
    pub db: PgPool,
    /// Auth_Service 的 REST 呼叫（`GoTrueHttp`，需求 1.6）。
    pub auth: Arc<dyn AuthBackend>,
    /// access token 的驗證（`AnyVerifier`，需求 5.1–5.4）。
    pub verifier: Arc<dyn TokenVerifier>,
    /// 設定。
    pub config: Arc<Config>,
    /// 目前時間（`SystemClock`）。
    pub clock: Arc<dyn Clock>,
}

impl AppState {
    /// 以設定、已確認可以連上的連線池與 Supabase 的用戶端組成；時鐘是系統時間。
    pub fn new(config: Config, db: PgPool, clients: SupabaseClients) -> Self {
        Self {
            db,
            auth: clients.auth,
            verifier: clients.verifier,
            config: Arc::new(config),
            clock: Arc::new(SystemClock),
        }
    }
}

/// `AuthUser` 讀取 `app.profiles` 的連線池。
impl FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.db.clone()
    }
}

/// `AuthUser` 驗證 access token 的驗證器。
impl FromRef<AppState> for Arc<dyn TokenVerifier> {
    fn from_ref(state: &AppState) -> Self {
        state.verifier.clone()
    }
}

/// lm-server 呼叫 Supabase 的用戶端：Auth_Service 的 REST 呼叫與 access token 的驗證。
pub struct SupabaseClients {
    auth: Arc<dyn AuthBackend>,
    verifier: Arc<dyn TokenVerifier>,
}

impl SupabaseClients {
    /// 以 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` 與 `SUPABASE_JWT_SECRET` 建立 `GoTrueHttp` 與
    /// `AnyVerifier`。只檢查網址與金鑰能否用於 HTTP 請求並建立 HTTP 用戶端，不連線，所以可以在連上 Database 之前呼叫。
    pub fn new(config: &Config) -> Result<Self, ClientError> {
        let auth = GoTrueHttp::new(
            &config.supabase_url,
            config.supabase_anon_key.expose(),
            config.supabase_service_key.expose(),
        )
        .map_err(ClientError::Auth)?;
        let verifier = AnyVerifier::new(
            &config.supabase_url,
            config.supabase_jwt_secret.as_ref().map(Secret::expose),
        )
        .map_err(ClientError::Verifier)?;
        Ok(Self {
            auth: Arc::new(auth),
            verifier: Arc::new(verifier),
        })
    }
}

/// 無法建立 Supabase 的用戶端（啟動時，在開始監聽之前）。訊息只有 lm-supabase 的說明與要檢查的變數名稱，不含金鑰的值。
pub enum ClientError {
    Auth(GoTrueConfigError),
    Verifier(JwtConfigError),
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Auth(error) => write!(
                f,
                "無法建立 Auth_Service 的用戶端：{error}（請檢查 SUPABASE_URL、SUPABASE_ANON_KEY 與 SUPABASE_SERVICE_KEY）"
            ),
            ClientError::Verifier(error) => write!(
                f,
                "無法建立 access token 的驗證器：{error}（請檢查 SUPABASE_URL）"
            ),
        }
    }
}

/// 目前時間的來源：Change_Set 的 `committed_at_ms` 等由 lm-server 決定的時間（LM_Core 不讀系統時間，需求 1.4）。
pub trait Clock: Send + Sync {
    /// 目前時間（Unix 毫秒）。
    fn now_ms(&self) -> i64;
}

/// 系統時間。
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(since) => i64::try_from(since.as_millis()).unwrap_or(i64::MAX),
            Err(before) => i64::try_from(before.duration().as_millis()).map_or(i64::MIN, |ms| -ms),
        }
    }
}
