// Groovy 掃描器（tests/ci-jenkinsfile-size.test.js 與 tests/ci-jenkinsfile-cps.test.js 共用；Components 第 22、23.5 節）。

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);
const TYPE = String.raw`(?:def|void|boolean|int|long|double|float|short|byte|char|[A-Z][\w.]*(?:<[^>{}]*>)?(?:\[\])?)`;
const FUNCTION_RE = new RegExp(String.raw`^(?:(?:public|private|protected|static|final)\s+)*${TYPE}\s+([A-Za-z_]\w*)\s*\(`);

/**
 * 保留換行的 Groovy 掃描器。略過 `//`、`/* *\/` 註解與 `'…'`、`"…"`、`'''…'''`、`"""…"""` 字串的內容（處理 `\` 跳脫），
 * 以 `(`、`[`、`{` 配對找出深度 0 的 `{ … }` 區塊：`pipeline {` 與頂層函式宣告。
 * 回傳 { blocks: [{ name, kind, start, end, lines }], masked }；masked 與原文等長，註解與字串內容換成空白（保留換行）。
 * 未結束的字串、註解或括號、括號不配對、深度 0 區塊的結束 `}` 不是單獨位於一行的第 0 欄、無法辨識的頂層區塊，皆拋出例外。
 */
export function scanGroovy(text) {
  const masked = text.split('');
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (masked[k] !== '\n') masked[k] = ' '; };
  const stack = [];
  const blocks = [];
  let stmtStart = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (text.startsWith('//', i)) {
      const n = text.indexOf('\n', i);
      const end = n < 0 ? text.length : n;
      blank(i, end);
      i = end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const n = text.indexOf('*/', i + 2);
      if (n < 0) throw new Error(`第 ${lineOf(i)} 行的區塊註解未結束`);
      blank(i, n + 2);
      i = n + 2;
      continue;
    }
    const quote = text.startsWith("'''", i) ? "'''" : text.startsWith('"""', i) ? '"""' : (ch === "'" || ch === '"') ? ch : null;
    if (quote) {
      if (stack.length === 0 && stmtStart < 0) stmtStart = i;
      let j = i + quote.length;
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === '\\') j++;
        else if (quote.length === 1 && text[j] === '\n') throw new Error(`第 ${lineOf(i)} 行的字串未結束`);
        j++;
      }
      if (j >= text.length) throw new Error(`第 ${lineOf(i)} 行的字串未結束`);
      blank(i + quote.length, j);
      i = j + quote.length;
      continue;
    }
    if (ch === '\n') {
      if (stack.length === 0) stmtStart = -1;
      i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (stack.length === 0 && stmtStart < 0) stmtStart = i;
    if (ch in OPEN) {
      if (ch === '{' && stack.length === 0) {
        const head = text.slice(stmtStart, i).trim();
        const fn = FUNCTION_RE.exec(head);
        const kind = head === 'pipeline' ? 'pipeline' : fn ? 'function' : null;
        if (!kind) throw new Error(`第 ${lineOf(i)} 行：無法辨識的頂層區塊 ${JSON.stringify(head.slice(0, 60))}`);
        stack.push({ ch, block: { name: kind === 'pipeline' ? 'pipeline' : fn[1], kind, start: lineOf(stmtStart) } });
      } else {
        stack.push({ ch });
      }
      i++;
      continue;
    }
    if (CLOSE.has(ch)) {
      const top = stack.pop();
      if (!top || OPEN[top.ch] !== ch) throw new Error(`第 ${lineOf(i)} 行的 ${ch} 沒有對應的開括號`);
      if (top.block) {
        const lineStart = text.lastIndexOf('\n', i - 1) + 1;
        const lineEnd = text.indexOf('\n', i);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (i !== lineStart || line.trimEnd() !== '}') {
          throw new Error(`第 ${lineOf(i)} 行：${top.block.name} 的結束 } 必須單獨位於一行的第 0 欄`);
        }
        const end = lineOf(i);
        blocks.push({ ...top.block, end, lines: end - top.block.start + 1 });
        stmtStart = -1;
      }
      i++;
      continue;
    }
    i++;
  }
  if (stack.length) throw new Error(`括號未結束（${stack.map((s) => s.ch).join('')}）`);
  return { blocks, masked: masked.join('') };
}
