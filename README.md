# dotclaude

A reproducible Claude Code setup. Mods that change the interface, skills for the git workflow,
and the instruction files that tell Claude how to work, all installable on a fresh machine.

This is one developer's daily setup with the employer-specific parts removed. Paths, branch
names and tool names that used to be hard-coded are options with neutral defaults.

## What is here

| Piece | Status | What it is |
|---|---|---|
| [`mods/cache-clock`](mods/cache-clock) | Ready | Status line with context, cost, prompt cache countdown and usage windows |
| [`mods/timeline`](mods/timeline) | Ready | Side pane of session milestones, written by one small model call per turn |
| [`mods/inflight`](mods/inflight) | Ready | MCP server status and a worktree list with PR and CI state |
| [`mods/guardrails`](mods/guardrails) | Ready | Hard-blocks tool calls that break your written rules |
| [`skills-bundle`](skills-bundle) | Ready | `write-spec`, `ensure-repo-sync`, `address-pr-review`, `worktree`, installed as the `harness-skills` plugin |
| [`templates/`](templates) | Ready | `CLAUDE.md`, rule files and a settings example |
| [`install.sh`](install.sh) | Ready | Installs all of the above on a fresh machine |

The order and the reasoning are in [plans/plan_PublicHarnessRepo.md](plans/plan_PublicHarnessRepo.md).

## Install everything

One command installs the five plugins and copies the global `CLAUDE.md` template. It needs `git`
and Claude Code 2.1.287 or later.

```bash
curl -fsSL https://raw.githubusercontent.com/PranamRDoshi/dotclaude/main/install.sh | bash
```

Pass the folder that holds your repos to also get the workspace `CLAUDE.md` and rule files there,
and to point `guardrails` at it:

```bash
curl -fsSL https://raw.githubusercontent.com/PranamRDoshi/dotclaude/main/install.sh | bash -s -- ~/code
```

[`install.sh`](install.sh) is short enough to read first. It is safe to run twice. It
never overwrites a file you already have, and it leaves permissions and hooks alone: merge those by
hand from [`templates/settings.example.json`](templates/settings.example.json). The one setting it
adds is `"tui": "fullscreen"`, and only when you have not picked a layout. Without it the `timeline`
pane sits above the prompt and not beside the transcript.

- `CLAUDE_CONFIG_DIR=~/.claude-trial` in front of `bash` installs into that folder and leaves
  `~/.claude` untouched. Start Claude Code with the same variable to use it.
- `DOTCLAUDE_PLUGINS="cache-clock timeline"` installs only the plugins you name.

`guardrails` blocks pushes and commits on `main`, `master` and `develop` and reads of `.env` files
as soon as it is installed. Read its README first, or leave it out with `DOTCLAUDE_PLUGINS`.

## Install one plugin

Type one line per plugin at the Claude Code prompt:

```
/plugin install cache-clock --marketplace PranamRDoshi/dotclaude
/plugin install timeline --marketplace PranamRDoshi/dotclaude
/plugin install inflight --marketplace PranamRDoshi/dotclaude
/plugin install guardrails --marketplace PranamRDoshi/dotclaude
/plugin install harness-skills --marketplace PranamRDoshi/dotclaude
```

The first one asks `Add marketplace?`. Answer `y`, pick a scope, and set the options it offers.
Each mod's README lists its options and what it costs to run. `inflight` draws inside the
`timeline` pane, so install `timeline` first. Read the `guardrails` README before installing it:
it blocks commits on `main`, `master` and `develop` out of the box.

From a shell, the same thing is `claude plugin install <name> --marketplace PranamRDoshi/dotclaude`.
In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with
`PranamRDoshi/dotclaude`, then Add plugin.

Mods need Claude Code 2.1.287 or later.

## Develop

```
claude plugin test mods/<name>
claude plugin validate mods/<name>
```

Each mod's `tsconfig.json` extends a types folder that Claude Code writes into the mod the first
time it loads it, so type-checking in an editor works after one load with
`claude --plugin-dir mods/<name>`.

## License

MIT. See [LICENSE](LICENSE).
