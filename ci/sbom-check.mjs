// App_Image SBOM 檢查（Req 17.4、21.2；Design「工具選型」Syft `-o cyclonedx-json`）。
//
// 純函式：
//   purlType(purl)       → 'npm'、'deb'、'apk' 等 purl 類型；無法解析時為 null
//   summarizeSbom(doc)   → { ok, reason, specVersion, components, npm, os, other, imageId }
//
// 判定（fail closed）：根節點為 CycloneDX（bomFormat === 'CycloneDX'、specVersion 為字串）、components 為非空陣列、
// 每個元件都有非空名稱，且至少一個 npm 套件（App_Image 的正式相依套件）。作業系統套件數只記錄於摘要：
// 是否列出取決於基底映像是否含套件資料庫，無法由此處判定完整性。
// 摘要只含計數與 SBOM 的格式版本，不含元件內容。
//
// CLI：
//   bun ci/sbom-check.mjs --in reports/sbom.cdx.json --out reports/sbom-summary.json [--image-id sha256:<64 hex>]
//   結束碼：0 通過；1 SBOM 無效或不含必要套件；2 參數錯誤或無法讀寫檔案。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OS_PURL_TYPES = Object.freeze(['deb', 'apk', 'rpm', 'alpm']);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `pkg:<type>/...` 的 type（小寫）；不是 purl 時回傳 null。 */
export function purlType(purl) {
  if (typeof purl !== 'string') return null;
  const m = /^pkg:([A-Za-z][A-Za-z0-9.+-]*)\//.exec(purl);
  return m ? m[1].toLowerCase() : null;
}

/**
 * @param {unknown} doc 已解析的 CycloneDX JSON
 * @param {{imageId?: string|null}} [opts]
 */
export function summarizeSbom(doc, { imageId = null } = {}) {
  const base = { ok: false, reason: null, specVersion: null, components: 0, npm: 0, os: 0, other: 0, imageId: DIGEST_RE.test(imageId ?? '') ? imageId : null };
  if (!isObj(doc) || doc.bomFormat !== 'CycloneDX') return { ...base, reason: 'SBOM 不是 CycloneDX JSON' };
  if (typeof doc.specVersion !== 'string' || doc.specVersion === '') return { ...base, reason: 'SBOM 缺少 specVersion' };
  const out = { ...base, specVersion: doc.specVersion };
  if (!Array.isArray(doc.components) || doc.components.length === 0) return { ...out, reason: 'SBOM 未列出任何元件' };
  for (const c of doc.components) {
    if (!isObj(c) || typeof c.name !== 'string' || c.name.trim() === '') return { ...out, components: 0, npm: 0, os: 0, other: 0, reason: 'SBOM 含無名稱的元件' };
    out.components++;
    const type = purlType(c.purl);
    if (type === 'npm') out.npm++;
    else if (OS_PURL_TYPES.includes(type)) out.os++;
    else out.other++;
  }
  if (out.npm === 0) return { ...out, reason: 'SBOM 未列出任何 npm 套件（應用程式相依套件）' };
  return { ...out, ok: true };
}

function parseArgs(argv) {
  const known = new Set(['--in', '--out', '--image-id']);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || i + 1 >= argv.length) return null;
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out.in && out.out ? out : null;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error('用法：bun ci/sbom-check.mjs --in <sbom.cdx.json> --out <summary.json> [--image-id sha256:<64 hex>]');
    return 2;
  }
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(args.in, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    doc = null;
  }
  const summary = summarizeSbom(doc, { imageId: args['image-id'] ?? null });
  try {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, JSON.stringify(summary, null, 2) + '\n');
  } catch {
    error('無法寫入 SBOM 摘要');
    return 2;
  }
  log(JSON.stringify(summary));
  if (!summary.ok) error(`SBOM 檢查未通過：${summary.reason}`);
  return summary.ok ? 0 : 1;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
