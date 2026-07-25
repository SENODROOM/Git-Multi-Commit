import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MESSAGES } from './messages.js';

export const CONFIG_NAME = '.git-multi-commit.json';
export const CONFIG_VERSION = 1;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Walk up from `startDir` looking for the config file.
 * Returns its absolute path, or null if we reach the filesystem root first.
 */
export function findConfig(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function validate(config, file) {
  if (!config || typeof config !== 'object') {
    throw new ConfigError(`${file} is not a valid JSON object.`);
  }
  if (!Array.isArray(config.pairs) || config.pairs.length === 0) {
    throw new ConfigError(
      `${file} has no configured pairs. Run \`git-multi-commit --config\` to set them up.`,
    );
  }
  config.pairs.forEach((pair, i) => {
    for (const field of ['account', 'repoUrl', 'userName', 'userEmail']) {
      if (!pair[field] || typeof pair[field] !== 'string') {
        throw new ConfigError(`${file}: pair ${i + 1} is missing "${field}".`);
      }
    }
  });
  if (!Array.isArray(config.messages) || config.messages.length === 0) {
    config.messages = [...DEFAULT_MESSAGES];
  }
  return config;
}

export async function loadConfig(startDir = process.cwd()) {
  const file = findConfig(startDir);
  if (!file) return null;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not parse ${file}: ${err.message}`);
  }
  return { file, root: path.dirname(file), config: validate(parsed, file) };
}

export async function saveConfig(root, config) {
  const file = path.join(root, CONFIG_NAME);
  const body = {
    version: CONFIG_VERSION,
    branch: config.branch || 'main',
    pairs: config.pairs,
    messages: config.messages?.length ? config.messages : [...DEFAULT_MESSAGES],
  };
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/** Stable identity for a pair, used to key its message pointer. */
export function pairKey(pair) {
  return `${pair.account}|${pair.repoUrl}`;
}

/** Human label for logs. */
export function pairLabel(pair) {
  const m = pair.repoUrl.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
  return `${pair.account} -> ${m ? m[1] : pair.repoUrl}`;
}

export function emptyConfig() {
  return { version: CONFIG_VERSION, branch: 'main', pairs: [], messages: [...DEFAULT_MESSAGES] };
}
