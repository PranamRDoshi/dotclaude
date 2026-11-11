# Workspace working memory (`<workspace root>`)

Applies to all work under `<workspace root>`. Personal coding, hygiene, portability and writing
rules live in `~/.claude/CLAUDE.md` and apply here too. `AGENTS.md` and `GEMINI.md` symlink to
this file.

Rule files in `.claude/rules/` are listed below with when to read them. Claude loads them
automatically; Codex and other agents must open the listed file before doing the matching work.

## Repos and access _(strict)_

Active repos: **`<repo-a>`, `<repo-b>`, `<repo-c>`**. Don't read, modify or reason about any other
repo unless the developer names it or consents in-session.

<Keep the entries below that match your workspace and delete the rest. Each one maps to an option
of the guardrails mod, which turns the rule into a hard block.>

- **`<archived-repos>/`**: never read, grep or reason about without explicit in-session consent.
  Their migrated copies in `<repo-a>/` run in production. (guardrails `consentRepos`)
- **`<ops-repo>`**: consent required before searching or reading, asked again each session and
  each new task. Branch locked to `<branch>`: never switch to, create or check out another
  branch. Never commit or push unless the developer names that specific change in-session.
  (guardrails `consentRepos` and `branchLocks`)
- **`<vendor-sdk>`**: read and analyze freely. Never write: no edits, new files, formatting,
  renames, deletions or git write ops of any kind, however the request is phrased. If a task
  needs a change there, stop and say so, and never patch a vendored copy to route around it.
  (guardrails `readOnlyRepos`)

Top level holds only active repos, tooling repos, `worktrees/` and harness files.

## Session-start guardrails

1. **Sync first.** Run the `harness-skills:ensure-repo-sync` skill for every in-scope repo. For
   read-only work, report a failed check (repo, branch, how far behind) and continue. Before
   planning or edits, resolve it.
2. **Work in a worktree.** Every change headed for a commit goes in a worktree under
   `<workspace root>/worktrees/`, never a primary checkout, unless the developer says otherwise
   in this session. Read `.claude/rules/worktrees.md` before creating, committing in, or removing
   one.
3. **Commands that are never run.** <List them, for example a cluster CLI you only want a human
   to use.> Never run or suggest them; ask the developer to run them. (guardrails
   `blockedCommands`)
4. **Commits and branches** follow <your conventions doc>. Branch prefix and description are
   joined by a literal `/` (`feature/login`, never `feature-login`), even when a script generates
   the name.

## PRs, reviews and deploys

- **PR descriptions** use: What (with `Closes #NNN`), Why, How (non-obvious decisions only),
  Testing (automated, manual, untested edge cases), optional Screenshots or command output,
  optional Anything else. Complete sentences, concise, @mention the reviewer when relevant.
- **Automated reviews.** Never trigger one while another is running or queued; check first. After
  pushing fixes, wait for the automatic re-review unless asked. Resolve each thread right after
  replying to it.
- **Deploys.** Merging a fix does not deploy it: confirm the production rollout finished before
  calling a bug fixed. Verify cutover status against live state, not docs.

## Plans and specs

Look for the repo's `plans/` or `specs/` directory. If it exists, save there as
`plan_TitleCase.md` or `spec_TitleCase.md` without asking. If not, ask before creating it. A plan
already saved under `~/.claude/plans/` is moved or copied with its new name, never regenerated.
If you can't find a plan the user mentions, ask for its path right away.

## Skills and tooling

- Worktrees: the `harness-skills:worktree` skill. Policy: `.claude/rules/worktrees.md`.
- Creating or editing any `CLAUDE.md`/`AGENTS.md`: read `.claude/rules/authoring-memory-files.md`.
