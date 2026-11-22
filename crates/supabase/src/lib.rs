//! lm-supabase：精簡的 Supabase 用戶端。
//!
//! - `realtime::protocol` 與 `realtime::socket`：Realtime 協定 1.0.0 的訊框與連線狀態機，只經
//!   `RealtimeTransport` 收送訊框，不依賴瀏覽器。
//! - `realtime::web`（feature `web`，只在 wasm32 編譯）：以瀏覽器的 WebSocket 實作 `RealtimeTransport`。
//! - `gotrue` 與 `jwt`（feature `server`）：Auth_Service 的 REST 呼叫（`AuthBackend`）與 access token 驗證。
//!
//! 各模組的內容依 design「Components and Interfaces」2，由之後的任務填入。

pub mod realtime {
    //! Supabase Realtime：協定、連線狀態機與瀏覽器傳輸。

    pub mod protocol;
    pub mod socket;
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub mod web;
}

#[cfg(feature = "server")]
pub mod gotrue;
#[cfg(feature = "server")]
pub mod jwt;
