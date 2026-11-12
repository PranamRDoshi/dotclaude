#!/usr/bin/env bash
# Installs the whole dotclaude setup on one machine: the five plugins from this repo's
# marketplace, plus the instruction-file templates wherever no file exists yet.
# Safe to run twice. It never overwrites a file and never edits permissions or hooks.
#
# Usage: install.sh [workspace-root]
#   workspace-root   the folder that holds your repos, such as ~/code. When given, the workspace
#                    CLAUDE.md and rule files are copied there and guardrails is pointed at it.
# Environment:
#   CLAUDE_CONFIG_DIR   install into this folder instead of ~/.claude (Claude Code reads it too)
#   DOTCLAUDE_PLUGINS   space-separated plugin names, to install fewer than all five
set -euo pipefail

# The https URL, not owner/repo: the short form clones over ssh, which fails without a GitHub key.
SOURCE="https://github.com/PranamRDoshi/dotclaude.git"
MIN_VERSION="2.1.287"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# timeline comes before inflight, which draws inside the timeline pane.
PLUGINS="${DOTCLAUDE_PLUGINS:-cache-clock timeline inflight guardrails harness-skills}"
WORKSPACE="${1:-}"

# Prints a message and stops.
die() { echo "install.sh: $*" >&2; exit 1; }

# True when dotted version $1 is at least $2. Compares the first three numeric fields.
versionAtLeast() {
  local IFS=. i
  local have=($1) want=($2)
  for i in 0 1 2; do
    if (( ${have[i]:-0} > ${want[i]:-0} )); then return 0; fi
    if (( ${have[i]:-0} < ${want[i]:-0} )); then return 1; fi
  done
  return 0
}

# Copies $1 to $2 unless $2 exists, so a file you already wrote always wins.
copyIfAbsent() {
  if [ -e "$2" ]; then
    echo "  kept   $2 (already there)"
  else
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2"
    echo "  copied $2"
  fi
}

command -v git >/dev/null || die "git is not installed"
command -v claude >/dev/null || die "claude is not installed. See https://claude.com/claude-code"
# `claude --version` prints "2.1.322 (Claude Code)"; the first word is the version.
version="$(claude --version | awk '{print $1}')"
versionAtLeast "$version" "$MIN_VERSION" \
  || die "Claude Code $version is too old, mods need $MIN_VERSION or later. Run: claude update"

if [ -n "$WORKSPACE" ]; then
  [ -d "$WORKSPACE" ] || die "workspace root $WORKSPACE is not a folder"
  WORKSPACE="$(cd "$WORKSPACE" && pwd)"
fi

echo "Installing plugins into $CONFIG_DIR"
for plugin in $PLUGINS; do
  # guardrails only enforces its repo rules once it knows where the repos live.
  if [ "$plugin" = guardrails ] && [ -n "$WORKSPACE" ]; then
    claude plugin install "$plugin" --marketplace "$SOURCE" --scope user --config "workspaceRoot=$WORKSPACE"
  else
    claude plugin install "$plugin" --marketplace "$SOURCE" --scope user
  fi
done

# The marketplace is a full clone of this repo, so the templates are already on disk.
templates="$CONFIG_DIR/plugins/marketplaces/dotclaude/templates"
[ -d "$templates" ] || die "templates not found at $templates"

echo "Copying templates"
copyIfAbsent "$templates/CLAUDE.md" "$CONFIG_DIR/CLAUDE.md"
if [ -n "$WORKSPACE" ]; then
  copyIfAbsent "$templates/workspace/CLAUDE.md" "$WORKSPACE/CLAUDE.md"
  for rule in "$templates"/workspace/rules/*.md; do
    copyIfAbsent "$rule" "$WORKSPACE/.claude/rules/$(basename "$rule")"
  done
fi

cat <<EOF

Done. What is left is yours to do:
  1. Start claude and log in if this machine has not yet.
  2. Replace every <placeholder> in the copied CLAUDE.md files.
  3. Set plugin options in /config. Each mod's README lists them.
  4. Permissions and the lint hook are not installed. Merge what you want by hand from
     $templates/settings.example.json
guardrails now blocks pushes and commits on main, master and develop, and reads of dotenv files.
To switch it off, run this in a normal terminal: claude plugin disable guardrails@dotclaude
EOF
