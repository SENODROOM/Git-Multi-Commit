import { parseArgs } from 'node:util';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig, ConfigError, pairKey, pairLabel } from './config.js';
import { repoRoot } from './git.js';
import { getAllIndices, clonePath } from './state.js';
import { runSetup } from './setup.js';
import { runCommit } from './run.js';

const HELP = `${pc.bold('git-multi-commit')} — commit and push your work to several repos, each as a different GitHub account.

${pc.bold('Usage')}
  git-multi-commit            Commit and push to every configured pair
  git-multi-commit --config   Interactive setup: add account/repo/identity pairs
  git-multi-commit --status   Show configured pairs and message rotation
  git-multi-commit --dry-run  Show what would happen without committing

${pc.bold('Options')}
  -C, --cwd <dir>   Run against a different project directory
  -h, --help        Show this help
  -v, --version     Show version

${pc.bold('How it works')}
  Each pair is an independent repo with its own history. Every run mirrors your
  project's current content into each pair's own clone, commits it under that
  pair's git identity, and pushes with that account's token — so each repo looks
  like it belongs to its own developer.

  Accounts must already be logged in via ${pc.bold('gh auth login')}. Tokens are read from the
  gh keyring at run time and are never written to disk or into a remote URL.`;

/** Resolve the project directory: an explicit --cwd, else the enclosing repo root. */
async function resolveRoot(cwdOption) {
  const start = cwdOption ? path.resolve(cwdOption) : process.cwd();
  return (await repoRoot(start)) || start;
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'boolean', default: false },
        status: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        cwd: { type: 'string', short: 'C' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(pc.red(`error: ${err.message}`));
    console.error(pc.dim('Run `git-multi-commit --help` for usage.'));
    return 2;
  }

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
    console.log(pkg.version);
    return 0;
  }

  const root = await resolveRoot(values.cwd);

  let loaded;
  try {
    loaded = await loadConfig(root);
  } catch (err) {
    if (err instanceof ConfigError && !values.config) {
      console.error(pc.red(`error: ${err.message}`));
      return 1;
    }
    loaded = null;
  }

  if (values.config) {
    return runSetup({ root: loaded?.root ?? root, existing: loaded?.config });
  }

  if (!loaded) {
    console.error(pc.red('error: no configuration found for this project.'));
    console.error(pc.dim('Run `git-multi-commit --config` to set it up.'));
    return 1;
  }

  if (values.status) return showStatus(loaded);

  return runCommit({
    root: loaded.root,
    config: loaded.config,
    dryRun: values['dry-run'],
  });
}

async function showStatus({ root, config, file }) {
  const indices = await getAllIndices(root);
  console.log(pc.bold('\ngit-multi-commit'));
  console.log(pc.dim(`Config:  ${file}`));
  console.log(pc.dim(`Project: ${root}`));
  console.log(pc.dim(`Messages: ${config.messages.length} in rotation\n`));

  for (const [i, pair] of config.pairs.entries()) {
    const idx = indices[pairKey(pair)] ?? 0;
    const next = config.messages[idx % config.messages.length];
    console.log(`${pc.dim(`${i + 1}.`)} ${pc.bold(pairLabel(pair))}`);
    console.log(pc.dim(`   identity: ${pair.userName} <${pair.userEmail}>`));
    console.log(pc.dim(`   branch:   ${pair.branch || config.branch || 'main'}`));
    console.log(pc.dim(`   next msg: [${idx + 1}/${config.messages.length}] "${next}"`));
    console.log(pc.dim(`   clone:    ${clonePath(pair)}`));
    console.log();
  }
  return 0;
}
