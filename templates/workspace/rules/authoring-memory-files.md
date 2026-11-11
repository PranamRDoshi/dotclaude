# Authoring CLAUDE.md / AGENTS.md memory files

Applies whenever you create or edit an agent memory file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`)
or a `.claude/rules/` file.

## Canonical file + symlink model

`CLAUDE.md` is the real file. `AGENTS.md` and other aliases are same-directory relative symlinks
to it (`ln -s CLAUDE.md AGENTS.md`). Inspect with `ls -la` first, then:

1. **Neither exists**: create `CLAUDE.md`, then symlink the aliases.
2. **One exists**: edit it (or its symlink target) and symlink the missing name to it. Don't
   convert an existing real file into a symlink.
3. **Both are independent real files**: apply identical changes to both, then stop and tell the
   user about the duplicate. Don't merge or relink them yourself.

## Content and loading

- Put essential instructions directly in the relevant `CLAUDE.md`. Keep nested guides for areas
  that are operated independently.
- A rule file must hold distinct, actionable local requirements. No length-based splitting, no
  generic engineering advice, no restating what a parent guide already says.
- Claude loads every `.claude/rules/*.md` without `paths` frontmatter at startup, whatever the hub
  calls it. A situational rule gets `paths:` frontmatter plus a one-line "read before X" entry in
  its hub. Don't `@import` conditional rules.
- Codex reads only the `AGENTS.md` chain and ignores `@` imports and `paths`. The hub must name
  each rule file it depends on with the task that triggers reading it.
- Runbooks, inventories, history and long examples belong in ordinary docs, not `.claude/rules/`.
- Never `@import` consent-gated content. Reference it as a pointer plus the consent rule.
- Mark hard rules `_(strict)_`. When moving a strict rule, keep its wording.

## Repo self-containment _(strict)_

A repo's committed instruction files must never reference a path outside the repo: no
`~/code/...`, `~/.claude/...` or other machine-local path. Everything must resolve from a fresh
clone, on any machine, in CI. A rule that points at a file in someone's home folder is undefined
for everyone else. Inline the minimum needed instead of linking out. This doesn't apply to
`~/.claude/CLAUDE.md`, the workspace `CLAUDE.md` or their rule files, which are machine-wide by
design.

## Before finishing

- Back up a local (non-repo) instruction file before rewriting it.
- Verify: every `@import` and linked rule exists, consent-gated files are imported nowhere,
  aliases resolve (`readlink <alias>`), and no committed repo instruction names a machine path.
