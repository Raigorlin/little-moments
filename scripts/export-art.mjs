// 一次性：把現行插畫程式（src/art.js、src/dish-art.js）輸出成靜態 SVG，供 Rust 前端（crates/web/src/art.rs）以
// include_str! 嵌入（需求 32.5）。輸出檔提交到 Repository，所以建置與執行都不需要 JavaScript。
// 執行：在 Repository 根目錄執行 `bun scripts/export-art.mjs`；之後改了插畫才需要重新執行。
//
// - illustration() 的每一種插畫輸出成 <kind>.svg，logo() 輸出成 logo.svg（都是 <svg> 元素本身）。
// - dishIllustration() 輸出的是外層 <span> 包著的 <svg>；檔案只存 <svg>，外層的 <span>（class 與 data 屬性）
//   由 art.rs 依相同的格式組出來。
// - 通用餐盤（custom）的 7 種變化依 dish-art.js 的 GENERIC_DISHES 順序輸出成 custom-0.svg 至 custom-6.svg：
//   以 random() 回傳 (i + 0.5) / 7 選出第 i 種變化。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { illustration, logo } from '../src/art.js';
import { dishIllustration } from '../src/dish-art.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'crates', 'web', 'assets', 'art');

const ILLUSTRATIONS = ['camp', 'travel', 'lake', 'forest', 'beach', 'sunrise', 'meal', 'market', 'night'];
const DISHES = ['hotpot', 'bbq', 'toast', 'curry', 'pasta', 'breakfast', 'salad'];
const CUSTOM_VARIATIONS = 7;

function onlySvg(html, name) {
  const start = html.indexOf('<svg');
  const end = html.lastIndexOf('</svg>');
  if (start < 0 || end < start) throw new Error(`${name}: 找不到 <svg> 元素`);
  return html.slice(start, end + '</svg>'.length);
}

function write(name, svg) {
  if (!svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')) throw new Error(`${name}: 不是獨立的 SVG`);
  writeFileSync(join(outDir, name), `${svg}\n`);
  console.log(`wrote crates/web/assets/art/${name}`);
}

mkdirSync(outDir, { recursive: true });
for (const kind of ILLUSTRATIONS) write(`${kind}.svg`, onlySvg(illustration(kind), kind));
write('logo.svg', onlySvg(logo(), 'logo'));
for (const kind of DISHES) {
  const html = dishIllustration(kind);
  if (!html.includes(`data-dish-kind="${kind}"`)) throw new Error(`${kind}: 不認得的料理插圖種類`);
  write(`${kind}.svg`, onlySvg(html, kind));
}
const seen = new Set();
for (let i = 0; i < CUSTOM_VARIATIONS; i += 1) {
  const html = dishIllustration('custom', '', () => (i + 0.5) / CUSTOM_VARIATIONS);
  const variation = /data-dish-variation="([a-z]+)"/.exec(html)?.[1];
  if (!variation || seen.has(variation)) throw new Error(`custom-${i}: 變化重複或缺少（${variation}）`);
  seen.add(variation);
  write(`custom-${i}.svg`, onlySvg(html, `custom-${i}`));
}
