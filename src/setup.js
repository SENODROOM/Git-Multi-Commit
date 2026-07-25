import { select, input, confirm, checkbox } from '@inquirer/prompts';
import pc from 'picocolors';
import {
  listAccounts, validateAll, profileEmail, parseRepoUrl,
  normalizeRepoUrl, inspectRepo, createRepo, ghAvailable,
} from './gh.js';
import { saveConfig, emptyConfig, pairLabel, CONFIG_NAME } from './config.js';
import { DEFAULT_MESSAGES } from './messages.js';

const OK = pc.green('✓');
const FAIL = pc.red('✗');

/**
 * Discover which accounts are genuinely usable.
 *
 * `gh auth token` succeeds even for revoked tokens, so every candidate is
 * checked against the API. Only accounts that pass are offered — this is what
 * enforces "you must already be logged in".
 */
async function usableAccounts() {
  const logins = await listAccounts();
  if (logins.length === 0) {
    throw new Error(
      'No GitHub accounts are logged in. Run `gh auth login` for each account you want to use, then re-run this setup.',
    );
  }
  process.stdout.write(pc.dim(`Checking ${logins.length} logged-in account(s)... `));
  const results = await validateAll(logins);
  console.log();

  const good = results.filter((r) => r.ok);
  for (const r of results) {
    if (r.ok) console.log(`  ${OK} ${r.account}`);
    else console.log(`  ${FAIL} ${pc.dim(`${r.account} — ${r.reason}`)}`);
  }
  console.log();

  if (good.length === 0) {
    throw new Error('None of the logged-in accounts have a working token. Run `gh auth login` and try again.');
  }
  return good;
}

/** Ask for a repo URL, verifying push access and offering to create it. */
async function resolveRepo(account, token) {
  for (;;) {
    const answer = await input({
      message: `Repo for ${pc.bold(account)} (URL or owner/name):`,
      validate: (v) => (parseRepoUrl(v) ? true : 'Enter a GitHub URL or owner/name.'),
    });

    const parsed = parseRepoUrl(answer);
    const repoUrl = normalizeRepoUrl(answer);
    process.stdout.write(pc.dim('  checking access... '));

    let info;
    try {
      info = await inspectRepo({ owner: parsed.owner, name: parsed.name, token });
    } catch (err) {
      console.log(FAIL);
      console.log(pc.red(`  ${err.message}`));
      continue;
    }

    if (!info.exists) {
      console.log(pc.yellow('not found'));
      const create = await confirm({
        message: `Create ${parsed.owner}/${parsed.name} now?`,
        default: true,
      });
      if (!create) continue;

      const visibility = await select({
        message: 'Visibility:',
        choices: [
          { name: 'private', value: 'private' },
          { name: 'public', value: 'public' },
        ],
      });
      try {
        await createRepo({ owner: parsed.owner, name: parsed.name, visibility, token });
        console.log(`  ${OK} created ${pc.dim(`${parsed.owner}/${parsed.name} (${visibility})`)}`);
        return { repoUrl, visibility, branch: null };
      } catch (err) {
        console.log(pc.red(`  ${FAIL} could not create: ${err.message}`));
        continue;
      }
    }

    if (!info.canPush) {
      console.log(FAIL);
      console.log(pc.red(`  ${account} cannot push to ${parsed.owner}/${parsed.name}.`));
      continue;
    }

    console.log(`${OK} ${pc.dim(`${info.visibility}${info.isEmpty ? ', empty' : ''}`)}`);
    return { repoUrl, visibility: info.visibility, branch: info.defaultBranch };
  }
}

async function buildPair(accounts) {
  const account = await select({
    message: 'GitHub account:',
    choices: accounts.map((a) => ({ name: a.account, value: a.account })),
  });
  const token = accounts.find((a) => a.account === account).token;

  const { repoUrl, visibility, branch } = await resolveRepo(account, token);

  const userName = await input({
    message: 'git user.name:',
    default: account,
    validate: (v) => (v.trim() ? true : 'Required.'),
  });
  const suggested = (await profileEmail(token)) || `${account}@users.noreply.github.com`;
  const userEmail = await input({
    message: 'git user.email:',
    default: suggested,
    validate: (v) => (/^[^@\s]+@[^@\s]+$/.test(v.trim()) ? true : 'Enter a valid email.'),
  });

  return {
    account,
    repoUrl,
    visibility,
    userName: userName.trim(),
    userEmail: userEmail.trim(),
    ...(branch ? { branch } : {}),
  };
}

function printPairs(pairs) {
  if (pairs.length === 0) {
    console.log(pc.dim('  (none yet)'));
    return;
  }
  pairs.forEach((p, i) => {
    console.log(
      `  ${pc.dim(`${i + 1}.`)} ${pc.bold(pairLabel(p))}  ` +
        pc.dim(`${p.userName} <${p.userEmail}>`),
    );
  });
}

async function editMessages(current) {
  const keep = await confirm({
    message: `Use the built-in ${DEFAULT_MESSAGES.length} commit messages?`,
    default: true,
  });
  if (keep) return [...DEFAULT_MESSAGES];

  const chosen = await checkbox({
    message: 'Pick the messages to rotate through (space to toggle):',
    choices: current.map((m) => ({ name: m, value: m, checked: true })),
    validate: (v) => (v.length > 0 ? true : 'Select at least one.'),
  });
  return chosen;
}

export async function runSetup({ root, existing }) {
  if (!(await ghAvailable())) {
    console.error(pc.red('error: the GitHub CLI (`gh`) is required but was not found on PATH.'));
    console.error(pc.dim('Install it from https://cli.github.com, then run `gh auth login`.'));
    return 1;
  }

  console.log(pc.bold('\ngit-multi-commit setup'));
  console.log(pc.dim(`Project: ${root}\n`));

  let accounts;
  try {
    accounts = await usableAccounts();
  } catch (err) {
    console.error(pc.red(`error: ${err.message}`));
    return 1;
  }

  const config = existing ? { ...existing } : emptyConfig();
  config.pairs ??= [];
  config.messages ??= [...DEFAULT_MESSAGES];

  if (config.pairs.length) {
    console.log(pc.bold('Existing pairs:'));
    printPairs(config.pairs);
    console.log();
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Add more pairs', value: 'add' },
        { name: 'Remove some pairs', value: 'remove' },
        { name: 'Start over', value: 'reset' },
        { name: 'Just edit commit messages', value: 'messages' },
      ],
    });
    if (action === 'reset') config.pairs = [];
    if (action === 'remove') {
      const keep = await checkbox({
        message: 'Keep which pairs? (space to toggle)',
        choices: config.pairs.map((p, i) => ({ name: pairLabel(p), value: i, checked: true })),
      });
      config.pairs = config.pairs.filter((_, i) => keep.includes(i));
    }
    if (action !== 'messages') {
      await collectPairs(config, accounts);
    }
  } else {
    await collectPairs(config, accounts);
  }

  if (config.pairs.length === 0) {
    console.error(pc.red('\nerror: no pairs configured — nothing saved.'));
    return 1;
  }

  config.messages = await editMessages(config.messages);

  const file = await saveConfig(root, config);
  console.log(pc.bold('\nSaved ') + pc.dim(file));
  printPairs(config.pairs);
  console.log(
    pc.dim(`\n${config.messages.length} commit messages in rotation.`) +
      `\n\nRun ${pc.bold('git-multi-commit')} to commit and push to all of them.`,
  );
  console.log(pc.dim(`Tip: add ${CONFIG_NAME} to .gitignore if you don't want it tracked.`));
  return 0;
}

async function collectPairs(config, accounts) {
  for (;;) {
    console.log(pc.bold(`\nPair ${config.pairs.length + 1}`));
    try {
      config.pairs.push(await buildPair(accounts));
    } catch (err) {
      console.error(pc.red(`  skipped: ${err.message}`));
    }
    const more = await confirm({ message: 'Add another account/repo pair?', default: false });
    if (!more) break;
  }
}
