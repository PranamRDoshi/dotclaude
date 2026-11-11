# Plan: a public, reproducible Claude Code harness

Status: phases 1 to 5 are in the repo. Phase 6 is not started.

## Goal

One repo that lets anyone reproduce a working Claude Code setup: the mods, the skills, and the
instruction and rule files that go with them. Everything tied to one employer or one machine is
either left out or turned into a setting with a neutral default.

## What Claude Code already gives us

- **Plugin marketplaces.** A repo with `.claude-plugin/marketplace.json` is a marketplace. Each
  mod and the skills bundle is a plugin in it, installed with
  `/plugin install <name> --marketplace PranamRDoshi/dotclaude`. No installer script is needed.
- **`userConfig`.** A plugin declares its options in `plugin.json`, and Claude Code asks for them
  at install time and shows them in its config menu. Anything that used to be a hard-coded path
  or name becomes one of these.
- **Nothing for instruction files.** `CLAUDE.md` and rule files cannot be installed by a plugin,
  so they ship as templates with a copy step in the README.

## Layout

```
.claude-plugin/marketplace.json   the marketplace, one entry per plugin
mods/<name>/                      one plugin per mod
skills-bundle/                    one plugin holding the skills
templates/                        CLAUDE.md, rule files, settings example
plans/                            this file
```

## Phases, one PR each

### 1. Skeleton

README, `.gitignore` and this plan. The marketplace file lands with the first plugins in phase 2,
because an empty marketplace installs nothing.

### 2. Three mods made generic

| Mod | What it does | Change |
|---|---|---|
| `cache-clock` | Status line: context, cost, prompt cache countdown, usage windows, model, cwd and branch, plus a Keep warm button | The list of branches drawn red becomes the `protectedBranches` option (default `main,master,develop`). |
| `timeline` | One Haiku call per turn adds a milestone row to a side pane and may suggest one memory | Neutral examples in the model prompt. New options `autoOpen` and `suggestMemories`. The README states the per-turn model cost. |
| `inflight` | MCP server status and a worktree list with PR, CI and a removal verdict, drawn inside the timeline pane | See below. Declares `timeline` as a dependency. |

`inflight` options:

| Option | Default | Meaning |
|---|---|---|
| `worktreesRoot` | empty | A folder whose child folders are worktrees. Empty means the worktrees of the repo the session runs in, from `git worktree list`. |
| `removeCommand` | `git worktree remove {path}` | What the Remove button runs. `{path}` and `{name}` are filled in. Run without a shell. |
| `skipRepos` | empty | Comma-separated repo names listed by name only, never read with git or gh. |
| `reviewCheck` | empty | The name of one status check to report on its own line, apart from CI. For a review bot. |

The repo of a worktree comes from git (`rev-parse --git-common-dir`), not from the folder's name.

Done when each mod passes `claude plugin test` and
`claude plugin validate --profile directory`.

### 3. Skills

`write-spec`, `ensure-repo-sync`, `address-pr-review` and `worktree`, in one plugin. Each is
checked for author and license first. Repo lists and paths inside them become placeholders or
arguments.

### 4. Templates

`CLAUDE.md` (global working rules), `rules/worktrees.md`, `rules/authoring-memory-files.md` and
`settings.example.json`. The README says where each one goes.

### 5. `guardrails`

The mod that hard-blocks tool calls which break the written rules. Its rules become a config
list, so the defaults cover the common cases (no pushes to protected branches, no reads of
`.env` files, no commits in a primary checkout) and a team adds its own. The README covers
setup for the terminal CLI and the desktop app.

### 6. Dogfood

The author's own machine installs from this repo, with local values in settings. From then on
there is one copy of the code.

## Checks before every push

1. Secret scan over the files being added.
2. Search for employer names, client names, internal hostnames and home-directory paths.
3. `claude plugin validate` on every plugin touched.

## Out of scope

- Memory files, saved plans and anything under `~/.claude.json`.
- Skills and rules that only make sense inside one organization.
- Third-party skills. The README links to them instead of copying them.
