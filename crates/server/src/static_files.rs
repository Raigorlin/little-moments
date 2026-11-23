//! `LM_STATIC_DIR` 的靜態檔（需求 2.9、32.2，任務 13.3）：`/api` 與 `/realtime/v1/websocket` 以外的路徑。
//!
//! 以 tower-http 的 `ServeDir` 讀取檔案：`Content-Type` 依副檔名決定，支援 `HEAD`、`Range` 與 `If-Modified-Since`。
//! 找不到檔案時回傳 `LM_STATIC_DIR/index.html`（200），由 LM_Web 依網址顯示畫面（需求 32.1、32.11）。每個請求都重新讀取
//! 目錄，不快取檔案。
//!
//! | 請求 | 回應 |
//! | --- | --- |
//! | `GET` 或 `HEAD` 目錄中的檔案 | 那個檔案 |
//! | `GET` 或 `HEAD` 其他路徑：不存在的檔案、沒有讀取權限的檔案、目錄（包括 `/`；不重新導向到結尾加 `/` 的網址）、無效的檔名（含 NUL、超過檔案系統的長度上限）、不合法的路徑（見下），或有以 `.` 開頭的區段 | `index.html` |
//! | 其他方法 | 405，`Allow: GET,HEAD`，沒有內容 |
//! | `index.html` 也不存在 | 404，沒有內容 |
//! | 其他讀取錯誤（例如符號連結形成迴圈） | 500，沒有內容；以 error 層級記下錯誤，不含路徑 |
//!
//! # 不回傳目錄之外的檔案（需求 32.2）
//!
//! `ServeDir` 去掉路徑開頭的每個 `/`，百分比解碼一次，再逐段檢查：解碼後不是 UTF-8，或有 `..`、根目錄或磁碟代號的
//! 區段時不讀取任何檔案（回傳 index.html），其餘區段才接在 `LM_STATIC_DIR` 之後。所以 `/../x`、`/%2e%2e/x`、
//! `/%2E%2E/x`、`/a/..%2f..%2fx`、`/%2f%2fetc/passwd` 都讀不到目錄之外的檔案，`//etc/passwd` 讀的是目錄中的
//! `etc/passwd`，`/%252e%252e/x` 讀的是目錄中的 `%2e%2e/x`（只解碼一次，`%2e%2e` 是一般的名稱）。Linux 上 `\`（`%5c`）
//! 不是路徑分隔字元，`/..\x` 是目錄中名為 `..\x` 的檔案。
//!
//! 符號連結會被跟隨：目錄中指向目錄之外的連結，會送出它指向的檔案。trunk 的建置輸出沒有符號連結，`LM_STATIC_DIR` 中
//! 也不應放入這種連結。
//!
//! # 以 `.` 開頭的區段（需求 2.9）
//!
//! 路徑百分比解碼後，有任何一段以 `.` 開頭時（例如 `/.env`、`/%2eenv`、`/.git/config`），不讀取那個檔案，回傳
//! index.html：LM_Web 不需要這種檔案（trunk 留在輸出目錄的 `.trunk-lock` 也不必送出），而 `LM_STATIC_DIR` 誤設成
//! Repository 根目錄時，也不會送出 `.env` 中的金鑰。這是 design 3.1 之外加上的限制。
//!
//! # 啟動時的檢查
//!
//! `LM_STATIC_DIR` 不存在或沒有 index.html 時，`check()` 只記下警告，lm-server 照常啟動（design 3.5 只檢查變數有沒有
//! 設定）：API 不需要 LM_Web，例如以 `trunk serve` 開發時；建置完成後，不必重新啟動 lm-server 就會回傳新的檔案。在那之前
//! 靜態檔的請求都是 404。

use std::fs;
use std::io;
use std::path::{self, Path};

use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tower_http::services::{ServeDir, ServeFile};

use crate::config::percent_decode;

/// LM_Web 的入口；找不到檔案時回傳它。
const INDEX_HTML: &str = "index.html";

/// `LM_STATIC_DIR` 的靜態檔（見模組說明）。
#[derive(Clone)]
pub struct StaticFiles {
    /// 目錄中的檔案；找不到時交給 `index`。
    dir: ServeDir<ServeFile>,
    /// `LM_STATIC_DIR/index.html`。
    index: ServeFile,
}

impl StaticFiles {
    /// `dir` 是 `LM_STATIC_DIR`；相對路徑以工作目錄為準。
    pub fn new(dir: &Path) -> Self {
        let index = ServeFile::new(dir.join(INDEX_HTML));
        Self {
            dir: ServeDir::new(dir)
                .append_index_html_on_directories(false)
                .fallback(index.clone()),
            index,
        }
    }

    /// 回應一個靜態檔的請求（見模組說明）。
    pub async fn serve(mut self, request: Request) -> Response {
        let (parts, body) = request.into_parts();
        let result = if has_hidden_segment(parts.uri.path()) {
            self.index.try_call(Request::from_parts(parts, body)).await
        } else {
            match self
                .dir
                .try_call(Request::from_parts(parts.clone(), body))
                .await
            {
                // ServeDir 只把 GET 的路徑含 NUL 當成找不到；HEAD 的 NUL 與超過長度上限的檔名也是找不到
                Err(error) if is_invalid_file_name(&error) => {
                    self.index
                        .try_call(Request::from_parts(parts, Body::empty()))
                        .await
                }
                result => result,
            }
        };
        match result {
            Ok(response) => response.into_response(),
            Err(error) => {
                tracing::error!(%error, "failed to read a file in LM_STATIC_DIR");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// 啟動時確認 `dir`（`LM_STATIC_DIR`）中有 index.html；沒有時只記下警告（見模組說明）。
pub fn check(dir: &Path) {
    let index = dir.join(INDEX_HTML);
    let shown = path::absolute(&index).unwrap_or_else(|_| index.clone());
    let problem = match fs::metadata(&index) {
        Ok(metadata) if metadata.is_file() => {
            tracing::info!(index = %shown.display(), "serving LM_Web from LM_STATIC_DIR");
            return;
        }
        Ok(_) => "not a file".to_owned(),
        Err(error) => error.to_string(),
    };
    tracing::warn!(
        index = %shown.display(),
        %problem,
        "LM_STATIC_DIR has no index.html; pages answer 404 until LM_Web is built \
         (trunk build --release --config crates/web/Trunk.toml)"
    );
}

/// 路徑百分比解碼一次（與 `ServeDir` 相同）之後，有一段以 `.` 開頭，包括 `.` 與 `..`。
fn has_hidden_segment(path: &str) -> bool {
    percent_decode(path)
        .split('/')
        .any(|segment| segment.starts_with('.'))
}

/// 檔名本身無效：含 NUL（`InvalidInput`），或超過檔案系統的長度上限（`ENAMETOOLONG`）。與檔案不存在相同。
fn is_invalid_file_name(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidFilename
    )
}
