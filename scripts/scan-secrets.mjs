#!/usr/bin/env bun
// Secret_Scanner (Requirement 15).
//
//   bun scripts/scan-secrets.mjs [--root <dir>] [--allowlist <file>]
//
// Scans every file below the root except node_modules/ (ignored files and binaries
// included, files over 50 MB skipped with a notice) and, inside a git work tree, every
// added line in `git log --all -p`. Only Redacted_Values are printed.
//
// Exit codes: 0 clean, 1 findings outside the allowlist, 2 incomplete scan or invalid allowlist.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AllowlistError, isAllowlisted, parseAllowlist, scanText } from './secret-rules.mjs';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = join(HERE, 'secret-allowlist.json');
export const HISTORY_COMMAND = 'git clone --mirror <your-repository-url> repo.git && bun scripts/scan-secrets.mjs --root repo.git';

class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { root: process.cwd(), allowlist: DEFAULT_ALLOWLIST };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value.`);
      return value;
    };
    if (arg === '--root') options.root = next();
    else if (arg === '--allowlist') options.allowlist = next();
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  options.root = resolve(options.root);
  options.allowlist = resolve(options.allowlist);
  return options;
}

const toRel = (root, full) => relative(root, full).replace(/\\/g, '/');

// Text files are decoded as UTF-8; files with a NUL byte as latin1 so that byte
// patterns still match one character per byte.
function decode(buffer) {
  const head = buffer.subarray(0, 8192);
  return head.includes(0) ? buffer.toString('latin1') : buffer.toString('utf8');
}

function walkFiles(root, report) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      report.failures.push(`Could not read directory ${toRel(root, dir) || '.'}: ${error.code ?? error.name}`);
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        report.notices.push(`Skipped symbolic link (not followed): ${toRel(root, full)}`);
        continue;
      }
      if (!entry.isFile()) continue;
      scanFile(root, full, report);
    }
  }
}

function scanFile(root, full, report) {
  const path = toRel(root, full);
  try {
    const size = lstatSync(full).size;
    if (size > MAX_FILE_BYTES) {
      report.skipped.push(path);
      report.notices.push(`Skipped file over 50 MB: ${path} (${size} bytes)`);
      return;
    }
    const text = decode(readFileSync(full));
    report.files++;
    for (const finding of scanText(text, { path })) report.add(finding);
  } catch (error) {
    report.failures.push(`Could not read file ${path}: ${error.code ?? error.name}`);
  }
}

function git(root, args, maxBuffer = 1024 * 1024 * 1024) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer, windowsHide: true });
}

function isGitWorkTree(root) {
  const result = git(root, ['rev-parse', '--is-inside-work-tree'], 1024 * 1024);
  return { tree: !result.error && result.status === 0 && result.stdout.trim() === 'true' };
}

function isBareRepo(root) {
  const result = git(root, ['rev-parse', '--is-bare-repository'], 1024 * 1024);
  return !result.error && result.status === 0 && result.stdout.trim() === 'true';
}

// Scans the added lines of every commit reachable from all refs, which also covers
// content that later commits deleted.
function scanHistory(root, report) {
  const result = git(root, ['log', '--all', '-p', '--no-color', '--no-ext-diff', '--format=commit %H']);
  if (result.error || result.status !== 0) {
    report.failures.push(`git command failed: git log --all -p --no-color (${result.error?.code ?? `exit ${result.status}`})`);
    return;
  }
  const head = git(root, ['rev-parse', 'HEAD'], 1024 * 1024);
  if (!head.error && head.status === 0) report.head = head.stdout.trim();
  let commit = null;
  let path = null;
  const seen = new Set();
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('commit ')) {
      commit = line.slice(7).trim();
      path = null;
      if (!seen.has(commit)) {
        seen.add(commit);
        report.commits++;
      }
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      path = target === '/dev/null' ? null : target.replace(/^b\//, '');
    } else if (line.startsWith('+') && commit && path) {
      for (const finding of scanText(line.slice(1), { path })) {
        const located = { commit, path, line: null, rule: finding.rule, redacted: finding.redacted };
        Object.defineProperty(located, 'value', { value: finding.value, enumerable: false });
        report.add(located);
      }
    }
  }
}

function location(finding) {
  return finding.commit ? `${finding.commit}:${finding.path}` : `${finding.path}:${finding.line}`;
}

/** Runs a scan and returns { code, out, err } as arrays of lines. Never prints a full secret. */
export function runScan(options) {
  const out = [];
  const err = [];
  let allowlist;
  try {
    allowlist = parseAllowlist(readFileSync(options.allowlist, 'utf8'));
  } catch (error) {
    const message = error instanceof AllowlistError ? error.message : `Could not read allowlist: ${error.code ?? error.name}`;
    err.push(`Invalid allowlist ${options.allowlist}: ${message}`);
    err.push('Scan not started.');
    return { code: 2, out, err };
  }

  const report = {
    files: 0, commits: 0, allowlisted: 0, head: null,
    findings: [], skipped: [], notices: [], failures: [],
    add(finding) {
      if (isAllowlisted(finding, allowlist)) this.allowlisted++;
      else this.findings.push(finding);
    }
  };

  walkFiles(options.root, report);

  const repo = isGitWorkTree(options.root);
  const historyScanned = repo.tree || isBareRepo(options.root);
  if (historyScanned) scanHistory(options.root, report);

  for (const notice of report.notices) out.push(notice);
  if (!historyScanned) {
    out.push('Git history was not scanned: the scanned directory is not a git repository.');
    out.push(`To scan history, run in the real repository clone: ${HISTORY_COMMAND}`);
  }
  for (const finding of report.findings) out.push(`FINDING ${location(finding)} rule=${finding.rule} value=${finding.redacted}`);

  out.push(`Files scanned: ${report.files}`);
  out.push(`Files skipped (over 50 MB): ${report.skipped.length}`);
  out.push(`Commits scanned: ${historyScanned ? report.commits : 'not scanned'}${report.head ? ` (HEAD ${report.head})` : ''}`);
  out.push(`Allowlisted matches: ${report.allowlisted}`);
  out.push(`Findings: ${report.findings.length}`);

  if (report.failures.length) {
    for (const failure of report.failures) err.push(failure);
    err.push('Scan incomplete.');
    return { code: 2, out, err };
  }
  return { code: report.findings.length ? 1 : 0, out, err };
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('Usage: bun scripts/scan-secrets.mjs [--root <dir>] [--allowlist <file>]');
    process.exit(2);
  }
  const { code, out, err } = runScan(options);
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  process.exit(code);
}
