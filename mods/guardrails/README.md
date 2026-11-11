# guardrails

Turns the rules you write in `CLAUDE.md` into tool calls that cannot run. When Claude tries to push
to `main`, read a `.env` file, commit outside a worktree or edit a repo you marked read-only, it
gets a denial that starts with `guardrails:` and the call never happens.

I wrote it because an instruction file is advice. Claude follows it most of the time, and then a
long session, a subagent or a confident fix skips a line. A denied tool call doesn't depend on
anyone remembering anything. The rule lives in the hook that runs before every call, and the model
can't talk its way past it.

## What it blocks with no options set

Install it and change nothing, and it still enforces four things.

- **Protected branches.** `main`, `master` and `develop` by default. No direct push to them,
  including force pushes, deletes and `--all`. No `gh pr merge` into them. No commit, merge, rebase,
  cherry-pick, revert, non-fast-forward pull or reset while one is checked out. No local delete or
  rename of one. A fast-forward-only pull or merge passes, so syncing a checkout still works.
- **`.env` files.** Claude can't read, write or even name `.env`, `.env.*` or `*.env` files, in any
  tool or any spelling. `cat .env`, `source .env`, `docker run --env-file=.env`, `git show HEAD:.env`
  and a Python one-liner that opens `.env` are all denied. `.env.example`, `.env.sample` and
  `.env.template` pass, because templates hold no secrets. A directory named `.env`, such as a
  virtualenv, passes too.
- **Itself.** Changing this plugin's folder, anything under `~/.claude/plugins`, or the
  `enabledPlugins` block of `~/.claude/settings.json` needs `/consent self-edit`. So does
  `claude plugin disable`, `uninstall` or `remove` when the command names `guardrails`. Other edits
  to `settings.json` pass.
- **Unknown working directory.** When a command's directory can't be worked out from the command
  line, as in `cd "$DIR" && rm -rf build`, a write is denied and a plain read passes. Split the
  command, or use absolute paths and `git -C <dir>`.

The repo rules below need `workspaceRoot` and stay off until you set it.

## Options

Set them on the screen the install shows, or later in `/config`. A change reloads the plugin.
Every list is comma-separated. Folder names are compared without regard to case.

| Option | Default | What it does |
|---|---|---|
| `workspaceRoot` | empty | The folder that holds your repos. A leading `~` is your home folder. Empty turns off read-only repos, consent-gated repos, branch locks, the primary-checkout commit rule and the recursive-search limit. |
| `worktreesDir` | `worktrees` | The folder directly under `workspaceRoot` that holds your git worktrees. Commits there are allowed. |
| `protectedBranches` | `main,master,develop` | Branches covered by the push, PR merge, history write and delete rules above. One list drives all four. Empty turns all four off. |
| `primaryCommits` | `block` | `block` means a commit in a repo under `workspaceRoot` but outside `worktreesDir` needs `/consent primary-commit`. `allow` turns that off. |
| `readOnlyRepos` | empty | Folders directly under `workspaceRoot` that are never written. No consent unlocks them. Reads, `git log`, `go test` and the like still work. |
| `consentRepos` | empty | Folders directly under `workspaceRoot` that need `/consent <folder>` before Claude reads anything in them, and `/consent <folder>-write` before it commits or pushes there. |
| `branchLocks` | empty | `folder=branch` pairs. That repo can't create or switch to any other branch. |
| `blockedCommands` | empty | Programs that never run, such as `kubectl`. The check sees through `sudo`, `env`, `nohup`, `timeout`, `xargs`, `sh -c`, `eval`, `$(...)` and a full path to the binary. |
| `envFiles` | `block` | `allow` turns the `.env` rule off. |
| `protectedPaths` | empty | Extra files or folders, `~` allowed, that need `/consent self-edit` to change. Put your dotfiles repo here if `~/.claude` links into it. |
| `ownerName` | `the user` | The name deny messages tell Claude to ask, as in "Ask Sam to run /consent ops". |

### Example

Say your repos live in `~/code`. `vendor-sdk` is a vendored copy you never want edited, and `ops`
holds deploy config Claude shouldn't even read unless you say so. Your worktrees go in
`~/code/worktrees`.

```
workspaceRoot     ~/code
readOnlyRepos     vendor-sdk
consentRepos      ops
branchLocks       ops=deploy
blockedCommands   kubectl
ownerName         Sam
```

With that in place:

- An edit, `sed -i` or `git commit` in `~/code/vendor-sdk` is denied every time. `cat`, `rg` and
  `git log` there pass.
- Reading `~/code/ops/values.yaml`, by any tool, is denied until Sam types `/consent ops`.
  Committing or pushing there also needs `/consent ops-write`, and `ops` can't leave the `deploy`
  branch.
- A commit in `~/code/api` is denied with "Create a worktree under /home/sam/code/worktrees
  first". A commit in `~/code/worktrees/api--login` passes, unless that worktree is on `main`.
- `rg foo` from `~/code`, or a `Grep` with no path there, is denied while `ops` is locked, because
  the search would walk into `ops`. `rg foo api` passes.
- `kubectl get pods` is denied in every spelling. `which kubectl` passes.

A denial reads like this:

```
guardrails: ops is consent-gated this session. Ask Sam to run /consent ops, then retry. Do not retry with another spelling or path.
```

The last sentence is on every denial. Without it, Claude tends to try `cd` plus a relative path, then
a symlink, then `bash -c`.

## Consent

`/consent <gate>` opens a gate for the rest of the session. The gates are `self-edit`,
`primary-commit`, and `<folder>` plus `<folder>-write` for each entry in `consentRepos`. An unknown
name gets a reply that lists the valid ones.

Consent only counts when you type it at the prompt and press Enter. If Claude or another plugin runs
`/consent`, it gets a refusal and nothing changes. The same goes for Remote Control.

- `/consent revoke <gate>` closes a gate again.
- `/consent` or `/consent list` shows the open gates and when each was opened. The status line shows
  them too.
- `/guardrails` shows the open gates and the last 50 denials, with the rule that fired and the
  command or path it caught.

Consent ends with the session. `/clear` drops it, and a resumed session starts with every gate shut.
Nothing is written to disk.

## Setup in the terminal

```
/plugin install guardrails --marketplace PranamRDoshi/dotclaude
```

Answer `y` to add the marketplace, then pick the user scope, which comes first in the list, so it
loads in every session and every project. The next screen sets the options. Leave them all at their
defaults if you only want the four rules above, and fill them in later with `/config`.

The plugin runs in that session as soon as the install finishes. To check, ask Claude to run
`git push origin main` in any repo, or to `cat .env`. You should see a `guardrails:` denial, and the
denial should show up in `/guardrails`.

## Setup in the desktop app

`/plugin` doesn't run in the desktop app. Click + next to the prompt box, then Plugins, then Add
marketplace with `PranamRDoshi/dotclaude`, then Add plugin.

The desktop app's Code tab reads the same `~/.claude` as the CLI, so one user-scope install from
either place covers both.

One caveat. The plugin asks git for the current branch, and gh for a PR's base branch, through the
engine's process API, which the engine marks as CLI only. I haven't checked how that behaves in the
desktop app. If the lookup fails there, every rule that needs it fails closed. Commits, rebases,
resets and pushes without a named branch get denied, and so does `gh pr merge`.

## If it blocks everything

Run this in a normal terminal, outside Claude:

```
claude plugin disable guardrails@dotclaude
```

Claude's attempt to run that command is denied unless you typed `/consent self-edit` first. That's
on purpose. A rule the model can switch off isn't a rule.

A missing `HOME` variable also blocks every tool call, since the plugin can't place `~` or its own
protected paths without it.

## Known gaps

It checks the command line, not what a program does once it runs.

- `make`, `npm run`, `bash script.sh` and every other program can write anywhere. Only paths
  named on the command line count.
- A path built from a shell variable, as in `$DIR/file`, can't be resolved, so it isn't checked.
  The same goes for a glob before the repo name, as in `~/code/*/config`. A glob after it is fine,
  because the static part before the `*` still names the repo.
- Nested `sh -c` and `eval` are followed four levels deep. Deeper ones stay opaque.
- Commands outside a short read list count as writing every path they name. That denies some
  harmless commands in a read-only repo or under an unknown directory.
- `ls -R`, `tree` and `du` aren't treated as recursive searches. Only `grep -r`, `rg`, `find`,
  `Grep` and `Glob` are.
- MCP tools aren't checked at all. An MCP server that reads files can read a consent-gated repo.
- `claude plugin marketplace remove <name>` isn't gated, since only the plugin name `guardrails` is
  matched.
- Folder names are compared without regard to case, so on Linux `~/code/Ops` is gated along with
  `~/code/ops`.
- It guards Claude's tool calls. It doesn't see what other plugins run through the engine's process
  API, or what you run yourself.
- macOS and Linux only. It parses POSIX shell commands and needs `HOME`, so on Windows outside WSL
  it would deny every call.
