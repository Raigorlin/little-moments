// Cross-worker lock for the E2E tests that depend on the public Registration_Policy
// (jenkins-cicd-deploy Requirement 26, design.md Testing Strategy「公開註冊政策」).
//
// All E2E tests share one App_Server and Database (playwright.config.js: fullyParallel, workers: 2).
// TC-ADMIN-004 closes public registration for a while; TC-AUTH-001 (registers through /register) and
// TC-BRAND-001 (opens /register) would fail if they ran during that window. Each of them holds this lock
// around the part that uses /register, so they never overlap.
//
// The lock is a file created with the exclusive 'wx' flag under the Playwright outputDir, which every
// worker of the run shares and Playwright empties at the start of each run (so a lock left by a crashed
// worker never outlives its run).
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const REGISTRATION_LOCK_FILE = 'registration.lock';
export const REGISTRATION_LOCK_TIMEOUT_MS = 60_000;
export const REGISTRATION_LOCK_RETRY_MS = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `fn` while holding the registration lock.
 * @param {import('@playwright/test').TestInfo} testInfo the running test (its project's outputDir holds the lock)
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withRegistrationLock(testInfo, fn) {
  const dir = testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, REGISTRATION_LOCK_FILE);
  const deadline = Date.now() + REGISTRATION_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'));
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`registration lock not acquired within ${REGISTRATION_LOCK_TIMEOUT_MS} ms`);
      await sleep(REGISTRATION_LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
