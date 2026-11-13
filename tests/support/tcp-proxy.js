// 測試用最小 TCP proxy（tests/pg-reconnect.test.js 與 tests/pg-isolation.test.js 共用；design.md Components §24.5）。
//
// 以 Bun.listen + Bun.connect 在 127.0.0.1:<隨機連接埠> 轉送至 Ephemeral_Database，用來模擬斷線，
// 不會停止或暫停使用者的資料庫服務。mode：
//   'forward'   正常雙向轉送
//   'blackhole' 不轉送任何位元組（保留於佇列，恢復後送出）、新連線照常接受，對應 `docker pause`
//   'refuse'    新連線一接受即關閉；切換時立即關閉所有既有連線，對應 DB 重啟

/**
 * @param {{targetHost:string, targetPort:number}} target
 * @returns {{port:number, readonly connections:number, blackhole():void, refuse():void, resume():void, stop():void}}
 */
export function createTcpProxy({ targetHost, targetPort }) {
  let mode = 'forward';
  const pairs = new Set();
  const side = () => ({ socket: null, out: [] });

  const flush = s => {
    if (mode !== 'forward' || !s.socket) return;
    while (s.out.length) {
      const chunk = s.out[0];
      const n = s.socket.write(chunk);
      if (n < chunk.length) { s.out[0] = chunk.subarray(Math.max(0, n)); return; } // 背壓：等待 drain
      s.out.shift();
    }
  };
  const closePair = (pair, hard = false) => {
    if (!pair || pair.closed) return;
    pair.closed = true;
    pairs.delete(pair);
    for (const s of [pair.client, pair.upstream]) {
      try { hard && s.socket?.terminate ? s.socket.terminate() : s.socket?.end(); } catch { /* 已關閉 */ }
    }
  };

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        if (mode === 'refuse') { client.end(); return; }
        const pair = { client: side(), upstream: side(), closed: false };
        pair.client.socket = client;
        client.data = pair;
        pairs.add(pair);
        Bun.connect({
          hostname: targetHost,
          port: targetPort,
          socket: {
            open(up) {
              if (pair.closed) { up.end(); return; }
              pair.upstream.socket = up;
              flush(pair.upstream);
            },
            data(_up, chunk) { pair.client.out.push(Buffer.from(chunk)); flush(pair.client); },
            drain() { flush(pair.upstream); },
            close() { closePair(pair); },
            error() { closePair(pair); },
            connectError() { closePair(pair); },
          },
        }).catch(() => closePair(pair));
      },
      data(client, chunk) {
        const pair = client.data;
        if (!pair) return;
        pair.upstream.out.push(Buffer.from(chunk));
        flush(pair.upstream);
      },
      drain(client) { if (client.data) flush(client.data.client); },
      close(client) { closePair(client.data); },
      error(client) { closePair(client.data); },
    },
  });

  return {
    port: server.port,
    get connections() { return pairs.size; },
    blackhole() { mode = 'blackhole'; },
    refuse() { mode = 'refuse'; for (const p of [...pairs]) closePair(p, true); },
    resume() { mode = 'forward'; for (const p of pairs) { flush(p.upstream); flush(p.client); } },
    stop() { mode = 'refuse'; for (const p of [...pairs]) closePair(p, true); server.stop(true); },
  };
}
