//! lm-server 的設定（design 3.5 的步驟 1 至 3）：讀取需求 2.7 的 9 個環境變數、檢查格式（需求 2.4、2.11、3.12），
//! 並在 `LM_BIND` 不是 Loopback_Address 時拒絕 Supabase CLI 的範例值（需求 2.6，B12）。
//!
//! # 讀取（需求 2.7）
//!
//! - 環境中有的變數優先，值是空字串的也算有；環境中沒有的，才取工作目錄或其上層目錄中最近的 `.env` 的值。搜尋方式、
//!   語法（以 dotenvy 解析）、開頭的 UTF-8 BOM，以及同一個名稱出現兩次時取第一個，都與 `dotenvy::dotenv()` 相同，
//!   但不寫入行程的環境變數，所以 `.env` 中的其他變數不影響 lm-server。
//! - 每個值先經 Trim_White，結果是空字串時視同未設定。
//! - `.env` 無法讀取或有一行無法解析時，訊息只有路徑與行號：dotenvy 的錯誤含有那一行的原文，其中可能有金鑰。
//!
//! # 檢查（需求 2.4、2.11、3.12）
//!
//! | 變數 | 必要 | 未設定時 | 格式 |
//! | --- | --- | --- | --- |
//! | `LM_BIND` | 否 | `127.0.0.1:8080` | `<IPv4 位址>:<埠>` 或 `[<IPv6 位址>]:<埠>`，埠 1–65535；不接受主機名稱 |
//! | `DATABASE_URL` | 是 | | 以 `postgres://` 或 `postgresql://` 開頭，而且 sqlx 能解析 |
//! | `SUPABASE_URL` | 是 | | 以 `http://` 或 `https://` 開頭 |
//! | `SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` | 是 | | |
//! | `SUPABASE_JWT_SECRET` | 否 | 只以 JWKS 驗證，HS256 的 access token 一律無效 | |
//! | `LM_AUTH_EMAIL_DOMAIN` | 否 | `users.little-moments.invalid` | |
//! | `LM_PUBLIC_SIGNUP` | 否 | `true` | 只接受 `true` 與 `false` |
//! | `LM_STATIC_DIR` | 是 | | |
//!
//! 不通過時一次列出每個未設定的必要變數與每個格式不符的變數，依 `.env.example` 的順序，附上原因與值的來源（環境或
//! `.env`）。`LM_BIND` 與 `LM_PUBLIC_SIGNUP` 另附上目前的值，但其中含有 `DATABASE_URL`、`SUPABASE_ANON_KEY`、
//! `SUPABASE_SERVICE_KEY` 或 `SUPABASE_JWT_SECRET` 的值時不附上；這四個變數的值一律不印出。
//!
//! # 不洩漏秘密（需求 2.9、2.11、2.12、5.10）
//!
//! - `Config` 的 `Debug` 不含金鑰與密碼：`Secret` 只印出 `<redacted>`，`DatabaseUrl` 只印出主機與埠，`SUPABASE_URL`
//!   的 userinfo 以 `***` 代替。sqlx 的 `PgConnectOptions` 的 `Debug` 含密碼，所以不直接印出。
//! - 解析 `DATABASE_URL` 時不送出 tracing 記錄：sqlx 會把無法辨識的查詢參數連同值寫進 warn 記錄，讀取 `~/.pgpass`
//!   時也可能記錄其中的一行。
//! - `DatabaseUrl::redact()` 把文字中的 `DATABASE_URL` 密碼換成 `***`，用於連線失敗的原因。
//!
//! # 與 design 3.5 的差異
//!
//! - `DATABASE_URL` 除了開頭，也要能由 sqlx 解析（例如埠不是數字時不通過），所以連線失敗時一定能印出主機與埠。
//! - `.env` 無法讀取或解析時，在步驟 1 就結束程序。

use std::collections::HashMap;
use std::env;
use std::fmt;
use std::fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::ops::Range;
use std::path::PathBuf;
use std::str::FromStr;

use lm_core::text::trim_white;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgConnectOptions;
use tracing::subscriber::NoSubscriber;

const LM_BIND: &str = "LM_BIND";
const DATABASE_URL: &str = "DATABASE_URL";
const SUPABASE_URL: &str = "SUPABASE_URL";
const SUPABASE_ANON_KEY: &str = "SUPABASE_ANON_KEY";
const SUPABASE_SERVICE_KEY: &str = "SUPABASE_SERVICE_KEY";
const SUPABASE_JWT_SECRET: &str = "SUPABASE_JWT_SECRET";
const LM_AUTH_EMAIL_DOMAIN: &str = "LM_AUTH_EMAIL_DOMAIN";
const LM_PUBLIC_SIGNUP: &str = "LM_PUBLIC_SIGNUP";
const LM_STATIC_DIR: &str = "LM_STATIC_DIR";

/// 需求 2.7 的 9 個環境變數，依 `.env.example` 的順序。
const VARIABLES: [&str; 9] = [
    LM_BIND,
    DATABASE_URL,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_KEY,
    SUPABASE_JWT_SECRET,
    LM_AUTH_EMAIL_DOMAIN,
    LM_PUBLIC_SIGNUP,
    LM_STATIC_DIR,
];

/// 值不能出現在訊息中的變數（需求 2.11）。
const HIDDEN: [&str; 4] = [
    DATABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_KEY,
    SUPABASE_JWT_SECRET,
];

/// `LM_BIND` 未設定時的位址（需求 2.4）。
const DEFAULT_BIND: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8080);

/// `LM_AUTH_EMAIL_DOMAIN` 未設定時的網域（需求 3.12）。
const DEFAULT_AUTH_EMAIL_DOMAIN: &str = "users.little-moments.invalid";

/// Sample_Secrets（需求 2.6）每個值的 SHA-256（小寫 hex）。以 `sha256(值)` 比對，所以仍是完全相同才算。原文不放進
/// 原始碼：CI 的 Gitleaks 會把它們當成外洩的金鑰，而秘密的發現不能列為例外（`security/exceptions.json`）。
///
/// 來源是 Supabase CLI 3.2.0 以預設設定啟動本機堆疊後，`supabase status -o env` 印出的值。JWT 密鑰、`sb_publishable_`
/// 與 `sb_secret_` 金鑰內建在 CLI 中；anon key 與 service_role key 是 CLI 以範例 JWT 密鑰簽署的 HS256 token，內容固定為
/// `{"iss":"supabase-demo","role":…,"exp":1983812996}`，所以每台電腦都相同。`PUBLISHABLE_KEY` 與 `SECRET_KEY` 是新版
/// 的 anon key 與 service_role key，可能被填進 `SUPABASE_ANON_KEY` 與 `SUPABASE_SERVICE_KEY`，所以也列入。
///
/// CLI 改版時在 Repository 根目錄以 `supabase start --network-id lm-local` 啟動，再以下列指令重新產生（只印出名稱與
/// SHA-256，不印出值）：
///
/// ```sh
/// supabase status -o env | grep -E '^(JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY|SECRET_KEY)=' |
///   while IFS= read -r line; do v=${line#*=}; v=${v#\"}; v=${v%\"}
///     printf '%s %s\n' "${line%%=*}" "$(printf '%s' "$v" | sha256sum | cut -d' ' -f1)"; done
/// ```
const SAMPLE_SECRET_DIGESTS: [&str; 5] = [
    // JWT_SECRET
    "a064b502e61d27e94b8717290e5e1b32e36720e9fbdf952ec81a84c07128cb37",
    // ANON_KEY
    "bf1725a8f98bea37e88618702e725ba84bd8acdb2647c5e0ed638bfd685791cf",
    // SERVICE_ROLE_KEY
    "70541e07fd4f900b66e289f5be55c85f9bef1def4924a5b0c518c45ea1688c12",
    // PUBLISHABLE_KEY
    "9705102db0d5f99ee08daa19a73e510d9877a2a9add9369da247cbbe6c2a0140",
    // SECRET_KEY
    "c85debb55f2f204d868cc1552c42faa143b4c675f61363ab040dd50b5b5304cd",
];

/// lm-server 的設定（需求 2.7）：`Config::from_env()` 讀取並檢查過的 9 個環境變數。`Debug` 不含金鑰與密碼。
pub struct Config {
    /// `LM_BIND`：監聽的位址與埠，未設定時是 127.0.0.1:8080（需求 2.4）。
    pub bind: SocketAddr,
    /// `DATABASE_URL`。
    pub database: DatabaseUrl,
    /// `SUPABASE_URL`：API gateway 的網址（Auth_Service、Realtime_Service 與 JWKS）。
    pub supabase_url: String,
    /// `SUPABASE_ANON_KEY`。
    pub supabase_anon_key: Secret,
    /// `SUPABASE_SERVICE_KEY`：只在伺服器端使用（需求 2.9）。
    pub supabase_service_key: Secret,
    /// `SUPABASE_JWT_SECRET`：未設定時只以 JWKS 驗證，HS256 的 access token 一律無效（需求 2.7）。
    pub supabase_jwt_secret: Option<Secret>,
    /// `LM_AUTH_EMAIL_DOMAIN`：合成 email 的網域，未設定時是 users.little-moments.invalid（需求 3.12）。
    pub auth_email_domain: String,
    /// `LM_PUBLIC_SIGNUP`：是否開放不經邀請的註冊，未設定時是 true（需求 3.12）。
    pub public_signup: bool,
    /// `LM_STATIC_DIR`：LM_Web 的靜態檔目錄。
    pub static_dir: PathBuf,
}

impl Config {
    /// design 3.5 的步驟 1 與 2（需求 2.7、2.11、3.12）：讀取 9 個環境變數（見模組說明），經 Trim_White 後檢查格式，
    /// 一次回報每個未設定或格式不符的變數。
    pub fn from_env() -> Result<Self, ConfigError> {
        let values = Values {
            dotenv: DotEnv::find()?,
        };
        if let Some(dotenv) = &values.dotenv {
            let filled: Vec<&str> = VARIABLES
                .into_iter()
                .filter(|name| {
                    matches!(
                        values.get(name),
                        Value::Set {
                            source: Source::DotEnv,
                            ..
                        }
                    )
                })
                .collect();
            tracing::info!(path = %dotenv.path.display(), filled = %filled.join(" "), "read .env");
        }
        Self::check(&values).map_err(|problems| ConfigError::Invalid {
            problems,
            dotenv: values.dotenv.map(|dotenv| dotenv.path),
        })
    }

    /// design 3.5 的步驟 3（需求 2.6，B12）：`LM_BIND` 不是 Loopback_Address（127.0.0.0/8 與 ::1；0.0.0.0 與 :: 都
    /// 不是）時，`SUPABASE_JWT_SECRET`、`SUPABASE_ANON_KEY` 與 `SUPABASE_SERVICE_KEY` 都不能與 Sample_Secrets 中的任何
    /// 一個值相同。錯誤列出 `LM_BIND` 的值與相同的變數名稱，不含它們的值。
    pub fn refuse_sample_secrets_off_loopback(&self) -> Result<(), SampleSecretsOffLoopback> {
        if self.bind.ip().is_loopback() {
            return Ok(());
        }
        let names: Vec<&'static str> = [
            (SUPABASE_JWT_SECRET, self.supabase_jwt_secret.as_ref()),
            (SUPABASE_ANON_KEY, Some(&self.supabase_anon_key)),
            (SUPABASE_SERVICE_KEY, Some(&self.supabase_service_key)),
        ]
        .into_iter()
        .filter(|(_, value)| value.is_some_and(|value| is_sample_secret(value.expose())))
        .map(|(name, _)| name)
        .collect();
        if names.is_empty() {
            Ok(())
        } else {
            Err(SampleSecretsOffLoopback {
                bind: self.bind,
                names,
            })
        }
    }

    /// Realtime 轉送的上游網址（design 3.4，需求 11.2）：`SUPABASE_URL` 去掉查詢與片段，`http://` 換成 `ws://`、
    /// `https://` 換成 `wss://`，原本的路徑（可以有前綴）之後接 `realtime/v1/websocket`。查詢參數只有 `query`（瀏覽器
    /// 送來的原始查詢字串）中第一個 `vsn`，再加上值為 `SUPABASE_ANON_KEY` 的 `apikey`；瀏覽器送來的 `apikey` 與其他
    /// 參數都不轉送。回傳的網址含有 anon key，不能寫進記錄或回應。
    pub fn realtime_upstream_url(&self, query: Option<&str>) -> String {
        let base = &self.supabase_url;
        let base = &base[..base.find(['?', '#']).unwrap_or(base.len())];
        let (scheme, rest) = match base.strip_prefix("https://") {
            Some(rest) => ("wss://", rest),
            None => ("ws://", base.strip_prefix("http://").unwrap_or(base)),
        };
        let slash = if rest.ends_with('/') { "" } else { "/" };
        let mut url = format!("{scheme}{rest}{slash}realtime/v1/websocket?");
        let vsn = query
            .into_iter()
            .flat_map(|query| query.split('&'))
            .find_map(|pair| {
                let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
                (percent_decode(&name.replace('+', " ")) == "vsn")
                    .then(|| percent_decode(&value.replace('+', " ")))
            });
        if let Some(vsn) = vsn {
            url.push_str("vsn=");
            url.push_str(&percent_encode(&vsn));
            url.push('&');
        }
        url.push_str("apikey=");
        url.push_str(&percent_encode(self.supabase_anon_key.expose()));
        url
    }

    /// 依 `.env.example` 的順序檢查每個變數，不通過的全部記下（需求 2.11）。
    fn check(values: &Values) -> Result<Self, Vec<Problem>> {
        let mut checker = Checker {
            values,
            problems: Vec::new(),
        };
        let bind = checker.check(LM_BIND, Echo::Value, |value| {
            value.map_or(Ok(DEFAULT_BIND), parse_bind)
        });
        let database = checker.check(DATABASE_URL, Echo::Nothing, |value| {
            DatabaseUrl::parse(required(value)?)
        });
        let supabase_url = checker.check(SUPABASE_URL, Echo::Nothing, |value| {
            parse_supabase_url(required(value)?)
        });
        let supabase_anon_key = checker.check(SUPABASE_ANON_KEY, Echo::Nothing, |value| {
            required(value).map(Secret::new)
        });
        let supabase_service_key = checker.check(SUPABASE_SERVICE_KEY, Echo::Nothing, |value| {
            required(value).map(Secret::new)
        });
        let supabase_jwt_secret = checker.check(SUPABASE_JWT_SECRET, Echo::Nothing, |value| {
            Ok(value.map(Secret::new))
        });
        let auth_email_domain = checker.check(LM_AUTH_EMAIL_DOMAIN, Echo::Nothing, |value| {
            Ok(value.unwrap_or(DEFAULT_AUTH_EMAIL_DOMAIN).to_owned())
        });
        let public_signup = checker.check(LM_PUBLIC_SIGNUP, Echo::Value, |value| {
            value.map_or(Ok(true), parse_public_signup)
        });
        let static_dir = checker.check(LM_STATIC_DIR, Echo::Nothing, |value| {
            required(value).map(PathBuf::from)
        });
        match (
            bind,
            database,
            supabase_url,
            supabase_anon_key,
            supabase_service_key,
            supabase_jwt_secret,
            auth_email_domain,
            public_signup,
            static_dir,
        ) {
            (
                Some(bind),
                Some(database),
                Some(supabase_url),
                Some(supabase_anon_key),
                Some(supabase_service_key),
                Some(supabase_jwt_secret),
                Some(auth_email_domain),
                Some(public_signup),
                Some(static_dir),
            ) => Ok(Self {
                bind,
                database,
                supabase_url,
                supabase_anon_key,
                supabase_service_key,
                supabase_jwt_secret,
                auth_email_domain,
                public_signup,
                static_dir,
            }),
            _ => Err(checker.problems),
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("bind", &self.bind)
            .field("database", &self.database)
            .field("supabase_url", &without_userinfo(&self.supabase_url))
            .field("supabase_anon_key", &self.supabase_anon_key)
            .field("supabase_service_key", &self.supabase_service_key)
            .field("supabase_jwt_secret", &self.supabase_jwt_secret)
            .field("auth_email_domain", &self.auth_email_domain)
            .field("public_signup", &self.public_signup)
            .field("static_dir", &self.static_dir)
            .finish()
    }
}

/// 不能出現在訊息與記錄中的值（需求 2.9、2.11、5.10）：`Debug` 只印出 `<redacted>`，也沒有 `Display`；需要值的地方
/// 呼叫 `expose()`。
pub struct Secret(String);

impl Secret {
    fn new(value: &str) -> Self {
        Self(value.to_owned())
    }

    /// 原本的值：只用於送給 Supabase 或驗證 token，不寫進訊息與記錄。
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// `DATABASE_URL`（需求 2.11、2.12）：sqlx 的連線設定，以及網址中的密碼。`Debug` 只印出主機與埠。
pub struct DatabaseUrl {
    /// 連線設定，含密碼；它的 `Debug` 含密碼，所以不能印出。
    pub options: PgConnectOptions,
    /// 網址中的密碼，由長到短（見 `url_passwords()`）。
    passwords: Vec<String>,
}

impl DatabaseUrl {
    fn parse(text: &str) -> Result<Self, String> {
        if !(text.starts_with("postgres://") || text.starts_with("postgresql://")) {
            return Err("必須以 postgres:// 或 postgresql:// 開頭".to_owned());
        }
        // sqlx 解析時把無法辨識的查詢參數連同值寫進 warn 記錄，讀取 ~/.pgpass 時也可能記錄其中的一行，所以不送出記錄
        let options = tracing::subscriber::with_default(NoSubscriber::default(), || {
            PgConnectOptions::from_str(text)
        })
        .map_err(|_| "無法解析成 PostgreSQL 的連線網址（請檢查主機、埠與查詢參數）".to_owned())?;
        Ok(Self {
            options,
            passwords: url_passwords(text),
        })
    }

    /// Database 的主機與埠；以 Unix socket 連線時，主機是 socket 所在的目錄（需求 2.12）。
    pub fn host_and_port(&self) -> (String, u16) {
        let host = match self.options.get_socket() {
            Some(dir) => dir.display().to_string(),
            None => self.options.get_host().to_owned(),
        };
        (host, self.options.get_port())
    }

    /// 把 `text` 中出現的 `DATABASE_URL` 密碼換成 `***`（需求 2.12：連線失敗的原因不含密碼）。
    pub fn redact(&self, text: &str) -> String {
        self.passwords
            .iter()
            .fold(text.to_owned(), |text, password| {
                text.replace(password.as_str(), "***")
            })
    }
}

impl fmt::Debug for DatabaseUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (host, port) = self.host_and_port();
        write!(f, "{host}:{port}")
    }
}

/// `Config::from_env()` 的錯誤（design 3.5 的步驟 1 與 2）；訊息不含金鑰與密碼。
pub enum ConfigError {
    /// 無法尋找或讀取 `.env`，或其中有一行無法解析；內容是完整的說明，不含 `.env` 的內容。
    DotEnv(String),
    /// 未設定或格式不符的變數，以及補上變數的 `.env`（沒有時是 `None`）。
    Invalid {
        problems: Vec<Problem>,
        dotenv: Option<PathBuf>,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::DotEnv(reason) => f.write_str(reason),
            ConfigError::Invalid { problems, dotenv } => {
                writeln!(f, "下列環境變數未設定或格式不符：")?;
                for problem in problems {
                    writeln!(f, "  {problem}")?;
                }
                match dotenv {
                    Some(path) => write!(f, "環境中沒有設定的變數由 {} 補上；", path.display())?,
                    None => write!(
                        f,
                        "工作目錄與其上層目錄中沒有 .env（可以把 .env.example 複製成 .env 再填值）；"
                    )?,
                }
                write!(f, "每個值先去除前後的空白，空的值視同未設定。")
            }
        }
    }
}

/// 一個未設定或格式不符的變數（需求 2.11）。
pub struct Problem {
    name: &'static str,
    /// 值的來源；未設定時是 `None`。
    source: Option<Source>,
    reason: String,
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let source = match self.source {
            Some(Source::Environment) => "（來自環境變數）",
            Some(Source::DotEnv) => "（來自 .env）",
            None => "",
        };
        write!(f, "{}{source}：{}", self.name, self.reason)
    }
}

/// `LM_BIND` 不是 Loopback_Address，而這些變數與 Sample_Secrets 相同（需求 2.6）。
pub struct SampleSecretsOffLoopback {
    bind: SocketAddr,
    names: Vec<&'static str>,
}

impl fmt::Display for SampleSecretsOffLoopback {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "LM_BIND={} 不是 loopback 位址（只有 127.0.0.0/8 與 ::1 是；0.0.0.0 與 :: 會在每個網路介面監聽），\
             但 {} 是 Supabase CLI 公開的範例值。範例值任何人都查得到，只能在只有這台電腦連得到的 loopback 位址使用：\
             請把 LM_BIND 改回 127.0.0.1:8080，或改用自己產生的 JWT 密鑰與金鑰。",
            self.bind,
            self.names.join("、"),
        )
    }
}

/// 值的來源。
#[derive(Clone, Copy)]
enum Source {
    Environment,
    DotEnv,
}

/// 一個變數的值（需求 2.7）。
enum Value {
    /// 沒有設定，或經 Trim_White 之後是空字串。
    Unset,
    /// 經 Trim_White 的值。
    Set { text: String, source: Source },
    /// 環境中的值不是有效的 UTF-8。
    NotUnicode,
}

/// 9 個環境變數的來源：環境，以及環境中沒有時取用的 `.env`。
struct Values {
    dotenv: Option<DotEnv>,
}

impl Values {
    /// `name` 的值：環境中有的優先（包括空字串），沒有時取 `.env`；經 Trim_White 後是空字串時視同未設定。
    fn get(&self, name: &str) -> Value {
        let (raw, source) = match env::var_os(name) {
            Some(value) => match value.into_string() {
                Ok(text) => (text, Source::Environment),
                Err(_) => return Value::NotUnicode,
            },
            None => match self
                .dotenv
                .as_ref()
                .and_then(|dotenv| dotenv.values.get(name))
            {
                Some(text) => (text.clone(), Source::DotEnv),
                None => return Value::Unset,
            },
        };
        match trim_white(&raw) {
            "" => Value::Unset,
            text => Value::Set {
                text: text.to_owned(),
                source,
            },
        }
    }

    /// `text` 含有 `HIDDEN` 中某個變數的值，所以不能放進訊息（需求 2.11）。
    fn reveals_hidden(&self, text: &str) -> bool {
        HIDDEN.into_iter().any(|name| {
            matches!(self.get(name), Value::Set { text: hidden, .. } if text.contains(hidden.as_str()))
        })
    }
}

/// 不通過時是否在原因後面附上目前的值。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Echo {
    Value,
    Nothing,
}

/// 依序檢查變數，記下每一個不通過的（需求 2.11：一次列出）。
struct Checker<'a> {
    values: &'a Values,
    problems: Vec<Problem>,
}

impl Checker<'_> {
    /// 以 `parse` 檢查 `name` 的值（未設定時是 `None`）；不通過時記下原因並回傳 `None`。`echo` 是 `Echo::Value` 時，
    /// 原因後面附上目前的值，但其中含有 `HIDDEN` 的值時不附上。
    fn check<T>(
        &mut self,
        name: &'static str,
        echo: Echo,
        parse: impl FnOnce(Option<&str>) -> Result<T, String>,
    ) -> Option<T> {
        let (text, source) = match self.values.get(name) {
            Value::Unset => (None, None),
            Value::Set { text, source } => (Some(text), Some(source)),
            Value::NotUnicode => {
                self.problems.push(Problem {
                    name,
                    source: Some(Source::Environment),
                    reason: "不是有效的 UTF-8 文字".to_owned(),
                });
                return None;
            }
        };
        let reason = match parse(text.as_deref()) {
            Ok(parsed) => return Some(parsed),
            Err(reason) => reason,
        };
        let reason = match text {
            Some(text) if echo == Echo::Value && !self.values.reveals_hidden(&text) => {
                format!("{reason}（目前的值是 {text:?}）")
            }
            _ => reason,
        };
        self.problems.push(Problem {
            name,
            source,
            reason,
        });
        None
    }
}

/// 工作目錄或其上層目錄中最近的 `.env`：路徑與其中的值（同一個名稱出現兩次時取第一個）。
struct DotEnv {
    path: PathBuf,
    values: HashMap<String, String>,
}

impl DotEnv {
    /// 與 `dotenvy::dotenv()` 相同：從工作目錄往上找第一個是檔案的 `.env`；都沒有時是 `None`。
    fn find() -> Result<Option<Self>, ConfigError> {
        let cwd = env::current_dir().map_err(|error| {
            ConfigError::DotEnv(format!("無法取得工作目錄，所以無法尋找 .env：{error}"))
        })?;
        for dir in cwd.ancestors() {
            let path = dir.join(".env");
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => return Self::read(path).map(Some),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(ConfigError::DotEnv(format!(
                        "無法讀取 {}：{error}",
                        path.display()
                    )))
                }
            }
        }
        Ok(None)
    }

    /// 讀取並解析 `path`。dotenvy 的錯誤含有無法解析的那一行的原文，所以訊息只有路徑與行號。
    fn read(path: PathBuf) -> Result<Self, ConfigError> {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                return Err(ConfigError::DotEnv(format!(
                    "無法讀取 {}：{error}",
                    path.display()
                )))
            }
        };
        // 與 dotenvy::dotenv() 相同，去掉開頭的 UTF-8 BOM（Windows 的編輯器可能加上）
        let content = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
        let mut values = HashMap::new();
        for item in dotenvy::from_read_iter(content) {
            let error = match item {
                Ok((name, value)) => {
                    values.entry(name).or_insert(value);
                    continue;
                }
                Err(dotenvy::Error::LineParse(text, _)) => {
                    let line = line_number(content, &text)
                        .map_or_else(|| "有一行".to_owned(), |number| format!("第 {number} 行"));
                    format!(
                        "{} {line}無法解析：每一行必須是「名稱=值」，值有引號時引號要成對",
                        path.display()
                    )
                }
                Err(dotenvy::Error::Io(error)) => format!("無法讀取 {}：{error}", path.display()),
                Err(_) => format!("無法讀取 {}", path.display()),
            };
            return Err(ConfigError::DotEnv(error));
        }
        Ok(Self { path, values })
    }
}

/// 必要變數的值；未設定時不通過。
fn required(value: Option<&str>) -> Result<&str, String> {
    value.ok_or_else(|| "未設定".to_owned())
}

/// `LM_BIND`（需求 2.4）：`<IPv4 位址>:<埠>` 或 `[<IPv6 位址>]:<埠>`，埠 1–65535；主機名稱不接受。
fn parse_bind(text: &str) -> Result<SocketAddr, String> {
    const FORMAT: &str =
        "格式必須是 <IPv4 位址>:<埠> 或 [<IPv6 位址>]:<埠>，例如 127.0.0.1:8080 或 [::1]:8080；\
         不接受 localhost:8080 這類主機名稱";
    const PORT: &str = "埠必須是 1–65535";
    match text.parse::<SocketAddr>() {
        Ok(addr) if addr.port() == 0 => Err(PORT.to_owned()),
        Ok(addr) => Ok(addr),
        Err(_) if port_out_of_range(text) => Err(PORT.to_owned()),
        Err(_) => Err(FORMAT.to_owned()),
    }
}

/// 位址正確、只有埠超出範圍（例如 `127.0.0.1:70000`）。
fn port_out_of_range(text: &str) -> bool {
    text.rsplit_once(':').is_some_and(|(address, port)| {
        !port.is_empty()
            && port.bytes().all(|byte| byte.is_ascii_digit())
            && format!("{address}:1").parse::<SocketAddr>().is_ok()
    })
}

/// `SUPABASE_URL`（需求 2.11）。
fn parse_supabase_url(text: &str) -> Result<String, String> {
    if text.starts_with("http://") || text.starts_with("https://") {
        Ok(text.to_owned())
    } else {
        Err("必須以 http:// 或 https:// 開頭".to_owned())
    }
}

/// `LM_PUBLIC_SIGNUP`（需求 3.12）：只接受 `true` 與 `false`。
fn parse_public_signup(text: &str) -> Result<bool, String> {
    match text {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err("只接受小寫的 true 或 false".to_owned()),
    }
}

/// `value` 與 Sample_Secrets 中的某一個值完全相同（以 SHA-256 比對，見 `SAMPLE_SECRET_DIGESTS`）。
fn is_sample_secret(value: &str) -> bool {
    let digest = hex::encode(Sha256::digest(value.as_bytes()));
    SAMPLE_SECRET_DIGESTS.contains(&digest.as_str())
}

/// `DATABASE_URL` 中的密碼（sqlx 接受的兩種寫法）：userinfo 的 `user:password@`，以及查詢參數 `password=`。各取原樣
/// 與解碼後的文字，由長到短，所以較長的密碼先被取代。
fn url_passwords(url: &str) -> Vec<String> {
    let mut passwords = Vec::new();
    if let Some((_, password)) = userinfo_range(url).and_then(|range| url[range].split_once(':')) {
        passwords.push(password.to_owned());
        passwords.push(percent_decode(password));
    }
    let query = url.split_once('?').map_or("", |(_, query)| query);
    let query = query.split_once('#').map_or(query, |(query, _)| query);
    for value in query
        .split('&')
        .filter_map(|pair| pair.strip_prefix("password="))
    {
        passwords.push(value.to_owned());
        passwords.push(percent_decode(&value.replace('+', " ")));
    }
    passwords.retain(|password| !password.is_empty());
    passwords.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    passwords.dedup();
    passwords
}

/// 網址的 userinfo（`://` 之後、authority 中最後一個 `@` 之前）的位置；沒有 userinfo 時是 `None`。
fn userinfo_range(url: &str) -> Option<Range<usize>> {
    let start = url.find("://")? + 3;
    let rest = &url[start..];
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    authority.rfind('@').map(|at| start..start + at)
}

/// `url` 的 userinfo 換成 `***`（記錄中不含密碼，需求 5.10）。
fn without_userinfo(url: &str) -> String {
    match userinfo_range(url) {
        Some(range) => format!("{}***{}", &url[..range.start], &url[range.end..]),
        None => url.to_owned(),
    }
}

/// 百分比編碼：RFC 3986 的 unreserved 字元（英文字母、數字與 `-._~`）原樣保留，其他位元組寫成 `%XX`，使結果可以
/// 放進網址的查詢參數（Realtime 轉送的上游網址，`Config::realtime_upstream_url`）。
pub fn percent_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// 百分比解碼（`%XX`）：後面不是兩個十六進位數字的 `%` 原樣保留；解碼後不是 UTF-8 的位元組以 U+FFFD 代替。靜態檔
/// 也以它檢查請求的路徑（`static_files`）。
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = match bytes[index] {
            b'%' => bytes
                .get(index + 1..index + 3)
                .and_then(|digits| hex::decode(digits).ok()),
            _ => None,
        };
        match escaped {
            Some(byte) => {
                decoded.extend(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// dotenvy 無法解析的文字（那一行，或那一行等號之後的部分；可能跨行）在 `content` 中的行號。只出現一次時才能確定
/// 是哪一行，否則是 `None`。
fn line_number(content: &[u8], text: &str) -> Option<usize> {
    let text = text.as_bytes();
    if text.is_empty() {
        return None;
    }
    let mut found = content
        .windows(text.len())
        .enumerate()
        .filter(|(_, window)| *window == text)
        .map(|(at, _)| at);
    let at = found.next()?;
    if found.next().is_some() {
        return None;
    }
    Some(content[..at].iter().filter(|&&byte| byte == b'\n').count() + 1)
}
