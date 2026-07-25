import { readdir, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { git, isGitRepo } from './git.js';
import { CONFIG_NAME } from './config.js';

/** Never mirrored, regardless of what the source enumeration returns. */
const ALWAYS_EXCLUDE = new Set([CONFIG_NAME, '.git']);

/** Skipped by the non-git fallback walk. */
const FALLBACK_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'out',
  '.cache', '.venv', 'venv', '__pycache__', '.DS_Store',
]);

function shouldExclude(relPath) {
  const first = relPath.split('/')[0];
  return ALWAYS_EXCLUDE.has(first) || ALWAYS_EXCLUDE.has(relPath);
}

/**
 * Every file that should be mirrored, as forward-slashed paths relative to
 * `root`.
 *
 * In a git repo we ask git itself: `ls-files -co --exclude-standard` yields
 * tracked plus untracked files while honouring .gitignore, so build output and
 * node_modules drop out for free and stay consistent with what the user sees
 * in `git status`.
 */
export async function enumerateSource(root) {
  if (await isGitRepo(root)) {
    const { stdout } = await git(
      ['ls-files', '-co', '--exclude-standard'],
      { cwd: root },
    );
    const files = stdout ? stdout.split('\n').map((f) => f.trim()).filter(Boolean) : [];
    return files.filter((f) => !shouldExclude(f)).sort();
  }
  const found = [];
  await walk(root, '', found);
  return found.filter((f) => !shouldExclude(f)).sort();
}

async function walk(root, rel, out) {
  const dir = rel ? path.join(root, rel) : root;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (FALLBACK_SKIP_DIRS.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
}

/** Files currently tracked in the clone, so we know what to prune. */
async function trackedFiles(cloneDir) {
  const { stdout } = await git(['ls-files'], { cwd: cloneDir });
  return stdout ? stdout.split('\n').map((f) => f.trim()).filter(Boolean) : [];
}

/**
 * Mirror the source content into a clone: copy every source file in, then
 * delete tracked files that no longer exist in the source, so a deletion in
 * the project propagates rather than lingering forever.
 */
export async function mirrorInto({ root, cloneDir, files }) {
  const desired = new Set(files);
  let copied = 0;

  for (const rel of files) {
    const src = path.join(root, rel);
    const dest = path.join(cloneDir, rel);
    try {
      // A path listed by git can vanish between enumeration and copy.
      if (!(await stat(src)).isFile()) continue;
    } catch {
      continue;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
    copied += 1;
  }

  let removed = 0;
  for (const rel of await trackedFiles(cloneDir)) {
    if (desired.has(rel) || shouldExclude(rel)) continue;
    await rm(path.join(cloneDir, rel), { force: true });
    removed += 1;
  }

  await pruneEmptyDirs(cloneDir, cloneDir);
  return { copied, removed };
}

/** Remove directories left empty after pruning, never touching .git. */
async function pruneEmptyDirs(dir, rootDir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let remaining = entries.length;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (dir === rootDir && entry.name === '.git') continue;
    const child = path.join(dir, entry.name);
    if (await pruneEmptyDirs(child, rootDir)) remaining -= 1;
  }
  if (remaining === 0 && dir !== rootDir) {
    await rm(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}
