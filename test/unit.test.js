import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { redact } from '../src/git.js';
import { parseRepoUrl, normalizeRepoUrl } from '../src/gh.js';
import { pairKey, pairLabel, findConfig, saveConfig, loadConfig, ConfigError } from '../src/config.js';
import { clonePath } from '../src/state.js';
import { enumerateSource, mirrorInto } from '../src/sync.js';
import { DEFAULT_MESSAGES } from '../src/messages.js';

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gmc-test-'));
  return dir;
}

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

test('redact removes the supplied token and anything token-shaped', () => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  assert.equal(redact(`url=${token}@github.com`, token), 'url=***@github.com');
  // Even without being told the value, a token-shaped string is scrubbed.
  assert.equal(redact(`leaked ${token}`), 'leaked ***');
  assert.equal(redact('nothing sensitive', token), 'nothing sensitive');
});

test('parseRepoUrl accepts the forms a user is likely to paste', () => {
  const expected = { host: 'github.com', owner: 'acme', name: 'widgets' };
  for (const input of [
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/widgets',
    'git@github.com:acme/widgets.git',
    'acme/widgets',
  ]) {
    assert.deepEqual(parseRepoUrl(input), expected, `failed on ${input}`);
    assert.equal(normalizeRepoUrl(input), 'https://github.com/acme/widgets.git');
  }
});

test('parseRepoUrl rejects junk', () => {
  for (const input of ['', 'garbage', 'https://github.com/onlyowner', null]) {
    assert.equal(parseRepoUrl(input), null, `should reject ${input}`);
  }
});

test('pairKey is stable and distinguishes account and repo', () => {
  const a = { account: 'alice', repoUrl: 'https://github.com/alice/x.git' };
  const b = { account: 'bob', repoUrl: 'https://github.com/alice/x.git' };
  assert.equal(pairKey(a), pairKey({ ...a }));
  assert.notEqual(pairKey(a), pairKey(b));
  assert.equal(pairLabel(a), 'alice -> alice/x');
});

test('clonePath is unique per pair and filesystem-safe', () => {
  const a = clonePath({ account: 'alice', repoUrl: 'https://github.com/alice/x.git' });
  const b = clonePath({ account: 'bob', repoUrl: 'https://github.com/alice/x.git' });
  assert.notEqual(a, b);
  assert.doesNotMatch(path.basename(a), /[/\\:?*"<>|]/);
});

test('enumerateSource honours .gitignore and never leaks the config or .git', async () => {
  const root = sandbox();
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nsecret.env\n');
  writeFileSync(path.join(root, 'app.js'), 'app');
  writeFileSync(path.join(root, 'lib', 'util.js'), 'util');
  writeFileSync(path.join(root, 'secret.env'), 'TOKEN=leak');
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'dep');
  writeFileSync(path.join(root, '.git-multi-commit.json'), '{}');
  gitIn(root, 'init', '-q');

  const files = await enumerateSource(root);
  assert.deepEqual(files, ['.gitignore', 'app.js', 'lib/util.js']);

  rmSync(root, { recursive: true, force: true });
});

test('mirrorInto copies content in and propagates deletions out', async () => {
  const base = sandbox();
  const root = path.join(base, 'src');
  const clone = path.join(base, 'clone');
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'app.js'), 'app');
  writeFileSync(path.join(root, 'lib', 'util.js'), 'util');
  gitIn(root, 'init', '-q');
  mkdirSync(clone, { recursive: true });
  gitIn(clone, 'init', '-q');

  const first = await enumerateSource(root);
  const r1 = await mirrorInto({ root, cloneDir: clone, files: first });
  assert.equal(r1.copied, 2);
  assert.ok(existsSync(path.join(clone, 'lib', 'util.js')));

  gitIn(clone, 'add', '-A');
  gitIn(clone, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-qm', 'seed');

  // Removing a file upstream must remove it downstream, not leave it stranded.
  rmSync(path.join(root, 'lib', 'util.js'));
  const second = await enumerateSource(root);
  const r2 = await mirrorInto({ root, cloneDir: clone, files: second });
  assert.equal(r2.removed, 1);
  assert.ok(!existsSync(path.join(clone, 'lib', 'util.js')));
  // The now-empty directory should be pruned too.
  assert.ok(!existsSync(path.join(clone, 'lib')));
  // .git must survive the prune.
  assert.ok(existsSync(path.join(clone, '.git')));

  rmSync(base, { recursive: true, force: true });
});

test('config round-trips and findConfig walks up from a subdirectory', async () => {
  const root = sandbox();
  const nested = path.join(root, 'a', 'b');
  mkdirSync(nested, { recursive: true });

  const pairs = [{
    account: 'alice',
    repoUrl: 'https://github.com/alice/x.git',
    userName: 'Alice',
    userEmail: 'alice@example.com',
  }];
  await saveConfig(root, { pairs, messages: DEFAULT_MESSAGES, branch: 'main' });

  assert.equal(findConfig(nested), path.join(root, '.git-multi-commit.json'));

  const loaded = await loadConfig(nested);
  assert.equal(loaded.root, root);
  assert.deepEqual(loaded.config.pairs, pairs);
  assert.equal(loaded.config.messages.length, 15);

  rmSync(root, { recursive: true, force: true });
});

test('loadConfig rejects a pair that is missing an identity field', async () => {
  const root = sandbox();
  writeFileSync(
    path.join(root, '.git-multi-commit.json'),
    JSON.stringify({ version: 1, pairs: [{ account: 'alice', repoUrl: 'https://github.com/alice/x.git' }] }),
  );
  await assert.rejects(() => loadConfig(root), ConfigError);
  rmSync(root, { recursive: true, force: true });
});

test('the default message pool has 15 distinct entries', () => {
  assert.equal(DEFAULT_MESSAGES.length, 15);
  assert.equal(new Set(DEFAULT_MESSAGES).size, 15);
});
