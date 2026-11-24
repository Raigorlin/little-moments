//! `LM_STATIC_DIR` 的靜態檔（需求 2.9、32.2，任務 13.3）：`/api` 與 `/realtime/v1/websocket` 以外的路徑。
//!
//! 以 tower-http 的 `ServeDir` 讀取檔案：`Content-Type` 依副檔名決定，支援 `HEAD`、`Range` 與 `If-Modified-Since`。
//! 找不到檔案時回傳 `LM_STATIC_DIR/index.html`（200），由 LM_Web 依網址顯示畫面（需求 32.1、32.11）。每個請求都重新讀取
//! 目錄，不快取檔案。
//!
//! | 請求 | 回應 |
//! | --- | --- |
//! | `GET` 或 `HEAD` 目錄中的檔案 | 那個檔案（快取與壓縮見下） |
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
//! # 快取與壓縮
//!
//! 每個回應都帶 `Cache-Control`：檔名含內容雜湊的檔案（trunk 輸出的 `lm-web-<16 個十六進位字元>.js`、
//! `…_bg.wasm`、`styles-<…>.css`，以及 `/assets/` 之下的 `<名稱>-<8 個十六進位字元>.woff2` 字型）是
//! `public, max-age=31536000, immutable`，內容改變時網址也會改變；其他檔案與 index.html 是 `no-cache`，每次使用前都
//! 向 lm-server 確認。回應是 `text/html` 時一律 `no-cache`：舊的雜湊網址找不到檔案而回傳 index.html 時，不會被快取
//! 一年。與 Bun 的 `server/http.js` `assetCacheControl` 相同。
//!
//! `router()` 依 `Accept-Encoding` 以 br 或 gzip 壓縮回應（4.9 MB 的 wasm 壓縮後不到原本的一半）。woff2 字型本身已經
//! 壓縮，不再壓縮；tower-http 也不壓縮 `Range` 請求的部分內容（有 `Content-Range` 的回應）與很小的回應。
//!
//! 每個回應另帶 `X-Frame-Options: DENY` 與 `Cross-Origin-Opener-Policy: same-origin`（與 Bun 的 `SECURITY_HEADERS`
//! 相同）：LM_Web 不在其他網站的 frame 中顯示，也不與其他網站開啟的視窗共用瀏覽環境。
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
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::config::percent_decode;

/// LM_Web 的入口；找不到檔案時回傳它。
const INDEX_HTML: &str = "index.html";
/// 檔名含內容雜湊的檔案：內容改變時網址也改變，所以可以快取一年（見模組說明的「快取與壓縮」）。
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// 其他檔案與 index.html：每次使用前都向 lm-server 確認。
const CACHE_NO_CACHE: &str = "no-cache";

/// 靜態檔的路由器：每個路徑都交給 [`StaticFiles`]，回應依 `Accept-Encoding` 以 br 或 gzip 壓縮；字型不壓縮
/// （見模組說明的「快取與壓縮」）。
pub fn router(dir: &Path) -> Router {
    let static_files = StaticFiles::new(dir);
    Router::new()
        .fallback(move |request: Request| static_files.clone().serve(request))
        .layer(
            CompressionLayer::new()
                .br(true)
                .gzip(true)
                .compress_when(DefaultPredicate::new().and(NotForContentType::const_new("font/"))),
        )
}

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
        let path = parts.uri.path().to_owned();
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
            Ok(response) => {
                let mut response = response.into_response();
                let html = response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.starts_with("text/html"));
                let cache = if !html && is_hashed_asset(&path) {
                    CACHE_IMMUTABLE
                } else {
                    CACHE_NO_CACHE
                };
                let headers = response.headers_mut();
                headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
                headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
                headers.insert(
                    HeaderName::from_static("cross-origin-opener-policy"),
                    HeaderValue::from_static("same-origin"),
                );
                response
            }
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

/// 檔名含內容雜湊：trunk 的輸出（`-` 加 16 個十六進位字元，wasm 另有 `_bg`，再接副檔名，例如
/// `lm-web-0123456789abcdef_bg.wasm`），或 `/assets/` 之下以 `-` 加 8 個十六進位字元命名的 woff2 字型（例如
/// `jf-openhuninn-ui-204a1ba7.woff2`；與 Bun 的 `HASHED_FONT` 相同）。
fn is_hashed_asset(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or_default();
    let ends_with_hash = |stem: &str, len: usize| {
        stem.len() > len
            && stem.as_bytes()[stem.len() - len - 1] == b'-'
            && stem.as_bytes()[stem.len() - len..]
                .iter()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    };
    if path.starts_with("/assets/") {
        if let Some(stem) = name.strip_suffix(".woff2") {
            if ends_with_hash(stem, 8) {
                return true;
            }
        }
    }
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    if extension.is_empty() || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return false;
    }
    let stem = stem.strip_suffix("_bg").unwrap_or(stem);
    ends_with_hash(stem, 16)
}

/// 檔名本身無效：含 NUL（`InvalidInput`），或超過檔案系統的長度上限（`ENAMETOOLONG`）。與檔案不存在相同。
fn is_invalid_file_name(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidFilename
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::body::to_bytes;
    use axum::http::Method;
    use tower::ServiceExt as _;

    use super::*;

    #[test]
    fn hashed_assets() {
        for path in [
            "/lm-web-a2ba10321df23617.js",
            "/lm-web-c7842af86edb34d7_bg.wasm",
            "/styles-9f93259d316d38da.css",
            "/assets/fonts/jf-openhuninn-ui-204a1ba7.woff2",
            "/assets/storybook/fonts/PatrickHand-32c1a2bb.woff2",
        ] {
            assert!(is_hashed_asset(path), "{path}");
        }
        for path in [
            "/",
            "/index.html",
            "/robots.txt",
            "/favicon.ico",
            "/lm-web.js",
            "/lm-web-a2ba10321df2361.js",
            "/lm-web-A2BA10321DF23617.js",
            "/lm-web-a2ba10321df23617",
            "/jf-openhuninn-ui-204a1ba7.woff2",
            "/assets/fonts/OFL.txt",
            "/test/trips/0d391db4-dc30-41d5-b692-4009ce7dcba0",
            "/日子-拾光.js",
        ] {
            assert!(!is_hashed_asset(path), "{path}");
        }
    }

    /// 測試用的 LM_STATIC_DIR；結束時刪除。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lm-server-static-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            fs::create_dir_all(dir.join("assets/fonts")).unwrap();
            fs::write(dir.join(INDEX_HTML), "<!doctype html><title>LM</title>").unwrap();
            fs::write(
                dir.join("lm-web-0123456789abcdef_bg.wasm"),
                "wasm module ".repeat(400),
            )
            .unwrap();
            fs::write(
                dir.join("assets/fonts/x-0123abcd.woff2"),
                "wOF2 ".repeat(400),
            )
            .unwrap();
            fs::write(dir.join("robots.txt"), "User-agent: *\nDisallow: /api/\n").unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    async fn get(dir: &TempDir, method: Method, path: &str, encoding: Option<&str>) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(encoding) = encoding {
            request = request.header(header::ACCEPT_ENCODING, encoding);
        }
        router(&dir.0)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    fn header_of<'a>(response: &'a Response, name: &str) -> Option<&'a str> {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap())
    }

    fn assert_security_headers(response: &Response) {
        assert_eq!(header_of(response, "x-frame-options"), Some("DENY"));
        assert_eq!(
            header_of(response, "cross-origin-opener-policy"),
            Some("same-origin")
        );
    }

    #[tokio::test]
    async fn hashed_wasm_is_compressed_and_immutable() {
        let dir = TempDir::new();
        for (accept, encoding) in [("gzip", "gzip"), ("br", "br"), ("br, gzip", "br")] {
            let response = get(
                &dir,
                Method::GET,
                "/lm-web-0123456789abcdef_bg.wasm",
                Some(accept),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(header_of(&response, "content-encoding"), Some(encoding));
            assert_eq!(header_of(&response, "cache-control"), Some(CACHE_IMMUTABLE));
            assert_security_headers(&response);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(body.len() < 4800, "{accept}: {} bytes", body.len());
        }
        let response = get(&dir, Method::GET, "/lm-web-0123456789abcdef_bg.wasm", None).await;
        assert_eq!(header_of(&response, "content-encoding"), None);
        assert_eq!(header_of(&response, "cache-control"), Some(CACHE_IMMUTABLE));
    }

    #[tokio::test]
    async fn fonts_are_not_compressed() {
        let dir = TempDir::new();
        let response = get(
            &dir,
            Method::GET,
            "/assets/fonts/x-0123abcd.woff2",
            Some("br, gzip"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header_of(&response, "content-encoding"), None);
        assert_eq!(header_of(&response, "cache-control"), Some(CACHE_IMMUTABLE));
        assert_security_headers(&response);
    }

    #[tokio::test]
    async fn index_html_and_other_files_are_not_cached() {
        let dir = TempDir::new();
        for path in [
            "/",
            "/lm-web-ffffffffffffffff.js",
            "/test/trips/x?tab=schedule",
        ] {
            let response = get(&dir, Method::GET, path, Some("gzip")).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(header_of(&response, "content-type")
                .unwrap()
                .starts_with("text/html"));
            assert_eq!(header_of(&response, "cache-control"), Some(CACHE_NO_CACHE));
            assert_security_headers(&response);
        }
        let response = get(&dir, Method::GET, "/robots.txt", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header_of(&response, "cache-control"), Some(CACHE_NO_CACHE));
        assert_security_headers(&response);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"User-agent: *\nDisallow: /api/\n");
    }

    #[tokio::test]
    async fn other_methods_stay_405() {
        let dir = TempDir::new();
        let response = get(&dir, Method::POST, "/", None).await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(header_of(&response, "allow").is_some());
    }
}
