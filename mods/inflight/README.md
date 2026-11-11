# inflight

Shows two things inside the `timeline` mod's side pane. On top, the state of your MCP servers. At the
bottom, your git worktrees with their PR, CI state and whether each one is safe to delete.

I wrote it because worktrees pile up. Once a PR merges, the tree that built it is dead weight, and
checking each one by hand gets old. This mod checks for you and offers a Remove button when it is sure.

## Install

It draws inside the `timeline` pane, so install `timeline` first.

```
/plugin install timeline --marketplace PranamRDoshi/dotclaude
/plugin install inflight --marketplace PranamRDoshi/dotclaude
```

## Requirements

- `git` 2.31 or later. Older versions lack `rev-parse --path-format`.
- `gh`, signed in with `gh auth login`, for PR and CI state. Without it every row still shows its
  local git state, and the verdict reads `unknown` with gh's error.

## What the pane shows

The MCP block lists connected servers on one line. A configured server that never connected gets a
red row of its own. A server waiting on a sign-in gets a yellow row. claude.ai connectors you never
signed in to collapse into one dim count.

The worktree list groups rows by repo and numbers them 1 to N. Each row shows:

- `pr`: the linked PR's number and state. An open PR wins over closed ones on the same branch.
- `ci`: pass, fail or pending, folded from the PR's status checks.
- `review`: the state of the one check named in `reviewCheck`, once the PR has it. Never shown when that option is empty.
- `local`: uncommitted files, unpushed commits, a detached HEAD or a missing remote branch.
- `verdict`: shown when it is `remove`, with the Remove button beside it.
- `gh`: gh's error, when gh failed and the verdict is `unknown`.

The header shows the scan time, whether gh answered, and a Refresh button on the `r` key.

## Options

Set them at install time or later in `/config`. A change reloads the mod.

| Option | Default | Meaning |
|---|---|---|
| `worktreesRoot` | empty | A folder whose child folders are worktrees. A leading `~` is your home folder. Empty means the linked worktrees of the repo the session runs in, read from `git worktree list`, without the main worktree. If the session is not in a git repo, the list is empty and the pane says so. |
| `removeCommand` | `git worktree remove {path}` | What the Remove button runs. See below. |
| `skipRepos` | empty | Comma-separated repo names whose worktrees show by name only. A folder named `<repo>--...` is skipped before any git call. A folder without that prefix gets one git call to learn its repo; if the repo is listed, nothing more runs. |
| `reviewCheck` | empty | Exact name of one status check, such as a review bot's, to report on its own `review` line. Empty means every check counts toward CI. |

The repo of a worktree comes from git (`rev-parse --git-common-dir`), not from the folder name. The
name shown is the folder name, minus a leading `<repo>--` when there is one.

## How the verdict is decided

The first rule that matches wins. Anything the mod cannot prove is on GitHub keeps the tree.

1. A skipped repo: keep.
2. Not a git worktree, or git could not be read: unknown.
3. Detached HEAD: keep.
4. Uncommitted files: keep.
5. Commits not on `origin/<branch>`: keep.
6. gh failed: unknown.
7. No remote branch: remove only when the PR merged and HEAD is the PR's head commit, which proves
   the work landed. Otherwise keep.
8. No PR: keep.
9. Open PR: keep. The reason shows `ci <state>`, plus `review <state>` when `reviewCheck` is set.
10. Merged or closed PR, clean and pushed: remove.

The mod never fetches. Local state is as fresh as your last fetch or push.

## The Remove button

It appears only on a `remove` verdict. One press runs `removeCommand` without a shell, from the
worktree's main repository folder. The mod splits the command on spaces, then fills in `{path}` with
the worktree's full path and `{name}` with its folder name, so a path with spaces stays one argument.
A leading `~` on the program is your home folder.

The default, `git worktree remove {path}`, refuses a tree with uncommitted or untracked files, and
it leaves the branch alone. The toast shows the command's last output line on success, or its first
error line on a refusal. The list rescans afterwards.

## When it scans

Worktrees rescan at session start, every 5 minutes, and 3 seconds after a Bash call that ran
`git push`, `git worktree`, or the program named in `removeCommand`. MCP state refreshes every
minute, starting 10 seconds after the session starts. Nothing scans in a `claude -p` run.

`/inflight` rescans both now and opens the timeline pane.

## Known limit

The engine marks `$.process`, which runs `git` and `gh`, as CLI only. I have not checked the
worktree list in the desktop app, so it may stay empty there.
