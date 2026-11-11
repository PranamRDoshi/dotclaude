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
| `mods/guardrails` | Planned | Hard-blocks tool calls that break your written rules |
| [`skills-bundle`](skills-bundle) | Ready | `write-spec`, `ensure-repo-sync`, `address-pr-review`, `worktree`, installed as the `harness-skills` plugin |
| `templates/` | Planned | `CLAUDE.md`, rule files and a settings example |

The order and the reasoning are in [plans/plan_PublicHarnessRepo.md](plans/plan_PublicHarnessRepo.md).

## Install

Type one line per plugin at the Claude Code prompt:

```
/plugin install cache-clock --marketplace PranamRDoshi/dotclaude
/plugin install timeline --marketplace PranamRDoshi/dotclaude
/plugin install inflight --marketplace PranamRDoshi/dotclaude
/plugin install harness-skills --marketplace PranamRDoshi/dotclaude
```

The first one asks `Add marketplace?`. Answer `y`, pick a scope, and set the options it offers.
Each mod's README lists its options and what it costs to run. `inflight` draws inside the
`timeline` pane, so install `timeline` first.

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
