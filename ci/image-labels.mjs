// App_Image 的 OCI 標籤（Req 16.5）。
// `org.opencontainers.image.version` 一律為 `main-<7 字元短 SHA>`；Release_Tag 名稱只記錄於
// Registry 版本標籤與 Build_Record，不改變映像內容（Image_Digest）。
//
// 用法：bun ci/image-labels.mjs --commit <40 hex> [--created <ISO 8601>] [--format env|args|json]
//   env （預設）：REVISION=… / VERSION=… / CREATED=…，每行一項（對應 Dockerfile 的 ARG）
//   args        ：每行一個 `--build-arg KEY=VALUE`
//   json        ：{ "org.opencontainers.image.revision": …, … }
// 結束碼：0 成功；2 參數無效。

import { fileURLToPath } from 'node:url';

export const LABEL_KEYS = Object.freeze({
  revision: 'org.opencontainers.image.revision',
  version: 'org.opencontainers.image.version',
  created: 'org.opencontainers.image.created',
});

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** 轉為 RFC 3339 UTC（秒精度，以 `Z` 結尾）。無效輸入 throw。 */
export function rfc3339Utc(value) {
  const date = value instanceof Date ? new Date(value.getTime())
    : typeof value === 'string' || typeof value === 'number' ? new Date(value)
      : new Date(NaN);
  if (typeof value === 'string' && value.trim() === '') throw new Error('createdAt 不是有效時間');
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new Error('createdAt 不是有效時間');
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) throw new Error('createdAt 超出 RFC 3339 年份範圍');
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {{commit: string, createdAt: Date|string|number}} input
 * @returns {{[k: string]: string}} 三個 OCI 標籤
 */
export function imageLabels({ commit, createdAt } = {}) {
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) {
    throw new Error('commit 必須為 40 字元小寫十六進位 SHA');
  }
  return {
    [LABEL_KEYS.revision]: commit,
    [LABEL_KEYS.version]: `main-${commit.slice(0, 7)}`,
    [LABEL_KEYS.created]: rfc3339Utc(createdAt),
  };
}

/** Dockerfile `ARG REVISION VERSION CREATED` 對應值。 */
export function buildArgs(labels) {
  return {
    REVISION: labels[LABEL_KEYS.revision],
    VERSION: labels[LABEL_KEYS.version],
    CREATED: labels[LABEL_KEYS.created],
  };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  const format = arg(argv, '--format', 'env');
  let labels;
  try {
    if (!['env', 'args', 'json'].includes(format)) throw new Error(`不支援的 --format: ${format}`);
    labels = imageLabels({ commit: arg(argv, '--commit', ''), createdAt: arg(argv, '--created', new Date()) });
  } catch (error) {
    console.error(`OCI 標籤產生失敗: ${error.message}`);
    return 2;
  }
  if (format === 'json') {
    console.log(JSON.stringify(labels));
  } else {
    const prefix = format === 'args' ? '--build-arg ' : '';
    for (const [k, v] of Object.entries(buildArgs(labels))) console.log(`${prefix}${k}=${v}`);
  }
  return 0;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
