import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from './git.js';

const run = promisify(execFile);

export class GhError extends Error {
  constructor(message, { stderr = '' } = {}) {
    super(message);
    this.name = 'GhError';
    this.stderr = stderr;
  }
}

async function gh(args, { token, timeout = 60_000 } = {}) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  if (token) {
    // GH_TOKEN wins over the keyring's active account, which is how we act as
    // a specific account without ever running `gh auth switch`.
    env.GH_TOKEN = token;
    env.GITHUB_TOKEN = token;
  }
  try {
    const { stdout } = await run('gh', args, {
      env,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new GhError(
        'The GitHub CLI (`gh`) was not found on PATH. Install it from https://cli.github.com and run `gh auth login`.',
      );
    }
    const stderr = redact(err.stderr, token);
    const summary = stderr.split('\n').find((l) => l.trim()) || err.message;
    throw new GhError(summary, { stderr });
  }
}

/** True if `gh` is installed and runnable. */
export async function ghAvailable() {
  try {
    await run('gh', ['--version'], { timeout: 15_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Account logins `gh` has stored for a host.
 *
 * Presence here means only that a token exists in the keyring — it says
 * nothing about whether that token still works. Always follow up with
 * `validateAccount`.
 */
export async function listAccounts(host = 'github.com') {
  let raw;
  try {
    raw = await gh(['auth', 'status', '--hostname', host]);
  } catch (err) {
    // `gh auth status` exits non-zero when *any* stored token is invalid, but
    // still prints the full list on stderr. Fall back to that output.
    raw = err.stderr || '';
  }
  const logins = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/(?:Logged in to|Failed to log in to)\s+\S+\s+account\s+(\S+)/);
    if (m) logins.push(m[1]);
  }
  return [...new Set(logins)];
}

/** The stored token for an account, or null when none exists. */
export async function tokenFor(account, host = 'github.com') {
  try {
    const token = await gh(['auth', 'token', '--hostname', host, '--user', account]);
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Confirm an account is genuinely usable.
 *
 * `gh auth token` exits 0 for accounts whose stored token has been revoked,
 * so the only trustworthy check is an API call that echoes back the login.
 */
export async function validateAccount(account, host = 'github.com') {
  const token = await tokenFor(account, host);
  if (!token) {
    return { ok: false, account, reason: 'no stored token — run `gh auth login`' };
  }
  let login;
  try {
    login = await gh(['api', 'user', '--jq', '.login'], { token });
  } catch (err) {
    const reason = /bad credentials/i.test(err.message)
      ? 'stored token is invalid or revoked — run `gh auth login`'
      : err.message;
    return { ok: false, account, reason };
  }
  if (login.toLowerCase() !== account.toLowerCase()) {
    return { ok: false, account, reason: `token belongs to "${login}", not "${account}"` };
  }
  return { ok: true, account, login, token };
}

/** Validate every account, in parallel. */
export async function validateAll(accounts, host = 'github.com') {
  return Promise.all(accounts.map((a) => validateAccount(a, host)));
}

/** The account's public profile email, if it has one. */
export async function profileEmail(token) {
  try {
    const email = await gh(['api', 'user', '--jq', '.email // ""'], { token });
    return email || null;
  } catch {
    return null;
  }
}

/** Parse owner/name out of an https or ssh GitHub URL. */
export function parseRepoUrl(input) {
  const url = String(input ?? '').trim();
  if (!url) return null;

  const ssh = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { host: ssh[1], owner: ssh[2], name: ssh[3] };

  const shorthand = url.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (shorthand) return { host: 'github.com', owner: shorthand[1], name: shorthand[2] };

  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { host: u.host, owner: parts[0], name: parts[1] };
  } catch {
    return null;
  }
}

/** Canonical https clone URL, with no credentials embedded. */
export function normalizeRepoUrl(input) {
  const parsed = parseRepoUrl(input);
  if (!parsed) return null;
  return `https://${parsed.host}/${parsed.owner}/${parsed.name}.git`;
}

/**
 * Inspect a repo as a specific account.
 * Returns `{ exists, canPush, isEmpty, defaultBranch, visibility }`.
 */
export async function inspectRepo({ owner, name, token }) {
  let json;
  try {
    json = await gh(
      ['api', `repos/${owner}/${name}`, '--jq',
        '{push: .permissions.push, empty: .size, branch: .default_branch, private: .private}'],
      { token },
    );
  } catch (err) {
    if (/not found|404/i.test(err.message)) return { exists: false };
    throw err;
  }
  const data = JSON.parse(json);
  return {
    exists: true,
    canPush: data.push === true,
    // size 0 means no commits have ever been pushed.
    isEmpty: data.empty === 0,
    defaultBranch: data.branch || null,
    visibility: data.private ? 'private' : 'public',
  };
}

/**
 * Create a repo as the token's account.
 *
 * Uses the REST API rather than `gh repo create` because the creation response
 * echoes back the repo it actually made, which is the only confirmation we can
 * trust: a freshly created repo is briefly unreadable through `GET /repos/...`
 * and through git, so a follow-up read is not a reliable check. The API also
 * surfaces real error bodies (name collisions, permission problems) that the
 * porcelain command reduces to a generic failure.
 */
export async function createRepo({ owner, name, visibility, token }) {
  const self = await gh(['api', 'user', '--jq', '.login'], { token });
  const endpoint = self.toLowerCase() === owner.toLowerCase()
    ? 'user/repos'
    : `orgs/${owner}/repos`;

  const full = await gh(
    ['api', '-X', 'POST', endpoint,
      '-f', `name=${name}`,
      '-F', `private=${visibility === 'private'}`,
      '--jq', '.full_name'],
    { token },
  );

  if (full.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    throw new GhError(`Expected to create ${owner}/${name} but the API returned "${full}".`);
  }
  return `https://github.com/${owner}/${name}.git`;
}
