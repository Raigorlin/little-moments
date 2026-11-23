//! access token 驗證（design 2.3）：lm-server 以 `TokenVerifier` 驗證 `Authorization: Bearer` 中的 access token，
//! 取得 `Claims`（需求 5.1–5.4）。`AnyVerifier` 依 JWT 標頭的 `alg` 交給 `Hs256Verifier`（`SUPABASE_JWT_SECRET`）
//! 或 `JwksVerifier`（ES256，公鑰取自 Auth_Service 的 JWKS）。feature `server`，只由 lm-server 啟用（需求 1.10）。
//!
//! CLI 3.2.0（GoTrue v2.198.0）以 ES256 簽發使用者的 access token，標頭是 `{"alg": "ES256", "kid": …, "typ": "JWT"}`，
//! JWKS 只有一把 `kty` 為 `EC`、`crv` 為 `P-256` 的公鑰（任務 1.2 與 12.6 實測）。anon key 與 service_role key 是以
//! `JWT_SECRET` 簽署的 HS256 token，沒有 `aud` 與 `sub`，所以設定了 `SUPABASE_JWT_SECRET` 時也因宣告不符被拒絕。
//!
//! # 驗證的順序
//!
//! 依序檢查，回傳第一個不通過的原因（`InvalidReason`）：
//!
//! 1. `Malformed`：不是以 `.` 分隔的三段 base64url，或標頭無法解析，包括 `alg` 是 `none` 等 jsonwebtoken 不認得的值。
//! 2. `Algorithm`：`alg` 不是 `HS256` 或 `ES256`（例如 `HS512`、`RS256`），或沒有設定這種簽章：`SUPABASE_JWT_SECRET`
//!    沒有設定或是空字串時的 `HS256`（需求 5.3）。
//! 3. ES256 依標頭的 `kid` 取 JWKS 中的公鑰（見「JWKS 快取」）：沒有 `kid` 或是空字串時是 `MissingKid`，不讀取 JWKS；
//!    讀取後仍沒有這個 `kid` 時是 `UnknownKid`（需求 5.4）。HS256 不看 `kid`。
//! 4. `Signature`：簽章不符，或 JWKS 中這個 `kid` 的公鑰無法用來驗證（例如座標不在曲線上）。
//! 5. `Claims`：缺少 `aud`、`role`、`sub` 或 `exp`，型別不符或重複出現，`sub` 不是 UUID，或 `aud`、`role` 不是
//!    `authenticated`（需求 5.2）。`aud` 可以是字串，或只有一個元素的陣列（RFC 7519 4.1.3：只有一個受眾時兩種寫法
//!    相同），含其他受眾的陣列不接受；`exp` 必須是整數秒（GoTrue 簽發的都是）。`session_id` 可以沒有，有時必須是
//!    UUID。`iss`、`iat` 與 `nbf` 不檢查。
//! 6. `Expired`：目前時間的整數秒晚於 `exp` 加 30 秒（需求 5.2：`exp` 已過 29 秒時接受，已過 31 秒時拒絕）。
//!
//! `sub` 是否為 `app.profiles` 中的帳號由 lm-server 檢查（需求 5.2）。
//!
//! # JWKS 快取
//!
//! `JwksVerifier` 以 GET 讀取 `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`（不需要 `apikey`），只保留可以驗證 ES256
//! 的公鑰：`kty` 是 `EC`、`crv` 是 `P-256`、有 `kid`，而且 `alg`、`use` 與 `key_ops` 有設定時分別是 `ES256`、`sig`
//! 與包含 `verify`；其他的（例如 RSA 的公鑰）略過，同一個 `kid` 出現兩次時取第一把。
//!
//! - 快取在讀取它的那次驗證之後未滿 10 分鐘（`JwksVerifier::CACHE_MS`），而且其中有 token 的 `kid` 時直接使用。
//! - 沒有快取、快取已滿 10 分鐘，或 `kid` 不在快取中時，立即讀取一次，成功時以讀到的內容取代快取（需求 5.4）。所以
//!   每個 token 的驗證最多讀取一次，金鑰輪替後的新 `kid` 也不必等快取過期。
//! - 讀取失敗時快取不變，這次驗證是 `Unavailable`，下一次需要時再讀取；已滿 10 分鐘的快取不拿來代替（需求 5.10）。
//! - 同時進行的驗證各自讀取，不互相等待。`kid` 不在快取中的每個 token 都會讀取一次；限制讀取的頻率屬於延後到資安
//!   工作流的速率限制。
//!
//! 每次讀取從開始連線到讀完回應最多 10 秒；與 `GoTrueHttp` 相同，不跟隨重新導向，也不使用 `HTTP_PROXY`、
//! `HTTPS_PROXY` 等環境變數指定的代理。
//!
//! # 錯誤
//!
//! | 結果 | 情況 | lm-server |
//! | --- | --- | --- |
//! | `JwtError::Invalid(原因)` | 驗證順序中任一項不通過 | 401 `unauthorized`（需求 5.1） |
//! | `JwtError::Unavailable(說明)` | 需要讀取 JWKS，但無法連線、10 秒內沒有回應、回應不是 2xx（包括重新導向），或內容不是 `{"keys": [...]}` | 500 `internal_error`，並記錄說明（需求 5.10） |
//!
//! 內容是 `{"keys": [...]}` 但沒有可用的公鑰（例如 `{"keys": []}`）時不是 `Unavailable`：ES256 的 token 都是
//! `UnknownKid`。`JwtError` 的 `Display` 與 `Debug` 只含原因、HTTP 狀態與傳輸錯誤的種類，不含 token、宣告的值、金鑰
//! 與網址；`Hs256Verifier` 的 `Debug` 不印出金鑰。
//!
//! # 時間
//!
//! `TokenVerifier::verify()` 以系統時間驗證；`verify_at()` 以傳入的 Unix 毫秒作為目前時間，`exp` 的判斷與快取的時效
//! 都以它為準，所以測試可以指定時間，例如不必等待就驗證 10 分鐘後的快取。目前時間早於快取的讀取時間（例如系統時間
//! 被調回）時，快取視為已過期。
//!
//! # 與 design 2.3 的差異
//!
//! - `TokenVerifier` 多了 `verify_at()`；`verify()` 是以系統時間呼叫它的預設方法。
//! - `Claims::sub` 是 `UserId`（與 `gotrue` 相同）；`aud` 也接受只有一個元素的陣列。
//! - 建立方式是 `Hs256Verifier::new()`、`JwksVerifier::new()`、`AnyVerifier::new()` 與 `AnyVerifier::from_parts()`；
//!   `JwksVerifier` 另有自己的 reqwest 用戶端，快取是 `RwLock<Option<JwkCache>>`。
//! - design 沒有列出的公開項目：`JwtError`、`InvalidReason`、`JwtConfigError`、`EXP_LEEWAY_SECS` 與
//!   `JwksVerifier::CACHE_MS`。

use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::jwk::{
    AlgorithmParameters, EllipticCurve, Jwk, KeyAlgorithm, KeyOperations, PublicKeyUse,
};
use jsonwebtoken::{Algorithm, DecodingKey, Header, Validation};
use lm_core::ids::UserId;
use reqwest::Url;
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use tokio::sync::RwLock;
use uuid::Uuid;

/// `exp` 之後仍接受的秒數（需求 5.2）。
pub const EXP_LEEWAY_SECS: i64 = 30;

/// `aud` 與 `role` 都必須是這個值（需求 5.2）。
const AUTHENTICATED: &str = "authenticated";

/// 讀取 JWKS 從開始連線到讀完回應的上限，與 `GoTrueHttp` 的每個呼叫相同。
const TIMEOUT: Duration = Duration::from_secs(10);

/// JWKS 在 `SUPABASE_URL` 之下的路徑。
const JWKS_PATH: &str = "auth/v1/.well-known/jwks.json";

/// 驗證通過的 access token 的宣告。lm-server 只以 `sub` 辨識使用者（需求 5.6），並檢查它是 `app.profiles` 中的帳號
/// （需求 5.2）。`Deserialize` 只用於解析簽章已驗證的內容，其他檢查見模組說明。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Claims {
    /// 帳號的 id：Auth_Service 使用者的 id。
    pub sub: UserId,
    /// 到期時間（Unix 秒）。
    pub exp: i64,
    /// 一定是 `authenticated`；token 中可以是字串，或只有這一個元素的陣列。
    #[serde(deserialize_with = "single_audience")]
    pub aud: String,
    /// 一定是 `authenticated`。
    pub role: String,
    /// GoTrue 的 Session id；以 `SUPABASE_JWT_SECRET` 自行簽署的 token 可以沒有。
    pub session_id: Option<Uuid>,
}

/// lm-server 驗證 access token 的介面（需求 5.1–5.4）：lm-server 使用 `AnyVerifier`，測試可以換成不連網路的實作。
#[async_trait::async_trait]
pub trait TokenVerifier: Send + Sync {
    /// 以 `now_ms`（Unix 毫秒）作為目前時間驗證 `token`：`exp` 的判斷與 JWKS 快取的時效都以它為準。
    async fn verify_at(&self, token: &str, now_ms: i64) -> Result<Claims, JwtError>;

    /// 以系統時間驗證 `token`。
    async fn verify(&self, token: &str) -> Result<Claims, JwtError> {
        self.verify_at(token, system_now_ms()).await
    }
}

/// access token 驗證失敗（見模組說明的「錯誤」）。`Display` 與 `Debug` 不含 token、宣告的值、金鑰與網址。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JwtError {
    /// token 無效：lm-server 回應 401（需求 5.1）。
    Invalid(InvalidReason),
    /// 驗證需要讀取 JWKS，但 Auth_Service 無法連線、10 秒內沒有回應、回應不是 2xx，或內容無法解析成 JWKS：
    /// lm-server 回應 500 並記錄（需求 5.10），不回應 401。內容是不含秘密的說明，例如 `HTTP 503` 或
    /// `無法連線（connection refused）`。
    Unavailable(String),
}

impl fmt::Display for JwtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JwtError::Invalid(reason) => write!(f, "access token 無效：{reason}"),
            JwtError::Unavailable(detail) => write!(f, "無法讀取 Auth_Service 的 JWKS：{detail}"),
        }
    }
}

impl StdError for JwtError {}

/// token 無效的原因（見模組說明的驗證順序），只用於記錄：lm-server 對每一種都回應相同的 401。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidReason {
    /// 不是 JWT 的格式，或標頭無法解析（包括 `alg` 是 `none` 等 jsonwebtoken 不認得的值）。
    Malformed,
    /// `alg` 不是 HS256 或 ES256，或沒有設定這種簽章（`SUPABASE_JWT_SECRET` 沒有設定時的 HS256）。
    Algorithm,
    /// ES256 的標頭沒有 `kid`，或是空字串。
    MissingKid,
    /// 讀取後的 JWKS 仍沒有標頭中的 `kid`。
    UnknownKid,
    /// 簽章不符，或 JWKS 中的公鑰無法用來驗證（例如座標不在曲線上）。
    Signature,
    /// 缺少 `aud`、`role`、`sub` 或 `exp`，型別不符或重複出現，或 `aud`、`role` 不是 `authenticated`。
    Claims,
    /// 目前時間晚於 `exp` 之後 30 秒。
    Expired,
}

impl fmt::Display for InvalidReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            InvalidReason::Malformed => "不是 JWT 的格式",
            InvalidReason::Algorithm => "不接受這種簽章演算法",
            InvalidReason::MissingKid => "ES256 的標頭沒有 kid",
            InvalidReason::UnknownKid => "JWKS 中沒有這個 kid",
            InvalidReason::Signature => "簽章不符",
            InvalidReason::Claims => "宣告不符合要求",
            InvalidReason::Expired => "已過期",
        })
    }
}

/// `JwksVerifier::new()` 與 `AnyVerifier::new()` 的錯誤。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JwtConfigError {
    /// 網址無法解析，或不是 http 或 https 的網址。
    InvalidUrl,
    /// 無法建立 HTTP 用戶端（例如 TLS 無法初始化）；內容是 reqwest 的說明與它的每一層原因。
    Client(String),
}

impl fmt::Display for JwtConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JwtConfigError::InvalidUrl => {
                f.write_str("Supabase 的網址無效：需要 http:// 或 https:// 的網址")
            }
            JwtConfigError::Client(detail) => write!(f, "無法建立 HTTP 用戶端：{detail}"),
        }
    }
}

impl StdError for JwtConfigError {}

/// 以 `SUPABASE_JWT_SECRET` 驗證 HS256 的 token；金鑰是這個字串原樣的位元組，與 GoTrue 相同。`Debug` 不印出金鑰。
pub struct Hs256Verifier {
    key: DecodingKey,
}

impl Hs256Verifier {
    /// `secret` 是空字串時是 `None`：以空的金鑰驗證 HMAC 等於任何人都能簽章，所以與沒有設定相同（需求 5.3）。
    pub fn new(secret: &str) -> Option<Self> {
        DecodingKey::from_secret(secret.as_bytes())
            .ok()
            .map(|key| Self { key })
    }

    /// 標頭已確認是 HS256 之後的步驟（模組說明的步驟 4 至 6）。
    fn check(&self, token: &str, now_ms: i64) -> Result<Claims, JwtError> {
        decode_claims(token, &self.key, Algorithm::HS256, now_ms)
    }
}

impl fmt::Debug for Hs256Verifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Hs256Verifier").finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl TokenVerifier for Hs256Verifier {
    async fn verify_at(&self, token: &str, now_ms: i64) -> Result<Claims, JwtError> {
        match header(token)?.alg {
            Algorithm::HS256 => self.check(token, now_ms),
            _ => Err(JwtError::Invalid(InvalidReason::Algorithm)),
        }
    }
}

/// 以 Auth_Service 的 JWKS 中 `kid` 相同的公鑰驗證 ES256 的 token（見模組說明的「JWKS 快取」）。
pub struct JwksVerifier {
    /// `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`。
    url: Url,
    /// 每次讀取 10 秒逾時、不跟隨重新導向、不使用代理。
    http: reqwest::Client,
    /// 最後一次成功讀到的 JWKS；還沒讀過時是 `None`。
    cache: RwLock<Option<JwkCache>>,
}

/// 讀到的 JWKS 中可以驗證 ES256 的公鑰。
struct JwkCache {
    keys: HashMap<String, DecodingKey>,
    /// 讀取它的那次驗證的目前時間（Unix 毫秒）。
    fetched_at_ms: i64,
}

impl JwkCache {
    /// 讀取之後未滿 `CACHE_MS`；`now_ms` 早於讀取時間時不算。
    fn is_fresh(&self, now_ms: i64) -> bool {
        now_ms
            .checked_sub(self.fetched_at_ms)
            .is_some_and(|age| (0..JwksVerifier::CACHE_MS).contains(&age))
    }
}

impl JwksVerifier {
    /// JWKS 快取的時效：10 分鐘（需求 5.4）。
    pub const CACHE_MS: i64 = 10 * 60 * 1000;

    /// `supabase_url` 是 API gateway 的網址（`SUPABASE_URL`，例如 `http://127.0.0.1:54321`；可以有路徑前綴），
    /// JWKS 在它之下的 `auth/v1/.well-known/jwks.json`。建立時不讀取，第一次驗證 ES256 的 token 時才讀取。
    pub fn new(supabase_url: &str) -> Result<Self, JwtConfigError> {
        let url = jwks_url(supabase_url).ok_or(JwtConfigError::InvalidUrl)?;
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|error| JwtConfigError::Client(error_chain(&error)))?;
        Ok(Self {
            url,
            http,
            cache: RwLock::new(None),
        })
    }

    /// 標頭已確認是 ES256 之後的步驟（模組說明的步驟 3 至 6）。
    async fn check(&self, token: &str, header: &Header, now_ms: i64) -> Result<Claims, JwtError> {
        let kid = header
            .kid
            .as_deref()
            .filter(|kid| !kid.is_empty())
            .ok_or(JwtError::Invalid(InvalidReason::MissingKid))?;
        let key = self.key(kid, now_ms).await?;
        decode_claims(token, &key, Algorithm::ES256, now_ms)
    }

    /// `kid` 的公鑰：快取未滿 10 分鐘而且有這個 `kid` 時取自快取，否則立即讀取一次 JWKS 並取代快取（需求 5.4）。
    async fn key(&self, kid: &str, now_ms: i64) -> Result<DecodingKey, JwtError> {
        let cached = self
            .cache
            .read()
            .await
            .as_ref()
            .filter(|cache| cache.is_fresh(now_ms))
            .and_then(|cache| cache.keys.get(kid).cloned());
        if let Some(key) = cached {
            return Ok(key);
        }
        // 讀取失敗時保留原本的快取，下一次需要時再讀取
        let keys = self.fetch().await?;
        let key = keys.get(kid).cloned();
        *self.cache.write().await = Some(JwkCache {
            keys,
            fetched_at_ms: now_ms,
        });
        key.ok_or(JwtError::Invalid(InvalidReason::UnknownKid))
    }

    /// 讀取 JWKS，回傳其中可以驗證 ES256 的公鑰。
    async fn fetch(&self) -> Result<HashMap<String, DecodingKey>, JwtError> {
        let response = self
            .http
            .get(self.url.clone())
            .send()
            .await
            .map_err(|error| JwtError::Unavailable(describe_transport(&error)))?;
        let status = response.status();
        if !status.is_success() {
            return Err(JwtError::Unavailable(format!("HTTP {}", status.as_u16())));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| JwtError::Unavailable(describe_transport(&error)))?;
        parse_jwks(&body).ok_or_else(|| {
            JwtError::Unavailable(format!("HTTP {} 的內容不是 JWKS", status.as_u16()))
        })
    }
}

impl fmt::Debug for JwksVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JwksVerifier")
            .field("url", &self.url.as_str())
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl TokenVerifier for JwksVerifier {
    async fn verify_at(&self, token: &str, now_ms: i64) -> Result<Claims, JwtError> {
        let header = header(token)?;
        match header.alg {
            Algorithm::ES256 => self.check(token, &header, now_ms).await,
            _ => Err(JwtError::Invalid(InvalidReason::Algorithm)),
        }
    }
}

/// lm-server 使用的驗證器：依 JWT 標頭的 `alg`，HS256 交給 `Hs256Verifier`，ES256 交給 `JwksVerifier`；其他的
/// `alg`，以及沒有設定的那一種簽章都是 `Algorithm`（需求 5.3）。
#[derive(Debug)]
pub struct AnyVerifier {
    hs256: Option<Hs256Verifier>,
    jwks: Option<JwksVerifier>,
}

impl AnyVerifier {
    /// lm-server 的設定：`supabase_url` 是 `SUPABASE_URL`；`jwt_secret` 是 `SUPABASE_JWT_SECRET`，沒有設定時是
    /// `None`，空字串與沒有設定相同，這兩種情況下所有 HS256 的 token 都被拒絕（需求 2.7、5.3）。
    pub fn new(supabase_url: &str, jwt_secret: Option<&str>) -> Result<Self, JwtConfigError> {
        let jwks = JwksVerifier::new(supabase_url)?;
        Ok(Self::from_parts(
            jwt_secret.and_then(Hs256Verifier::new),
            Some(jwks),
        ))
    }

    /// 以已建立的驗證器組成；沒有的那一種簽章的 token 都是 `Algorithm`。
    pub fn from_parts(hs256: Option<Hs256Verifier>, jwks: Option<JwksVerifier>) -> Self {
        Self { hs256, jwks }
    }
}

#[async_trait::async_trait]
impl TokenVerifier for AnyVerifier {
    async fn verify_at(&self, token: &str, now_ms: i64) -> Result<Claims, JwtError> {
        let header = header(token)?;
        match (header.alg, &self.hs256, &self.jwks) {
            (Algorithm::HS256, Some(hs256), _) => hs256.check(token, now_ms),
            (Algorithm::ES256, _, Some(jwks)) => jwks.check(token, &header, now_ms).await,
            _ => Err(JwtError::Invalid(InvalidReason::Algorithm)),
        }
    }
}

/// 解析 JWT 標頭（模組說明的步驟 1）。
fn header(token: &str) -> Result<Header, JwtError> {
    jsonwebtoken::decode_header(token).map_err(|_| JwtError::Invalid(InvalidReason::Malformed))
}

/// 以 `key` 驗證 `alg` 的簽章，再檢查宣告與 `exp`（模組說明的步驟 4 至 6）；標頭已由呼叫端解析。
fn decode_claims(
    token: &str,
    key: &DecodingKey,
    alg: Algorithm,
    now_ms: i64,
) -> Result<Claims, JwtError> {
    let claims = jsonwebtoken::decode::<Claims>(token, key, &signature_only(alg))
        .map_err(|error| JwtError::Invalid(reason(error.kind())))?
        .claims;
    if claims.aud != AUTHENTICATED || claims.role != AUTHENTICATED {
        return Err(JwtError::Invalid(InvalidReason::Claims));
    }
    // 以整數秒比較，與 exp 的單位相同：exp 已過 30 秒又 999 毫秒時仍接受，已過 31 秒時拒絕
    if now_ms.div_euclid(1000) > claims.exp.saturating_add(EXP_LEEWAY_SECS) {
        return Err(JwtError::Invalid(InvalidReason::Expired));
    }
    Ok(claims)
}

/// 只檢查 `alg` 與簽章的 `Validation`：目前時間由呼叫端傳入，`aud` 只接受一個受眾，所以宣告由 `decode_claims()`
/// 自己檢查。
fn signature_only(alg: Algorithm) -> Validation {
    let mut validation = Validation::new(alg);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation
}

/// jsonwebtoken 的錯誤對應的原因。
fn reason(kind: &ErrorKind) -> InvalidReason {
    match kind {
        // 標頭已解析過，所以 JSON 的錯誤來自宣告：簽章已驗證通過，但缺少欄位、型別不符或欄位重複
        ErrorKind::Json(_) => InvalidReason::Claims,
        ErrorKind::InvalidAlgorithm | ErrorKind::UnsupportedAlgorithm => InvalidReason::Algorithm,
        ErrorKind::InvalidToken | ErrorKind::Base64(_) | ErrorKind::Utf8(_) => {
            InvalidReason::Malformed
        }
        // 簽章不符，或公鑰無法用來驗證（例如 JWKS 中的座標不在曲線上）
        _ => InvalidReason::Signature,
    }
}

/// `aud` 是字串，或只有一個字串的陣列（RFC 7519 4.1.3）；空的陣列與有兩個以上受眾的陣列不接受。
fn single_audience<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Audience {
        One(String),
        List(Vec<String>),
    }
    match Audience::deserialize(deserializer)? {
        Audience::One(audience) => Ok(audience),
        Audience::List(list) => <[String; 1]>::try_from(list)
            .map(|[audience]| audience)
            .map_err(|_| serde::de::Error::custom("aud 必須只有一個受眾")),
    }
}

/// JWKS 在 `supabase_url` 之下的網址；網址無效時是 `None`。
fn jwks_url(supabase_url: &str) -> Option<Url> {
    let mut base = Url::parse(supabase_url).ok()?;
    if !matches!(base.scheme(), "http" | "https") || base.cannot_be_a_base() {
        return None;
    }
    // 端點接在原本的路徑之後（例如 https://example.com/supabase/auth/v1/…），所以路徑要以 / 結尾
    if !base.path().ends_with('/') {
        let path = format!("{}/", base.path());
        base.set_path(&path);
    }
    base.set_query(None);
    base.set_fragment(None);
    base.join(JWKS_PATH).ok()
}

/// JWKS 的內容：`keys` 必須是陣列，其中每一把各自解析。
#[derive(Deserialize)]
struct JwkSetBody {
    keys: Vec<Value>,
}

/// JWKS 中可以驗證 ES256 的公鑰，依 `kid`；內容不是 `{"keys": [...]}` 時是 `None`。無法解析或不能用於 ES256 的
/// 公鑰略過，同一個 `kid` 出現兩次時取第一把。
fn parse_jwks(body: &[u8]) -> Option<HashMap<String, DecodingKey>> {
    let set: JwkSetBody = serde_json::from_slice(body).ok()?;
    let mut keys = HashMap::new();
    for value in set.keys {
        let Ok(jwk) = serde_json::from_value::<Jwk>(value) else {
            continue;
        };
        if let Some((kid, key)) = es256_key(&jwk) {
            keys.entry(kid).or_insert(key);
        }
    }
    Some(keys)
}

/// 可以驗證 ES256 的公鑰與它的 `kid`：`kty` 是 `EC`、`crv` 是 `P-256`、`kid` 不是空的，而且 `alg`、`use` 與
/// `key_ops` 有設定時分別是 `ES256`、`sig` 與包含 `verify`。
fn es256_key(jwk: &Jwk) -> Option<(String, DecodingKey)> {
    let kid = jwk.common.key_id.as_deref().filter(|kid| !kid.is_empty())?;
    let AlgorithmParameters::EllipticCurve(params) = &jwk.algorithm else {
        return None;
    };
    let usable = params.curve == EllipticCurve::P256
        && matches!(jwk.common.key_algorithm, None | Some(KeyAlgorithm::ES256))
        && matches!(
            jwk.common.public_key_use,
            None | Some(PublicKeyUse::Signature)
        )
        && jwk
            .common
            .key_operations
            .as_ref()
            .is_none_or(|ops| ops.contains(&KeyOperations::Verify));
    if !usable {
        return None;
    }
    let key = DecodingKey::from_ec_components(&params.x, &params.y).ok()?;
    Some((kid.to_owned(), key))
}

/// 系統時間（Unix 毫秒）。
fn system_now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(since) => i64::try_from(since.as_millis()).unwrap_or(i64::MAX),
        Err(before) => i64::try_from(before.duration().as_millis()).map_or(i64::MIN, |ms| -ms),
    }
}

/// 傳輸錯誤的種類，加上底層 I/O 錯誤的種類（例如 `connection refused`）；不含網址與內容。
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
