//! 以瀏覽器的 `WebSocket` 實作 `RealtimeTransport`：把 `onopen`、`onmessage`、`onclose` 轉成
//! `SocketEvent` 放進佇列；計時用 gloo-timers。只在 feature `web` 而且 `target_arch = "wasm32"` 時編譯。
