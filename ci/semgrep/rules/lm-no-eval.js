// semgrep --test 範例：lm-no-eval（不是可執行程式碼，僅供規則測試）。

function bad(input) {
  // ruleid: lm-no-eval
  eval(input);
  // ruleid: lm-no-eval
  eval('1 + 1');
  // ruleid: lm-no-eval
  globalThis.eval(input);
  // ruleid: lm-no-eval
  window.eval(`return ${input}`);
}

function good(text, re) {
  // ok: lm-no-eval
  const data = JSON.parse(text);
  // ok: lm-no-eval
  const match = re.exec(text);
  // ok: lm-no-eval
  const evaluate = { score: 1 };
  return [data, match, evaluate];
}

export { bad, good };
