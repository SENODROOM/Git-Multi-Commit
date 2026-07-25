import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Credential helper that answers with whatever is in $GMC_TOKEN.
 *
 * The token travels in the child process environment, never in argv, so it is
 * not visible to `ps` / Task Manager and never lands in a remote URL, the
 * reflog, or on disk.
 */
const TOKEN_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GMC_TOKEN"; }; f';

/**
 * Config flags that must precede every authenticated network call.
 *
 * A machine with `gh` set up has a credential helper registered for
 * github.com that answers with the *active* account's token. If we merely
 * appended our own helper, git would keep consulting theirs and a push meant
 * for account B could silently authenticate as account A. An empty helper
 * value resets the chain, so we clear both the generic and the URL-scoped
 * entry before installing ours.
 */
function authConfig(host) {
  return [
    '-c', 'credential.helper=',
    '-c', `credential.https://${host}.helper=`,
    '-c', `credential.helper=${TOKEN_HELPER}`,
  ];
}

function hostOf(repoUrl) {
  try {
    return new URL(repoUrl).host;
  } catch {
    return 'github.com';
  }
}

export class GitError extends Error {
  constructor(message, { stderr = '', stdout = '', code } = {}) {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
    this.stdout = stdout;
    this.code = code;
  }
}

/**
 * Scrub anything token-shaped out of text bound for a terminal or log.
 * git and gh both echo URLs and headers on failure; this is the last line of
 * defence against a credential reaching the user's scrollback.
 */
export function redact(text, token) {
  let out = String(text ?? '');
  if (token) out = out.split(token).join('***');
  return out.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***');
}

/**
 * Run git. `token` is optional; when present it is injected via env and the
 * credential-helper override is applied.
 */
export async function git(args, { cwd, token, repoUrl, timeout = 120_000 } = {}) {
  const prefix = token ? authConfig(hostOf(repoUrl ?? '')) : [];
  const env = {
    ...process.env,
    // Fail fast instead of blocking on an interactive credential prompt.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
  if (token) env.GMC_TOKEN = token;

  try {
    const { stdout, stderr } = await run('git', [...prefix, ...args], {
      cwd,
      env,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const stderr = redact(err.stderr, token);
    const stdout = redact(err.stdout, token);
    const summary = stderr.split('\n').find((l) => l.trim()) || err.message;
    throw new GitError(summary, { stderr, stdout, code: err.code });
  }
}

/** Run git and return stdout, or `null` if it fails. For probes. */
export async function gitQuiet(args, opts) {
  try {
    const { stdout } = await git(args, opts);
    return stdout;
  } catch {
    return null;
  }
}

export async function isGitRepo(cwd) {
  return (await gitQuiet(['rev-parse', '--is-inside-work-tree'], { cwd })) === 'true';
}

/** Absolute path of the repo root containing `cwd`, or null. */
export async function repoRoot(cwd) {
  return await gitQuiet(['rev-parse', '--show-toplevel'], { cwd });
}
