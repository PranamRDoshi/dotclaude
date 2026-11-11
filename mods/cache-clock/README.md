# cache-clock

A status line for Claude Code that shows how much of the session you have used and how long the
prompt cache will stay warm. It draws at the end of the prompt hint row.

```
ctx [████░░░░░░] 41%  $3.13  cache warm 41m  5h 24% 2h13m  wk 80% 4d6h  Opus 5.5 (high)  ~/code (main)
```

## Why

An idle session that lets its prompt cache lapse pays to write the whole prefix again on the next
message. The countdown tells you when that is about to happen, and the Keep warm button resets it
with one small request.

## What the line shows

| Part | Meaning | Colour |
|---|---|---|
| `ctx [bar] 41%` | Context window fill | Green under 50%, yellow from 50%, red from 80% |
| `$3.13` | Session cost | Plain under $10, yellow from $10, red from $25 |
| `cache warm 41m` | Time until the prompt cache expires | Green while warm, yellow while cooling, red once cold |
| `5h 24% 2h13m` | 5-hour usage and time to its reset | Same grades as context |
| `wk 80% 4d6h` | Weekly usage and time to its reset | Same grades as context |
| `Opus 5.5 (high)` | Model and the main thread's effort | Dim |
| `~/code (main)` | Working directory and git branch | Branch turns red on a protected branch |

A part with no data drops out of the line. The cache counts as cooling in the last 10 minutes of a
1-hour TTL and the last 60 seconds of a 5-minute one.

## Keep warm

While the cache is cooling, a Keep warm button appears in the band above the prompt. One press
sends a tiny forked request ("Reply with OK."), which reads the cached prefix and restarts its
TTL. That request costs a cache read of your current context plus a few output tokens.

## Install

```
/plugin install cache-clock --marketplace PranamRDoshi/dotclaude
```

Needs Claude Code 2.1.287 or later, and `git` on the path for the branch name. If you already
have a `statusLine` in your settings, you will see both; remove the old one.

## Options

| Option | Default | Meaning |
|---|---|---|
| `fallbackTtl` | `1h` | The TTL to assume when a response does not say which one it wrote. `none` keeps the clock dark until a response does say. |
| `protectedBranches` | `main,master,develop` | Comma-separated branch names drawn red. Empty flags none. |

## Known limits

- The home folder shortens to `~` on macOS and Linux layouts only.
- The branch comes from `git` through the engine's process API, which the engine marks as CLI
  only. In the desktop app the branch may be missing.
