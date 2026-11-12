# timeline

A side pane that keeps a short log of what a Claude Code session has achieved. After each turn,
one small Haiku call decides whether the turn produced an outcome worth seeing an hour later. If
it did, the pane gets one row. Most turns get none.

```
09:30  pr-raised          PR #1680 raised into develop           #1680
09:52  workflow-failed    dashboard CI red on #1680, lint step   #1680
10:05  verification-done  export 500s gone on prod after the hotfix
```

## What gets a row

Outcomes, not actions. The call picks one kind from a fixed list:

`pr-raised`, `workflow-triggered`, `workflow-passed`, `workflow-failed`, `deploy-failed`, `retry`,
`verification-done`, `tests-updated`, `other`, and `turn` for a decision, finding or blocker that
fits none of them.

Reading code, editing files, planning, status checks and answers to questions get no row. If the
call fails or its reply is unusable, the row falls back to your own prompt, so a real outcome is
never lost.

The newest row is bold. Older rows keep PR numbers and up to four key names bold. The kind word
takes a colour from the turn's area of work (hotfix, deploy, infra, debug, ci, review), and a
failed run is always red.

## Memory suggestions

The same call may suggest one memory: a preference, a correction or a project fact that your
code and git history do not already hold. It shows in a band above the prompt with Save and Skip.

Save submits a normal prompt, `Save this to memory (<type>): <text>`, and your session writes the
memory under its own rules. The mod never writes a memory file itself. This relies on Claude
Code's auto memory. Without it, set `suggestMemories` to `off`.

## Cost and what is sent

Each main-thread turn makes one Haiku request with at most 300 output tokens. Subagent turns make
none. The request carries:

- your prompt and Claude's final answer, each cut to 4,000 characters
- the last 40 tool calls, each summarized in 200 characters
- the last 5 milestones
- your memory index (`MEMORY.md`), only while `suggestMemories` is on

The fixed rules and the memory index are marked for the prompt cache, so they are billed as
cache reads after the first turn. Every call's token usage goes to the debug log
(`claude --debug`), so you can add up a week of spend.

## Install

```
/plugin install timeline --marketplace PranamRDoshi/dotclaude
```

Needs Claude Code 2.1.287 or later.

## Use

- `/timeline` opens the pane.
- With `autoOpen` on, the pane opens by itself once per session when the terminal is at least
  144 columns wide. Close it and it stays closed for that session.
- The pane sits beside the transcript only in Claude Code's fullscreen layout, which is
  `"tui": "fullscreen"` in `~/.claude/settings.json`. On the main screen, and inside tmux by
  default, it sits above the prompt.

## Options

| Option | Default | Meaning |
|---|---|---|
| `autoOpen` | `on` | Open the pane once at session start. `off` waits for `/timeline`. |
| `suggestMemories` | `on` | Allow one memory suggestion per turn. `off` never reads or sends the memory index. |

## Known limits

- Rows live for the session. A new session starts with an empty pane.
- The pane keeps the newest 500 rows.
- Other mods can draw into this pane. `inflight` from this repo adds MCP status above the rows
  and a worktree list below them.
