//! little-moments-server（lm-server）：日子拾光的 axum 服務。
//!
//! 啟動依 design 3.5 的順序；任何一步失敗都在開始監聽之前於 stderr 印出原因，並以結束代碼 1 結束：
//!
//! 1. 讀取設定、2. 檢查格式：`Config::from_env()`（需求 2.7、2.11、3.12）。
//! 3. 範例金鑰：`Config::refuse_sample_secrets_off_loopback()`（需求 2.6）。
//! 4. 連上 Database：`db::connect_within()`，30 秒內每秒嘗試一次（需求 2.12）。
//! 5. 監聽 `LM_BIND`（需求 2.4、2.12）。
//!
//! 記錄以 tracing 寫到 stdout，層級由 `RUST_LOG` 決定（未設定時是 info）。記錄與訊息都不含 token、密碼，以及
//! `DATABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY`、`SUPABASE_JWT_SECRET` 的值（需求 2.9、5.10）。
//!
//! `app()` 由任務 13.3 加入 `AppState`、`/api` 路由器與靜態檔；HTTP API、命令執行器、登入代理與 Realtime 轉送由
//! 之後的任務依 design「Components and Interfaces」3 實作。

mod config;
mod db;
// `/api/*` 的錯誤回應與請求擷取器（任務 13.2），由任務 13.3 至 16 的路由使用。一個模組的項目全部用上之後，它的
// expect 不再成立，編譯器會警告，屆時移除那一個 expect。
#[expect(dead_code, reason = "任務 13.3 至 16 的路由才會使用")]
mod error;
#[expect(dead_code, reason = "任務 13.3 至 16 的路由才會使用")]
mod extract;

use std::fmt::Display;
use std::io::{self, IsTerminal};
use std::process::ExitCode;

use axum::Router;
use sqlx::PgPool;
use tokio::net::TcpListener;
use tracing_subscriber::filter::{EnvFilter, LevelFilter};

use crate::config::Config;

#[tokio::main]
async fn main() -> ExitCode {
    init_tracing();

    // 1、2：讀取設定並檢查格式
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => return startup_failed(error),
    };
    // 3：LM_BIND 不是 loopback 位址時拒絕範例金鑰
    if let Err(error) = config.refuse_sample_secrets_off_loopback() {
        return startup_failed(error);
    }
    tracing::info!(?config, "configuration loaded");

    // 4：連上 Database
    let pool = match db::connect_within(&config.database, db::CONNECT_WITHIN).await {
        Ok(pool) => pool,
        Err(error) => return startup_failed(error),
    };

    let bind = config.bind;
    let app = app(config, pool);

    // 5：監聽
    let listener = match TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(error) => {
            return startup_failed(format!("無法在 {bind} 監聽：{error}{}", bind_hint(&error)))
        }
    };
    tracing::info!(address = %bind, "listening");

    match axum::serve(listener, app).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lm-server 停止：{error}");
            ExitCode::FAILURE
        }
    }
}

/// HTTP 服務。任務 13.3 在這裡建立 `AppState`，加入 `/api` 路由器、`/realtime/v1/websocket` 與 `LM_STATIC_DIR` 的
/// 靜態檔；在那之前每個路徑都回應 404。
fn app(_config: Config, pool: PgPool) -> Router {
    Router::new().with_state(pool)
}

/// tracing 的記錄寫到 stdout；層級由 `RUST_LOG` 決定，未設定或無法解析的部分以 info 代替。
fn init_tracing() {
    let filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .from_env_lossy();
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(io::stdout().is_terminal())
        .init();
}

/// 在開始監聽之前失敗（需求 2.6、2.11、2.12）：印出原因，以結束代碼 1 結束。
fn startup_failed(reason: impl Display) -> ExitCode {
    eprintln!("lm-server 無法啟動：{reason}");
    ExitCode::FAILURE
}

/// 常見的監聽錯誤的說明（需求 2.12）。
fn bind_hint(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::AddrInUse => "（這個埠已被其他程式使用）",
        io::ErrorKind::AddrNotAvailable => {
            "（這個位址不屬於這台電腦；在 WSL 2 中不能使用 Windows 網路介面的位址）"
        }
        io::ErrorKind::PermissionDenied => {
            "（沒有權限使用這個埠；1024 以下的埠需要系統管理員權限）"
        }
        _ => "",
    }
}
