# Git workflow and worktree policy

Applies to all work under `<workspace root>`. Use the `harness-skills:worktree` skill to create,
inspect and remove worktrees.

## Sync and branch hygiene

- Run the `harness-skills:ensure-repo-sync` skill for every in-scope repo before repo work.
  Read-only work may continue on a stale branch if you say so. Planning and edits wait until the
  repo is clean; ask before any merge that isn't a fast-forward.
- Verify the integration branch against the remote, not the clone. A clone with a narrow fetch
  refspec can hold an `origin/develop` that is months stale, and `git fetch origin develop` then
  only writes `FETCH_HEAD`. The tell: GitHub marks a PR `CONFLICTING` while a local
  `git merge-tree` is clean. Check and repair:

  ```bash
  git ls-remote --heads origin develop    # the truth
  git config --get-all remote.origin.fetch
  git fetch origin 'refs/heads/develop:refs/remotes/origin/develop' --force
  ```

- Never commit to `main`. `hotfix/*` branches are cut from up-to-date `main`.
- **Branch deletion _(strict)_.** Never delete `main`, `develop` or a repo's integration branch
  locally. Delete only merged branches unless the developer explicitly says to force-delete one.

## Worktree-first _(strict)_

**Every change headed for a commit happens in a dedicated worktree** at
`<workspace root>/worktrees/<repo>--<slug>/`, cut from the up-to-date integration branch (`main`
for `hotfix/*`). `<slug>` is the branch name minus its prefix, with `/` and `_` turned into `-`.
Use the worktree skill's `worktree.sh new <repo> <branch>`, which enforces path, base and naming.

Do **not** commit in a primary checkout unless the developer says so in the current session.
"Quick fix", "small change" and one-line diffs are still worktree work. Consent does not carry
over between sessions.

Exempt: read-only work, and files outside a repo such as the workspace's own harness files.

## Removal is not optional _(strict)_

Remove a worktree once its PR is merged, the task is abandoned or handed back with the work
pushed, or the session ends with no follow-up pending in it.

- Use the worktree skill's `worktree.sh remove <name>`, or `git worktree remove` then
  `git worktree prune`. Never `rm -rf` one.
- Never remove a worktree holding uncommitted or unpushed work. Push it, or report it and stop.
  Don't work around the skill's refusal.
- Removing a worktree doesn't delete its branch. Leave the branch alone.
- Never remove a worktree you didn't create in this session without asking.
- A worktree that outlives the session gets named in your final response with why it survives and
  what has to happen before it can go.
