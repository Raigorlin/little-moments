//! little-moments-server（lm-server）：日子拾光的 axum 服務。
//!
//! 啟動依 design 3.5 的順序；任何一步失敗都在開始監聽之前於 stderr 印出原因，並以結束代碼 1 結束：
//!
//! 1. 讀取設定、2. 檢查格式：`Config::from_env()`（需求 2.7、2.11、3.12）。
//! 3. 範例金鑰：`Config::refuse_sample_secrets_off_loopback()`（需求 2.6）。
//! 4. 建立 Supabase 的用戶端：`SupabaseClients::new()`。design 3.5 沒有這一步：它只檢查 `SUPABASE_URL` 與金鑰能否用於
//!    HTTP 請求，不連線，所以放在連上 Database 之前，設定有誤時不必等待。
//! 5. 連上 Database：`db::connect_within()`，30 秒內每秒嘗試一次（需求 2.12）。
//! 6. 監聽 `LM_BIND`（需求 2.4、2.12）。
//!
//! 監聽之前另以 `static_files::check()` 確認 `LM_STATIC_DIR` 中有 index.html，沒有時只記下警告。收到 Ctrl-C（SIGINT）或
//! SIGTERM 時不再接受新的連線，等進行中的請求完成、關閉連線池之後以結束代碼 0 結束；已升級成 WebSocket 的連線不等待。
//!
//! 記錄以 tracing 寫到 stdout，層級由 `RUST_LOG` 決定（未設定時是 info）。記錄與訊息都不含 token、密碼，以及
//! `DATABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY`、`SUPABASE_JWT_SECRET` 的值（需求 2.9、5.10）。不加
//! tower-http 的 `TraceLayer`：它記下完整的網址，而邀請連結的 token 就在路徑中（`/invite/<token>`、
//! `/api/invites/<token>`）。
//!
//! # 路由（design 3.1 與「伺服器：路由」）
//!
//! | 路徑 | 處理 |
//! | --- | --- |
//! | `/api`、`/api/` 與 `/api/<路徑>` | `api_router()`：`api_routes()` 中的端點（由任務 14 至 16 加入）；沒有這個路徑時 404 `api_not_found`，路徑存在但不支援這個方法時 405 `method_not_allowed`，都是 JSON，不回傳 index.html（需求 5.5、5.9） |
//! | `/realtime/v1/websocket` | `GET`：Realtime 轉送（`gateway::realtime_proxy`，需求 11.2、11.12）；不是 WebSocket 升級的 `GET` 由 axum 回應 4xx，其他方法 405，都不回傳 index.html |
//! | 其他 | `LM_STATIC_DIR` 的靜態檔，找不到時回傳 index.html（`static_files`，需求 32.2） |
//!
//! `/api` 本身與 `/api/` 也屬於 API：`api` 是保留的帳號名稱（需求 3.3），LM_Web 沒有這兩個網址的畫面。axum 0.8 的
//! `nest("/api", …)` 涵蓋 `/api` 與 `/api/<路徑>`，但不涵蓋 `/api/`，所以另以 `/api/` 的路由回應同樣的 404。axum 以
//! 請求原本的路徑比對路由，不先正規化 `..` 或百分比編碼，所以 `/api/../login` 仍屬於 `/api`（404 `api_not_found`）。
//!
//! 路由器的狀態是 `AppState`（`state`）：連線池、Auth_Service 的用戶端、access token 的驗證器、設定與時鐘；登入狀態與
//! 旅行資料都不保存在記憶體中（需求 1.11）。

mod auth;
mod commands;
mod config;
mod db;
// `/api/*` 的錯誤回應與請求擷取器（任務 13.2），由任務 13.3 至 16 的路由使用。一個模組的項目全部用上之後，它的
// expect 不再成立，編譯器會警告，屆時移除那一個 expect。
#[expect(dead_code, reason = "任務 13.3 至 16 的路由才會使用")]
mod error;
#[expect(dead_code, reason = "任務 13.3 至 16 的路由才會使用")]
mod extract;
mod gateway;
mod invites;
mod repo;
mod state;
mod static_files;
mod trips;

use std::fmt::Display;
use std::io::{self, IsTerminal};
use std::process::ExitCode;

use axum::extract::Request;
use axum::routing::{any, delete, get, post};
use axum::Router;
use tokio::net::TcpListener;
use tracing_subscriber::filter::{EnvFilter, LevelFilter};

use crate::config::Config;
use crate::error::ApiError;
use crate::state::{AppState, SupabaseClients};
use crate::static_files::StaticFiles;

/// Realtime 轉送的路徑（需求 11.2）。
const REALTIME_PATH: &str = "/realtime/v1/websocket";

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

    // 4：建立 Supabase 的用戶端（不連線）
    let clients = match SupabaseClients::new(&config) {
        Ok(clients) => clients,
        Err(error) => return startup_failed(error),
    };

    // 5：連上 Database
    let pool = match db::connect_within(&config.database, db::CONNECT_WITHIN).await {
        Ok(pool) => pool,
        Err(error) => return startup_failed(error),
    };

    static_files::check(&config.static_dir);
    let bind = config.bind;
    let app = app(AppState::new(config, pool.clone(), clients));

    // 6：監聽
    let listener = match TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(error) => {
            return startup_failed(format!("無法在 {bind} 監聽：{error}{}", bind_hint(&error)))
        }
    };
    tracing::info!(address = %bind, "listening");

    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    pool.close().await;
    match served {
        Ok(()) => {
            tracing::info!("stopped");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("lm-server 停止：{error}");
            ExitCode::FAILURE
        }
    }
}

/// HTTP 服務（見模組說明的「路由」）。
fn app(state: AppState) -> Router {
    let static_files = StaticFiles::new(&state.config.static_dir);
    Router::new()
        .nest("/api", api_router())
        .route("/api/", any(api_not_found))
        .route(REALTIME_PATH, get(gateway::realtime_proxy))
        .fallback(move |request: Request| static_files.clone().serve(request))
        .with_state(state)
}

/// `/api` 路由器：`api_routes()` 的端點，加上自己的 fallback 與 method-not-allowed fallback（design 3.1 的步驟 1）。
/// axum 的 `method_not_allowed_fallback()` 只套用到已經加入的路由，所以端點一律加在 `api_routes()` 中。
fn api_router() -> Router<AppState> {
    api_routes()
        .fallback(api_not_found)
        .method_not_allowed_fallback(api_method_not_allowed)
}

/// `/api` 之下的端點（design 3.1 的表）：任務 14 至 16 在這裡以 `.route(…)` 加入，路徑不含 `/api`（例如
/// `.route("/me", get(auth::me))`），含旅行 id 的路徑參數一律寫成 `{id}`（`TripPath`）。
fn api_routes() -> Router<AppState> {
    Router::new()
        .route("/auth/signup", post(auth::signup_handler))
        .route("/auth/login", post(auth::login_handler))
        .route("/auth/refresh", post(auth::refresh_handler))
        .route("/auth/logout", post(auth::logout_handler))
        .route("/me", get(auth::me))
        .route("/trips", get(trips::list_trips).post(trips::create_trip))
        .route("/trips/{id}", delete(trips::delete_trip))
        .route("/trips/{id}/snapshot", get(trips::snapshot))
        .route("/trips/{id}/changes", get(trips::changes))
        .route("/trips/{id}/head", get(trips::head))
        .route("/trips/{id}/commands", post(commands::post_command))
        .route(
            "/trips/{id}/invites",
            get(invites::list).post(invites::create),
        )
        .route(
            "/trips/{id}/invites/{invite_id}/revoke",
            post(invites::revoke),
        )
        .route("/invites/{token}", get(invites::preview))
        .route("/invites/{token}/join", post(invites::join))
}

/// 404 `api_not_found`：`/api/*` 下沒有這個路徑（需求 5.9）。
async fn api_not_found() -> ApiError {
    ApiError::api_not_found()
}

/// 405 `method_not_allowed`：路徑存在，但不支援這個方法（需求 5.9）。
async fn api_method_not_allowed() -> ApiError {
    ApiError::method_not_allowed()
}

/// 等到 Ctrl-C（SIGINT）或 SIGTERM。無法註冊其中一種時只等另一種。
async fn shutdown_signal() {
    let interrupt = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                terminate.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
    tracing::info!("shutting down after the requests in progress finish");
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
