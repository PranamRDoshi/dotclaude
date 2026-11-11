---
name: ensure-repo-sync
description: Check or sync named local repos when the user explicitly requests repo sync or invokes /ensure-repo-sync.
---

# Ensure repo sync

Resolve each requested repo to a folder under the workspace root (`WORKSPACE_ROOT`, default `~/git`) or to an absolute path. If a name matches no folder, ask instead of guessing. Run the validator once with all requested repos:

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/ensure-repo-sync/scripts/validate-repo.sh" <repo> [<repo> ...]
```

Each repo is expected on its integration branch: `git config harness.integrationBranch` if set, else `develop` when origin has it, else the remote default branch (`origin/HEAD`), else `main`. A configured integration branch that is neither `develop` nor the remote default branch counts as a long-lived working branch. It may be ahead of its remote, and it must already contain the remote default branch.

The validator fetches remote state and may fast-forward the checked-out branch. Report each result. For read-only work, a failed check is advisory; state that the local code may be stale. For planning or edits, resolve failures before proceeding. Ask before switching branches, merging, rebasing, pushing, or discarding changes. Never reset or force-push to repair a failed check. A clone with a narrow fetch refspec can hold a stale `origin/<branch>`; `git ls-remote --heads origin <branch>` shows what the remote really has.

For a one-screen status of every repo under the workspace root, run `"${CLAUDE_PLUGIN_ROOT}/skills/ensure-repo-sync/scripts/repo-status.sh" --no-sync`.
