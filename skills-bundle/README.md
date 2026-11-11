# harness-skills

Four Claude Code skills for git work across several repos that sit side by side in one folder.
They write specs, check that local clones match their remote, work through PR review comments,
and keep every change in its own worktree.

## Skills

### write-spec

Writes technical and product spec documents in Markdown, with mermaid diagrams for flows, data
models and architecture. It reads the codebase first and asks about anything it would otherwise
have to assume. Claude uses it when you ask for a spec, a feature spec or a design doc.

### ensure-repo-sync

Checks that each repo you name is on its integration branch and matches the remote, and
fast-forwards it when it is only behind. It never resets, force-pushes or switches branches by
itself. Claude runs it when you ask for a repo sync, and as the first step of the worktree and
address-pr-review skills.

### address-pr-review

Collects a PR's diff and review threads with `gh`, checks each comment against the code, and
reports a verdict per thread. Nothing changes until you approve. Then it edits, runs the repo's
tests, commits, pushes to the PR branch, and replies to and resolves the threads it fixed. Claude
uses it when you point at a PR and ask it to handle the review.

### worktree

Creates one worktree per branch at `<WORKTREES_DIR>/<repo>--<slug>`, lists worktrees with their
dirty and unpushed state, and removes one only when no work would be lost. Claude uses it before
any edit headed for a commit, when you ask about worktrees, and when a task ends. The rule file
that tells Claude to work this way is `templates/rules/worktrees.md` in this repo.

## Requirements

- `git`
- `gh`, signed in (`gh auth status`). address-pr-review needs it, and `worktree remove` uses it to
  confirm that a branch with no remote copy was merged through a PR.
- `jq`, for the review-thread script in address-pr-review.
- bash 3.2 or later. The scripts run on macOS and Linux.

## Configuration

| Setting | Default | What it controls |
|---|---|---|
| `WORKSPACE_ROOT` | `$HOME/git` | Folder that holds your repos. A repo argument is a folder name under it or an absolute path. |
| `WORKTREES_DIR` | `$WORKSPACE_ROOT/worktrees` | Where `worktree` creates worktrees. |
| `git config harness.integrationBranch <branch>` | unset | Run inside one repo. Sets the branch new worktrees start from and the branch ensure-repo-sync expects. |

Set the two environment variables in your shell profile before you start Claude Code, or under
`env` in `settings.json`.

Without the git config, the scripts pick `develop` when origin has it, then the remote default
branch from `origin/HEAD`, then `main`. A `hotfix/*` branch always starts from `main`, or from the
remote default branch when origin has no `main`. If you set the integration branch to something
other than `develop` or the remote default, such as `dev/<name>`, ensure-repo-sync treats it as
your working branch: it may be ahead of its remote, and it must already contain the remote
default branch.

The scripts never delete `main`, `master`, `develop` or the integration branch, and removing a
worktree never deletes its branch.

### CodeGraph

This part is optional. If `codegraph` is on your PATH and a repo's primary checkout has a
`.codegraph/codegraph.db` index, `worktree new` copies that index into the new worktree and syncs
it, and `worktree remove` deletes it once the safety checks pass. Without CodeGraph, the worktree
skill skips this step.

## Install

```
/plugin install harness-skills --marketplace PranamRDoshi/dotclaude
```

Once installed, the skills are namespaced under the plugin: `harness-skills:write-spec`,
`harness-skills:ensure-repo-sync`, `harness-skills:address-pr-review` and `harness-skills:worktree`.
Type `/harness-skills:worktree` to run one directly, or describe the task and Claude picks the
skill.
