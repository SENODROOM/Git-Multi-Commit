# git-multi-commit

Commit and push the same work to several independent GitHub repos, each under its own account identity and its own token.

Think of it as several developers, each with their own private repo and their own git config, all receiving the same project. Every destination repo has a completely separate history, holds the full content, and every commit in it is authored by that repo's owner.

## Install

```sh
npm install -g git-multi-commit
```

Requires Node 18+, `git`, and the [GitHub CLI](https://cli.github.com).

## Setup

Log in to every account you want to use — this is the one prerequisite the tool cannot do for you:

```sh
gh auth login   # repeat for each account
```

Then, inside your project:

```sh
git-multi-commit --config
```

The wizard lists the accounts `gh` has stored, checks each token actually works, and lets you build as many pairs as you want. Per pair it asks for:

| Prompt | Notes |
| --- | --- |
| GitHub account | Chosen from your validated logins |
| Repo | URL or `owner/name`; offers to create it (private or public) if missing |
| `user.name` | The identity commits are authored under |
| `user.email` | Defaults to the account's noreply address |

Settings land in `.git-multi-commit.json` in your project root. **It holds no secrets** — tokens are read from the `gh` keyring at run time.

## Use

```sh
git-multi-commit
```

```
git-multi-commit — 4 files, 2 pairs

[1/2] seno-lab -> seno-lab/notes ... ✓ b454ee1 refactor: simplify internal helpers
[2/2] GobiBahu -> GobiBahu/data  ... ✓ c5624bf refactor: simplify internal helpers

2 pushed
```

| Command | Does |
| --- | --- |
| `git-multi-commit` | Commit and push to every configured pair |
| `git-multi-commit --config` | Add, remove, or edit pairs and messages |
| `git-multi-commit --status` | Show pairs and where each sits in the message rotation |
| `git-multi-commit --dry-run` | Report what would happen, committing nothing |
| `-C, --cwd <dir>` | Run against a different project directory |

### Commit messages

15 generic messages ship by default and are consumed one per commit. **Each pair keeps its own pointer**, so every repo's history reads as a clean `1, 2, 3…` sequence rather than a strided slice of a shared counter. The pointer only advances after a push succeeds, so a failed run repeats its message instead of burning a slot. Edit the pool during `--config`.

### What gets committed

Whatever `git ls-files -co --exclude-standard` reports — tracked plus untracked files, honouring `.gitignore`. Build output, `node_modules`, ignored secrets, and `.git-multi-commit.json` itself never leave your machine. Deleting a file locally deletes it in every destination repo on the next run.

If your content is already identical to what a repo holds, that pair is skipped. If every pair is unchanged, the run exits non-zero with `nothing to commit, working tree clean`.

A pair that fails does not abort the run — the others still finish, and the exit code reflects the failure.

## How the account switching works

The global git config on a machine with `gh` installed usually registers gh's credential helper for github.com, and it answers with whatever account is currently *active*. Left alone, a push meant for account B would silently authenticate as account A.

So for every network call this tool:

1. Reads that pair's token with `gh auth token --user <account>` — which never changes your active account, so `gh auth switch` is never needed and your global config is never touched.
2. Resets both the generic and URL-scoped credential helpers, then installs its own that answers from an environment variable.
3. Commits with `-c user.name=… -c user.email=…`, scoped to that one command.

Tokens travel only in the child process environment: never in `argv` (so they are invisible in the process list), never in a remote URL, never written to disk. Any token-shaped string in git or gh output is scrubbed before it reaches your terminal.

Working clones live in `~/.git-multi-commit/clones/`, and rotation state in `~/.git-multi-commit/state.json` — outside your project, so they can never be swept into a destination repo.

Each run resets its clone onto the remote's tip before committing, so a stale cache cannot produce a diverged push. Pushes are ordinary fast-forwards; nothing is ever force-pushed.

## Tests

```sh
npm test
```

## License

MIT
