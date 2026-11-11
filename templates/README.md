# Templates

Instruction files, rule files and a settings example. Plugins cannot install these, so they are
copied into place and you fill in the placeholders. Anything in `<angle brackets>` is yours to
replace.

The repo's `install.sh` copies every file in the table below except the settings example, and only
where no file exists yet. The rest of this page is for copying by hand.

## What goes where

| File here | Copy to | What it is |
|---|---|---|
| `CLAUDE.md` | `~/.claude/CLAUDE.md` | Rules for every session on the machine: how to plan, code style, hygiene, tests, portability, writing |
| `workspace/CLAUDE.md` | `<workspace root>/CLAUDE.md` | Rules for the folder that holds your repos: which repos are in scope, worktree-first, PR format |
| `workspace/rules/worktrees.md` | `<workspace root>/.claude/rules/worktrees.md` | The worktree policy in full |
| `workspace/rules/authoring-memory-files.md` | `<workspace root>/.claude/rules/authoring-memory-files.md` | How to write and link `CLAUDE.md` and `AGENTS.md` files |
| `settings.example.json` | merge into `~/.claude/settings.json` | A read-only permission allow-list, a lint-on-edit hook, and this repo's plugins switched on |

"Workspace root" is the one folder that holds all your repos, such as `~/code`. The worktree
skill and the guardrails mod both take it as a setting.

## Copying

Do not overwrite a `CLAUDE.md` or `settings.json` you already have. Back it up and merge by hand.

```bash
mkdir -p ~/.claude ~/code/.claude/rules
cp templates/CLAUDE.md ~/.claude/CLAUDE.md
cp templates/workspace/CLAUDE.md ~/code/CLAUDE.md
cp templates/workspace/rules/*.md ~/code/.claude/rules/
```

For other agents that read `AGENTS.md`, symlink it next to each `CLAUDE.md`:

```bash
ln -s CLAUDE.md ~/code/AGENTS.md
```

## After copying

1. Replace every `<placeholder>`. In `workspace/CLAUDE.md`, delete the repo entries you have no
   use for.
2. Match the guardrails options to what the workspace file says. A rule written in `CLAUDE.md`
   asks Claude to behave. The same rule set as a guardrails option blocks the tool call.
3. The lint hook in `settings.example.json` needs `jq`, plus `ruff` for Python files and `go` for
   Go files. Drop the cases you do not use.
4. Set each plugin's options in `/config`, or at the prompt it shows on install.

## Other plugins this setup runs alongside

These belong to other people, so this repo links to them and does not copy them.

- [ponytail](https://github.com/DietrichGebert/ponytail): pushes for the smallest working change
- [samber/cc](https://github.com/samber/cc): Go skills
- [claude-code-warp](https://github.com/warpdotdev/claude-code-warp): Warp terminal integration
