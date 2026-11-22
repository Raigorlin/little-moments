//! 連線狀態機：`RealtimeTransport`、`SocketEvent`、`Conn` 與 `PhoenixSocket`（heartbeat、加入逾時、
//! 退避後重連）。不依賴瀏覽器，時間由呼叫端傳入，可以在原生目標以不連網路的傳輸測試。
