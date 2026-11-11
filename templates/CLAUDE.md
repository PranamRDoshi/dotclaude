# Global working memory (`~/.claude`)

Machine-wide preferences for <your name>, a <backend-first> developer. Applies to every session on
this machine. If you also use Codex, symlink `~/.codex/AGENTS.md` to this file. Everything below
is written out in full for that reason: Codex does not follow `@` imports.

Repos under `<workspace root>` are governed by `<workspace root>/CLAUDE.md`. Read it before
touching them from a session rooted elsewhere.

## Before changing anything _(strict)_

Before changing anything: restate what I'm asking in one sentence, list the existing mechanisms
that might already cover it (workflow inputs, env vars, existing methods), and give your
root-cause or approach hypothesis with evidence. Wait for my OK.

For instruction-file changes, "existing mechanisms" means existing rules, skills and settings.
When debugging, also check whether the behaviour is a deliberate design choice, and separate
"slow" from "stuck" with real throughput numbers.

## Decision making help

With several threads running at once, I need clear decision boundaries and as little ambiguity as
possible.

Whenever I have to make a call, whether simple, technical or design-changing, give me only the
context I need to decide. No long explanations and nothing I have to read past.

## Sub-agents as first principle

- Use sub-agents wherever suitable to keep the main context lean.
- Prefer one model tier below the main session's for sub-agents, unless the sub-task needs the
  stronger model.
- The point is a lean context, so start each sub-agent with a brief narrow enough that its own
  context stays under 200K tokens unless that is unavoidable.

## Coding style

- Inline comments for non-trivial logic and for every technical, architectural or business
  decision the code makes. Concise and direct.
- Every file and function gets a docstring saying what it does and why.
- No new function longer than 100 lines.
- camelCase for variables and functions, PascalCase for classes, unless the file or repo already
  follows another convention (Python snake_case, for example). Then match it.
- Prefer short inline comments over dedicated docs or long docstrings, in code and in chat.
- No em dashes, in code, comments or prose.
- No direct pushes to develop or main in any repo.

## Code hygiene _(strict, every repo)_

- **Imports at the top of the file.** Never inside a function, method, class or other nested
  scope, in any language. Not as a quick fix, a circular-import workaround or a lazy load, unless
  the developer asks and explains why. Fix a circular import in the architecture.
- **No temp files, mock scripts or scratchpads in a repo.** Work in memory, read files directly,
  or put the logic in real source or test files. Scratch work goes in the session scratchpad.
- **Clean up your own orphans.** Remove imports, variables and functions your change left unused.
  Leave pre-existing dead code alone: flag it, don't delete it.

## Tests

- A test-writing task never touches source code.
- If an existing test contradicts the source, ask the developer which expectation is right before
  changing the test.

## Cross-platform (macOS + Linux) _(strict)_

All code runs on macOS (local dev) and recent Ubuntu (VMs, CI, Docker). Pitfalls:

- Bash: macOS ships 3.x. No `declare -A`, `mapfile`/`readarray` or `**` globbing. Use
  `#!/usr/bin/env bash`.
- BSD vs GNU `sed`/`grep`/`awk`/`stat`/`date` flags differ. Prefer Python or Perl, and Python for
  date arithmetic. `readlink -f` is missing on macOS; use `os.path.realpath`.
- `/proc` is Linux-only; gate it behind an OS check.
- Don't rely on filesystem case sensitivity either way. No hardcoded `/usr/bin/python3`.

When portability isn't feasible: for a standalone utility script, ask before writing mac and
Linux variants. For application code, write the Linux version and note the macOS gap at the top.

## Writing _(strict)_

Applies to all written output: chat replies, commit messages, PR descriptions, plans, specs, docs,
code comments and review comments.

- No em dashes anywhere, and no swapping in parentheses or en dashes to dodge that.
- Sentence-case headings, straight quotes, active voice, plain words.
- State what happened or what to do. Cut filler, hedging and sentences that could sit unchanged
  in another project's docs.
- Before sending, ask "what makes this read as machine-written?" and fix what turns up.

## Explaining frontend to a backend developer

<Keep this section if it fits you, or replace it with your own "explain X to a Y developer".>

Translate frontend terms (hooks, props, hydration, reconciliation, memoization and so on) into
backend language the first time they appear. Components are request handlers for a slice of UI,
state is an in-memory page cache, effects are async jobs after a state change. Lead with data
flow (API to state to DOM), mark the client/server boundary, skip styling unless the task is
about styling, and prefer a short numbered data-flow sketch over narrating the component tree.

## Knowledge base (optional)

<Delete this section if you keep no notes folder.>

Check `<path to your notes>` before web-searching about tools, libraries or patterns in use here.
When a session surfaces a non-obvious root cause, tool gotcha, library decision or integration
pattern, write it up there. Read that folder's own `CLAUDE.md` before creating or editing
anything in it.
