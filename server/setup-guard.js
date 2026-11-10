// 首次管理員設定的 Setup_Token 保護（Requirement 9.2、9.3、9.5、9.7）。
// 只處理 token 的啟用、產生、比較與失效；授權組合與 HTTP 流程由 accounts.js 負責。
import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const MIN_SETUP_TOKEN_LENGTH = 32;
const GENERATED_TOKEN_BYTES = 32; // 256 位元，高於 Req 9.2 的 128 位元下限

// 本地 loopback 判斷（127.0.0.0/8、::1、::ffff:127.0.0.0/104）。
// 與 server/config.js 的 isLoopbackAddress 語意相同；保留在此避免模組間耦合。
export function isLoopbackBind(address) {
  if (typeof address !== 'string') return false;
  const ip = address.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const kind = isIP(ip);
  if (kind === 4) return ip.split('.')[0] === '127';
  if (kind !== 6 || ip.includes('%')) return false;
  // WHATWG URL 會把 IPv6 正規化為壓縮形式，IPv4-mapped 位址變成 ::ffff:XXXX:XXXX
  let canonical;
  try { canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return false; }
  if (canonical === '::1') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(canonical);
  return !!mapped && (parseInt(mapped[1], 16) >> 8) === 127;
}

const digest = value => createHash('sha256').update(value, 'utf8').digest();

/**
 * @param {{ bindAddress?: string, setupToken?: string, randomBytes?: (n:number)=>Buffer, log?: (msg:string)=>void }} options
 * @returns {{ required: boolean, verify(candidate: unknown): boolean, consume(): void }}
 */
export function createSetupGuard({ bindAddress = '127.0.0.1', setupToken, randomBytes = cryptoRandomBytes, log = msg => console.log(msg) } = {}) {
  const required = !isLoopbackBind(bindAddress);
  let tokenDigest = null;
  let consumed = false;

  if (required) {
    const provided = typeof setupToken === 'string' && setupToken !== '';
    if (provided) {
      if (setupToken.length < MIN_SETUP_TOKEN_LENGTH) {
        // 不得輸出 token 值（Req 9.3）
        const err = new Error(`CAMPING_SETUP_TOKEN 長度不足：至少需要 ${MIN_SETUP_TOKEN_LENGTH} 個字元`);
        err.code = 'SETUP_TOKEN_TOO_SHORT';
        throw err;
      }
      tokenDigest = digest(setupToken);
    } else {
      const generated = Buffer.from(randomBytes(GENERATED_TOKEN_BYTES)).toString('base64url');
      tokenDigest = digest(generated);
      // 僅輸出至容器本機 stdout 一次；不寫入 DB、Build_Record 或 HTTP 回應（Req 9.2）
      log(`首次管理員設定碼（Setup_Token）：${generated}`);
    }
  }

  return {
    required,
    verify(candidate) {
      if (!required || consumed || !tokenDigest || typeof candidate !== 'string' || candidate === '') return false;
      // 先雜湊成固定長度，再以固定時間比較，避免長度與首個相異字元位置洩漏（Req 9.7）
      return timingSafeEqual(digest(candidate), tokenDigest);
    },
    consume() {
      consumed = true; // Req 9.5：成功建立管理員後失效
    },
  };
}
