// semgrep --test 範例：lm-no-new-function（不是可執行程式碼，僅供規則測試）。

function bad(body) {
  // ruleid: lm-no-new-function
  const f1 = new Function('a', 'b', body);
  // ruleid: lm-no-new-function
  const f2 = Function(`return ${body}`);
  // ruleid: lm-no-new-function
  const f3 = new globalThis.Function(body);
  return [f1, f2, f3];
}

function good(items) {
  // ok: lm-no-new-function
  const f1 = function add(a, b) { return a + b; };
  // ok: lm-no-new-function
  const f2 = items.map(x => x * 2);
  // ok: lm-no-new-function
  const isFn = typeof f1 === 'function';
  return [f1, f2, isFn];
}

export { bad, good };
