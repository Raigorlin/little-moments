// ci/keep-log.mjs：Production 執行中之 Image_Digest 的建置保留（Req 21.6）。
import { describe, expect, test } from 'bun:test';

import { KeepLogError, ensureKeepLog, keepLogTargets, main } from '../ci/keep-log.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_JOB = 'release/little-moments/v1.2.3';
const mainRecord = (over = {}) => ({
  build: { job: 'release/little-moments/main', number: 41 },
  source: { trigger: 'main_push', ref: 'main', commit: 'c'.repeat(40) },
  image: { digest: DIGEST },
  ...over,
});

describe('keepLogTargets', () => {
  test('Release_Tag 通過觀察期：保留本建置與產生該 digest 的 main 建置', () => {
    expect(keepLogTargets({ job: RELEASE_JOB, number: 7, trigger: 'release_tag', observed: true, digest: DIGEST, mainRecord: mainRecord() })).toEqual({
      targets: [
        { job: RELEASE_JOB, number: 7, role: 'release' },
        { job: 'release/little-moments/main', number: 41, role: 'main' },
      ],
    });
  });

  test('不是 Release_Tag 或觀察期未通過時不保留任何建置', () => {
    expect(keepLogTargets({ job: 'release/little-moments/main', number: 3, trigger: 'main_push', observed: true }).targets).toEqual([]);
    expect(keepLogTargets({ job: RELEASE_JOB, number: 7, trigger: 'release_tag', observed: false, digest: DIGEST, mainRecord: mainRecord() }).targets).toEqual([]);
  });

  test('main Build_Record 不相符（digest、觸發類型或 job 不同）時只保留本建置', () => {
    for (const rec of [
      mainRecord({ image: { digest: `sha256:${'b'.repeat(64)}` } }),
      mainRecord({ source: { trigger: 'branch_push' } }),
      mainRecord({ build: { job: 'ci/little-moments/main', number: 41 } }),
      mainRecord({ build: { job: 'release/little-moments/main', number: 0 } }),
      null,
    ]) {
      const r = keepLogTargets({ job: RELEASE_JOB, number: 7, trigger: 'release_tag', observed: true, digest: DIGEST, mainRecord: rec });
      expect(r.targets).toEqual([{ job: RELEASE_JOB, number: 7, role: 'release' }]);
    }
  });

  test('job 不在 release/little-moments/ 或建置編號無效時拋出 TypeError', () => {
    expect(() => keepLogTargets({ job: 'ci/little-moments/PR-1', number: 1, trigger: 'release_tag', observed: true })).toThrow(TypeError);
    expect(() => keepLogTargets({ job: RELEASE_JOB, number: 0, trigger: 'release_tag', observed: true })).toThrow(TypeError);
    expect(() => keepLogTargets({ job: 'release/little-moments/../x', number: 1, trigger: 'release_tag', observed: true })).toThrow(TypeError);
  });
});

/** 模擬 Jenkins：每個建置的 keepLog 狀態、toggleLogKeep 與請求紀錄。 */
function fakeJenkins(initial = {}, { toggleStatus = 302, readStatus = 200 } = {}) {
  const state = new Map(Object.entries(initial));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname + u.search, auth: init.headers.Authorization, redirect: init.redirect });
    const m = /^\/(.+)\/(\d+)\/(api\/json|toggleLogKeep)$/.exec(u.pathname);
    const key = m ? `${m[1]}#${m[2]}` : '';
    if (!m || !state.has(key)) return new Response('not found', { status: 404 });
    if (m[3] === 'toggleLogKeep') {
      if (init.method !== 'POST') return new Response('', { status: 405 });
      if (toggleStatus >= 200 && toggleStatus < 400) state.set(key, !state.get(key));
      return new Response('', { status: toggleStatus, headers: toggleStatus === 302 ? { Location: '/' } : {} });
    }
    if (readStatus !== 200) return new Response('', { status: readStatus });
    return Response.json({ _class: 'x', keepLog: state.get(key) });
  };
  return { state, calls, fetchImpl };
}

const RELEASE_PATH = 'job/release/job/little-moments/job/v1.2.3';
const MAIN_PATH = 'job/release/job/little-moments/job/main';
const opts = (fetchImpl) => ({ baseUrl: 'https://jenkins.lan.example/', user: 'lm-retention', token: 'api-token-value', fetchImpl });
const targets = [{ job: RELEASE_JOB, number: 7, role: 'release' }, { job: 'release/little-moments/main', number: 41, role: 'main' }];

describe('ensureKeepLog', () => {
  test('未保留者 toggle 後再確認；已保留者不 toggle（toggleLogKeep 為切換，不可重複送出）', async () => {
    const j = fakeJenkins({ [`${RELEASE_PATH}#7`]: false, [`${MAIN_PATH}#41`]: true });
    const out = await ensureKeepLog(targets, opts(j.fetchImpl));
    expect(out).toEqual([
      { job: RELEASE_JOB, number: 7, role: 'release', changed: true },
      { job: 'release/little-moments/main', number: 41, role: 'main', changed: false },
    ]);
    expect(j.state.get(`${RELEASE_PATH}#7`)).toBe(true);
    expect(j.state.get(`${MAIN_PATH}#41`)).toBe(true);
    expect(j.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /${RELEASE_PATH}/7/api/json?tree=keepLog`,
      `POST /${RELEASE_PATH}/7/toggleLogKeep`,
      `GET /${RELEASE_PATH}/7/api/json?tree=keepLog`,
      `GET /${MAIN_PATH}/41/api/json?tree=keepLog`,
    ]);
    // token 只在 Authorization 標頭；不跟隨重新導向。
    for (const c of j.calls) {
      expect(c.path).not.toContain('api-token-value');
      expect(c.auth).toBe(`Basic ${Buffer.from('lm-retention:api-token-value').toString('base64')}`);
      expect(c.redirect).toBe('manual');
    }
  });

  test('權限不足、建置不存在或設定後仍未保留時拋出 KeepLogError', async () => {
    await expect(ensureKeepLog(targets, opts(fakeJenkins({ [`${RELEASE_PATH}#7`]: false }, { toggleStatus: 403 }).fetchImpl))).rejects.toThrow(KeepLogError);
    await expect(ensureKeepLog(targets, opts(fakeJenkins({}).fetchImpl))).rejects.toThrow('找不到要保留的建置');
    await expect(ensureKeepLog(targets, opts(fakeJenkins({ [`${RELEASE_PATH}#7`]: false }, { readStatus: 401 }).fetchImpl))).rejects.toThrow('Jenkins 認證失敗或權限不足');
    // toggle 回應成功但狀態未改變（例如同時被他人切回）→ 失敗而非誤報成功。
    const stuck = fakeJenkins({ [`${RELEASE_PATH}#7`]: false });
    const fetchImpl = async (url, init) => (init.method === 'POST' ? new Response('', { status: 302 }) : stuck.fetchImpl(url, init));
    await expect(ensureKeepLog(targets, opts(fetchImpl))).rejects.toThrow('設定後 keepLog 仍為 false');
  });

  test('Jenkins URL 必須為 HTTPS；帳號或 token 缺少時拋出 TypeError', async () => {
    const j = fakeJenkins({});
    await expect(ensureKeepLog(targets, { ...opts(j.fetchImpl), baseUrl: 'http://jenkins.lan.example/' })).rejects.toThrow(TypeError);
    await expect(ensureKeepLog(targets, { ...opts(j.fetchImpl), token: '' })).rejects.toThrow(TypeError);
    expect(j.calls).toEqual([]);
  });
});

describe('CLI', () => {
  const base = ['--job', RELEASE_JOB, '--number', '7', '--trigger', 'release_tag'];
  const env = { JENKINS_URL: 'https://jenkins.lan.example/', LM_JENKINS_API_USER: 'lm-retention', LM_JENKINS_API_TOKEN_FILE: '/tmp/token' };
  const files = { '/tmp/token': 'api-token-value\n', '/tmp/main.json': JSON.stringify(mainRecord()) };
  const readFile = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };

  test('觀察期通過：設定兩個建置並結束碼 0；輸出不含 token', async () => {
    const j = fakeJenkins({ [`${RELEASE_PATH}#7`]: false, [`${MAIN_PATH}#41`]: false });
    const lines = [];
    const rc = await main([...base, '--observed', 'true', '--digest', DIGEST, '--main-record', '/tmp/main.json'], {
      env, fetchImpl: j.fetchImpl, readFile, log: (l) => lines.push(l), error: (l) => lines.push(l),
    });
    expect(rc).toBe(0);
    expect([...j.state.values()]).toEqual([true, true]);
    expect(lines.join('\n')).not.toContain('api-token-value');
  });

  test('觀察期未通過：不呼叫 Jenkins、不需 token，結束碼 0', async () => {
    const j = fakeJenkins({});
    const rc = await main([...base, '--observed', 'false'], { env: {}, fetchImpl: j.fetchImpl, readFile, log: () => {}, error: () => {} });
    expect(rc).toBe(0);
    expect(j.calls).toEqual([]);
  });

  test('Jenkins 失敗結束碼 1；參數錯誤結束碼 2', async () => {
    const quiet = { log: () => {}, error: () => {}, readFile };
    const j = fakeJenkins({ [`${RELEASE_PATH}#7`]: false }, { toggleStatus: 403 });
    expect(await main([...base, '--observed', 'true'], { ...quiet, env, fetchImpl: j.fetchImpl })).toBe(1);
    expect(await main([...base, '--observed', 'yes'], { ...quiet, env })).toBe(2);
    expect(await main(['--job', RELEASE_JOB, '--number', '07', '--trigger', 'release_tag', '--observed', 'true'], { ...quiet, env })).toBe(2);
    expect(await main(['--job', 'ci/x', '--number', '1', '--trigger', 'release_tag', '--observed', 'true'], { ...quiet, env })).toBe(2);
    expect(await main([...base, '--observed', 'true'], { ...quiet, env: { ...env, LM_JENKINS_API_TOKEN_FILE: '/missing' } })).toBe(2);
  });
});
