import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(homedir(), '.git-multi-commit');
export const CLONES_DIR = path.join(HOME_DIR, 'clones');
const STATE_FILE = path.join(HOME_DIR, 'state.json');

/**
 * State lives under the user's home rather than in the project, so it is never
 * swept into a destination repo by the content sync.
 */
export function projectKey(root) {
  return createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await mkdir(HOME_DIR, { recursive: true });
  // Write-then-rename so an interrupted run cannot leave a truncated file that
  // would reset every pair's rotation back to zero.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, STATE_FILE);
}

/** The message index a pair should use next. */
export async function getMessageIndex(root, key) {
  const state = await readState();
  return state[projectKey(root)]?.pairs?.[key]?.messageIndex ?? 0;
}

/** Advance a pair's pointer, wrapping at the end of the pool. */
export async function advanceMessageIndex(root, key, poolSize) {
  const state = await readState();
  const pk = projectKey(root);
  state[pk] ??= { path: path.resolve(root), pairs: {} };
  state[pk].pairs ??= {};
  const current = state[pk].pairs[key]?.messageIndex ?? 0;
  state[pk].pairs[key] = { messageIndex: (current + 1) % poolSize };
  await writeState(state);
  return state[pk].pairs[key].messageIndex;
}

/** Every pointer for a project, for `--status`. */
export async function getAllIndices(root) {
  const state = await readState();
  const entry = state[projectKey(root)];
  if (!entry?.pairs) return {};
  return Object.fromEntries(
    Object.entries(entry.pairs).map(([k, v]) => [k, v.messageIndex ?? 0]),
  );
}

/** Filesystem-safe cache directory for a pair's working clone. */
export function clonePath(pair) {
  const slug = `${pair.account}-${pair.repoUrl}`
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const hash = createHash('sha1').update(`${pair.account}|${pair.repoUrl}`).digest('hex').slice(0, 8);
  return path.join(CLONES_DIR, `${slug}-${hash}`);
}
