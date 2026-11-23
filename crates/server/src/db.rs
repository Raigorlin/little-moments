//! 連上 Database（design 3.5 的步驟 4，需求 2.12）：啟動時在 30 秒內每秒嘗試一次，仍失敗時只印出主機、埠與原因。

use std::fmt;
use std::time::Duration;

use sqlx::postgres::{PgConnection, PgPool, PgPoolOptions};
use sqlx::Connection;
use tokio::time::{sleep_until, timeout, Instant};

use crate::config::DatabaseUrl;

/// 啟動時等待 Database 的時間（需求 2.12）。
pub const CONNECT_WITHIN: Duration = Duration::from_secs(30);

/// 每次嘗試從開始算起的間隔：第 n 次在第 n − 1 秒開始，前一次超過 1 秒時在它結束後立即開始。
const RETRY_EVERY: Duration = Duration::from_secs(1);

/// 一次嘗試最多等這麼久：主機沒有回應時（例如封包被丟棄），TCP 連線要好幾分鐘才失敗。
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);

/// 期限前剩不到這麼久時不再開始新的嘗試，所以回報的原因不會是只剩幾毫秒、注定逾時的嘗試。
const MIN_ATTEMPT: Duration = Duration::from_millis(500);

/// 以 `database` 建立連線池。先以一條連線確認 Database 可以連上：從呼叫起 `within` 之內每秒嘗試一次（一次最多等
/// `ATTEMPT_TIMEOUT`，不超過 `within`），都失敗時回傳最後一次的原因，其中的密碼以 `***` 取代。連線被拒時共嘗試
/// 30 次（第 0 到 29 秒），約 29 秒後回報。確認之後的連線由連線池依需要建立。
///
/// 不直接以連線池嘗試：sqlx 的連線池在連線被拒時會自己重試到逾時，只回報 `PoolTimedOut`，失去原因。
pub async fn connect_within(
    database: &DatabaseUrl,
    within: Duration,
) -> Result<PgPool, ConnectError> {
    let start = Instant::now();
    let deadline = start + within;
    let mut attempts = 0;
    loop {
        attempts += 1;
        let started = Instant::now();
        let limit = ATTEMPT_TIMEOUT.min(deadline.saturating_duration_since(started));
        let reason = match timeout(limit, PgConnection::connect_with(&database.options)).await {
            Ok(Ok(connection)) => {
                // 這條連線只用來確認；關閉失敗不影響連線池之後建立的連線
                let _ = connection.close().await;
                tracing::info!(?database, "connected to database");
                return Ok(PgPoolOptions::new().connect_lazy_with(database.options.clone()));
            }
            Ok(Err(error)) => database.redact(&error.to_string()),
            Err(_) => format!("{:.1} 秒內沒有完成連線", limit.as_secs_f64()),
        };
        let retry_at = (start + RETRY_EVERY * attempts).max(Instant::now());
        if deadline.saturating_duration_since(retry_at) < MIN_ATTEMPT {
            let (host, port) = database.host_and_port();
            return Err(ConnectError {
                host,
                port,
                within,
                attempts,
                reason,
            });
        }
        if attempts == 1 {
            tracing::warn!(
                ?database,
                %reason,
                "database is not reachable yet; retrying every second for up to {} s",
                within.as_secs()
            );
        } else {
            tracing::debug!(attempt = attempts, %reason, "database is still not reachable");
        }
        sleep_until(retry_at).await;
    }
}

/// 啟動時無法連上 Database（需求 2.12）。訊息只有主機、埠、嘗試次數與最後一次的原因，不含 `DATABASE_URL` 的密碼。
pub struct ConnectError {
    host: String,
    port: u16,
    within: Duration,
    attempts: u32,
    reason: String,
}

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} 秒內無法連上 Database（主機 {}、埠 {}；嘗試 {} 次），最後一次的原因：{}\n\
             請確認本機的 Supabase 已經啟動（supabase start --network-id lm-local），以及 DATABASE_URL 的主機與埠。",
            self.within.as_secs(),
            self.host,
            self.port,
            self.attempts,
            self.reason,
        )
    }
}
