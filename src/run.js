import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { git, gitQuiet, GitError } from './git.js';
import { validateAccount } from './gh.js';
import { pairKey, pairLabel } from './config.js';
import { clonePath, getMessageIndex, advanceMessageIndex } from './state.js';
import { enumerateSource, mirrorInto } from './sync.js';

const OK = pc.green('✓');
const FAIL = pc.red('✗');
const SKIP = pc.yellow('-');

function branchFor(pair, config) {
  return pair.branch || config.branch || 'main';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Confirm the remote exists and our token can see it.
 *
 * A repo created moments ago is briefly invisible to both the API and git,
 * answering "Repository not found" for a few seconds. That is indistinguishable
 * from a genuine permission error in the response, so retry a couple of times
 * before believing it — otherwise a run started right after `--config` fails on
 * a repo that is about to exist.
 */
async function reachable(repoUrl, opts, attempts = 3) {
  for (let i = 0; ; i += 1) {
    try {
      // `--exit-code` returns 2 for a reachable but empty repo, which is fine;
      // only a genuine access failure throws with another code.
      await git(['ls-remote', '--exit-code', '--heads', repoUrl, 'HEAD'], opts);
      return;
    } catch (err) {
      if (err.code === 2) return;
      const transient = /not found|could not read from remote/i.test(err.stderr || err.message);
      if (!transient || i >= attempts - 1) throw err;
      await sleep(2000 * (i + 1));
    }
  }
}

/**
 * Bring a pair's working clone in line with its remote.
 *
 * The remote is the source of truth for history: we always reset onto its tip
 * so a stale or half-finished cache directory can never produce a diverged
 * push. If the remote has no commits yet, we start a fresh branch instead.
 */
async function prepareClone({ pair, branch, token, dir }) {
  const opts = { cwd: dir, token, repoUrl: pair.repoUrl };
  const fresh = !existsSync(path.join(dir, '.git'));

  if (fresh) {
    // A leftover non-git directory would poison the mirror; clear it.
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await git(['init', '-q'], { cwd: dir });
    await git(['remote', 'add', 'origin', pair.repoUrl], { cwd: dir });
  } else {
    // Keep the recorded URL authoritative in case the config was edited.
    await git(['remote', 'set-url', 'origin', pair.repoUrl], { cwd: dir });
  }

  const fetched = await gitQuiet(
    ['fetch', '--depth', '1', 'origin', branch],
    opts,
  );

  if (fetched === null) {
    // No such branch upstream — an empty repo, or a branch we are creating.
    // Verify the remote is actually reachable so a bad token or URL fails
    // here with a clear message rather than at push time.
    await reachable(pair.repoUrl, opts);
    await git(['checkout', '-q', '-B', branch], { cwd: dir });
    return { startedEmpty: true };
  }

  await git(['checkout', '-q', '-B', branch, 'FETCH_HEAD'], { cwd: dir });
  return { startedEmpty: false };
}

/** Commit and push one pair. Never throws; returns a result record. */
async function processPair({ pair, config, root, files, token, dryRun }) {
  const label = pairLabel(pair);
  const branch = branchFor(pair, config);
  const dir = clonePath(pair);
  const key = pairKey(pair);

  try {
    const { startedEmpty } = await prepareClone({ pair, branch, token, dir });
    const { copied, removed } = await mirrorInto({ root, cloneDir: dir, files });

    await git(['add', '-A'], { cwd: dir });
    const { stdout: status } = await git(['status', '--porcelain'], { cwd: dir });
    if (!status) {
      return { pair, label, status: 'skipped', reason: 'no changes since last commit' };
    }

    const index = await getMessageIndex(root, key);
    const message = config.messages[index % config.messages.length];
    const changed = status.split('\n').filter(Boolean).length;

    if (dryRun) {
      return {
        pair, label, status: 'dry-run', message, branch, changed, copied, removed, startedEmpty,
      };
    }

    await git(
      [
        '-c', `user.name=${pair.userName}`,
        '-c', `user.email=${pair.userEmail}`,
        'commit', '-m', message,
      ],
      { cwd: dir },
    );

    await git(
      ['push', 'origin', `HEAD:refs/heads/${branch}`],
      { cwd: dir, token, repoUrl: pair.repoUrl },
    );

    // Only advance after the push lands, so a failed run repeats the message
    // rather than burning a slot in the rotation.
    await advanceMessageIndex(root, key, config.messages.length);

    const sha = await gitQuiet(['rev-parse', '--short', 'HEAD'], { cwd: dir });
    return { pair, label, status: 'ok', message, branch, sha, changed, startedEmpty };
  } catch (err) {
    const detail = err instanceof GitError ? err.stderr || err.message : err.message;
    return { pair, label, status: 'failed', reason: detail.split('\n').slice(0, 3).join('\n') };
  }
}

/** Validate every account up front so a bad token cannot half-finish a run. */
async function preflight(pairs) {
  const accounts = [...new Set(pairs.map((p) => p.account))];
  const results = await Promise.all(accounts.map((a) => validateAccount(a)));
  const tokens = new Map();
  const problems = [];
  for (const r of results) {
    if (r.ok) tokens.set(r.account, r.token);
    else problems.push(`  ${FAIL} ${r.account}: ${r.reason}`);
  }
  return { tokens, problems };
}

export async function runCommit({ root, config, dryRun = false }) {
  const files = await enumerateSource(root);
  if (files.length === 0) {
    console.error(pc.red('error: no files found to commit in this project.'));
    return 1;
  }

  const { tokens, problems } = await preflight(config.pairs);
  if (problems.length) {
    console.error(pc.red('error: some accounts are not usable:\n') + problems.join('\n'));
    console.error(pc.dim('\nLog in with `gh auth login`, then re-run.'));
    return 1;
  }

  console.log(
    pc.bold(`git-multi-commit`) +
      pc.dim(` — ${files.length} file${files.length === 1 ? '' : 's'}, ` +
        `${config.pairs.length} pair${config.pairs.length === 1 ? '' : 's'}` +
        (dryRun ? ', dry run' : '')),
  );
  console.log();

  const results = [];
  for (const [i, pair] of config.pairs.entries()) {
    const prefix = pc.dim(`[${i + 1}/${config.pairs.length}]`);
    process.stdout.write(`${prefix} ${pairLabel(pair)} ... `);
    const result = await processPair({
      pair, config, root, files, token: tokens.get(pair.account), dryRun,
    });
    results.push(result);

    if (result.status === 'ok') {
      console.log(`${OK} ${pc.dim(result.sha)} ${result.message}`);
    } else if (result.status === 'dry-run') {
      console.log(`${OK} ${pc.dim('would commit')} "${result.message}" ${pc.dim(`(${result.changed} changed)`)}`);
    } else if (result.status === 'skipped') {
      console.log(`${SKIP} ${pc.yellow(result.reason)}`);
    } else {
      console.log(FAIL);
      console.log(pc.red(result.reason.split('\n').map((l) => `      ${l}`).join('\n')));
    }
  }

  return summarize(results, dryRun);
}

function summarize(results, dryRun) {
  const ok = results.filter((r) => r.status === 'ok' || r.status === 'dry-run').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  console.log();
  const parts = [];
  if (ok) parts.push(pc.green(`${ok} ${dryRun ? 'ready' : 'pushed'}`));
  if (skipped) parts.push(pc.yellow(`${skipped} skipped`));
  if (failed) parts.push(pc.red(`${failed} failed`));
  console.log(parts.join(pc.dim(' · ')) || pc.dim('nothing to do'));

  if (skipped === results.length) {
    console.error(pc.red('\nerror: nothing to commit, working tree clean'));
    console.error(pc.dim('Every configured repo already matches your project content.'));
    return 1;
  }
  return failed > 0 ? 1 : 0;
}
