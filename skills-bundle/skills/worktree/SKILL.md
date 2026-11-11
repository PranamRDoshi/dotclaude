---
name: worktree
description: >
  Create, inspect, and safely remove git worktrees for repos under the workspace root
  (WORKSPACE_ROOT, default ~/git), enforcing the worktree-first policy and the no-stale-worktree
  guarantee. Use whenever you are about to make a change that will be committed, when the user says
  "make a worktree", "clean up worktrees", "list worktrees", "any stale worktrees?", or when you
  finish a task that used one and need to tear it down. Also use before ending a session in which
  you created a worktree.
---

# Worktree

Worktrees are the default vehicle for changes in any repo under the workspace root, not an
opt-in. The policy in short:

- Every change headed for a commit happens in its own worktree at
  `$WORKTREES_DIR/<repo>--<slug>/`, cut from the repo's up-to-date integration branch.
- Remove a worktree once its PR is merged, the task is abandoned, or the session ends with no
  follow-up pending in it.
- Never remove a worktree that holds uncommitted or unpushed work, and never `rm -rf` one.
- Never remove a worktree you did not create in this session without asking.

This skill is the supported way to act on it.

## When to use

- **Before any edit headed for a commit** in any repo under the workspace root. Create the
  worktree first, then work inside it.
- **When a task finishes** (PR merged, task abandoned, session ending): remove the worktree.
- **When asked about strays**: list them and report, do not mass-delete.

Skip it for read-only work and for files that are not in a repo.

## Prerequisites

Run the `ensure-repo-sync` skill for the repo before creating a worktree. The base branch must be
current against the **remote**. A clone with a narrow fetch refspec can hold a stale
`origin/<branch>`; `git ls-remote --heads origin <branch>` shows what the remote really has.

## Configuration

- `WORKSPACE_ROOT`: folder that holds the repos, default `~/git`. A `<repo>` argument is a folder
  name under it or an absolute path.
- `WORKTREES_DIR`: where worktrees go, default `$WORKSPACE_ROOT/worktrees`.
- Integration branch per repo: `git config harness.integrationBranch <branch>` in that repo, else
  `develop` when origin has it, else the remote default branch (`origin/HEAD`), else `main`.

## Commands

All commands go through `worktree.sh`, bundled with this skill.

```bash
# create: path, base branch, and naming are enforced for you
"${CLAUDE_PLUGIN_ROOT}/skills/worktree/scripts/worktree.sh" new <repo> <branch>
#   e.g. worktree.sh new api feature/products-get-pagination
#   -> $WORKTREES_DIR/api--products-get-pagination on feature/products-get-pagination,
#      branched from the repo's integration branch
#   hotfix/* branches are the exception: they branch from current origin/main, or from the
#   remote default branch when origin has no main.

# inspect: every worktree under $WORKTREES_DIR with dirty / unpushed / age
"${CLAUDE_PLUGIN_ROOT}/skills/worktree/scripts/worktree.sh" list

# remove: refuses when there is uncommitted or unpushed work
"${CLAUDE_PLUGIN_ROOT}/skills/worktree/scripts/worktree.sh" remove <repo>--<slug>
"${CLAUDE_PLUGIN_ROOT}/skills/worktree/scripts/worktree.sh" remove <repo>--<slug> --keep-branch   # explicit no-op flag, branch is always kept
```

`new` refuses to clobber an existing path and requires a branch name with a prefix and literal
`/` separator. Any prefix is accepted; `hotfix/*` still branches from `origin/main`.

`remove` exits non-zero and changes nothing when the worktree has a dirty tree or commits that
are not on the remote. **Do not work around that refusal.** Push the work, or report it to the
developer and stop. It also refuses anything that is not a bare worktree name under
`$WORKTREES_DIR`. A branch with no remote counterpart passes only when `gh` confirms its HEAD is
the head of a merged PR.

## CodeGraph (optional)

When `codegraph` is on PATH and the primary checkout has a `.codegraph/codegraph.db` index, a
worktree of that repo gets its own index, because an index only describes the tree it sits in.
`new` copies the primary index and runs `codegraph sync`, which takes seconds; a rebuild from
scratch would take minutes. `remove` deletes it, but only once the dirty and unpushed checks have
passed, so a refused removal never costs you the index.

- Query it with `projectPath` (or `-p`) set to the **worktree** path. Pointing at the primary
  checkout while working in a worktree answers from the wrong branch.
- Provisioning is best effort. It is skipped silently when the repo has no index or `codegraph` is
  missing, and any failure warns and leaves the worktree usable.
- `new` also adds `.codegraph/` to the repo's `.git/info/exclude` when the repo does not already
  gitignore it, so the index can never be the untracked file that blocks `remove`.

## Reporting obligation

If a worktree you created has to outlive the session, name it in your final response: which one,
why it survives, and what has to happen before it can go. A worktree you did not create is not
yours to delete. Report it, with what `list` says about its state, and let the developer decide.

## Notes

- Removing a worktree never deletes its branch. Leave the branch alone. Never delete `main`,
  `master`, `develop` or the repo's integration branch.
- The script is POSIX/bash-3 safe so it runs on macOS and Linux.
- Do not run these commands against a worktree from inside a sandbox that mounts the workspace at
  a different path. Git records absolute paths, so the registry looks "prunable" when it is fine.
