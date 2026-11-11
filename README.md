# dotclaude

A reproducible Claude Code setup. Mods that change the interface, skills for the git workflow,
and the instruction files that tell Claude how to work, all installable on a fresh machine.

This is one developer's daily setup with the employer-specific parts removed. Paths, branch
names and tool names that used to be hard-coded are options with neutral defaults.

## What is here

| Piece | Status | What it is |
|---|---|---|
| `mods/cache-clock` | Phase 2 | Status line with context, cost, prompt cache countdown and usage windows |
| `mods/timeline` | Phase 2 | Side pane of session milestones, written by one small model call per turn |
| `mods/inflight` | Phase 2 | MCP server status and a worktree list with PR and CI state |
| `mods/guardrails` | Phase 5 | Hard-blocks tool calls that break your written rules |
| `skills-bundle` | Phase 3 | `write-spec`, `ensure-repo-sync`, `address-pr-review`, `worktree` |
| `templates/` | Phase 4 | `CLAUDE.md`, rule files and a settings example |

The order and the reasoning are in [plans/plan_PublicHarnessRepo.md](plans/plan_PublicHarnessRepo.md).

## Install

Nothing is installable yet. Once phase 2 lands, each mod installs with one line typed at the
Claude Code prompt:

```
/plugin install <name> --marketplace PranamRDoshi/dotclaude
```

Mods need Claude Code 2.1.287 or later.

## License

MIT. See [LICENSE](LICENSE).
