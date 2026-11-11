#!/usr/bin/env bash
# Scans every git repo under the workspace root (WORKSPACE_ROOT, default $HOME/git) and prints
# its branch name, plus either "up-to-date" or the list of changed files, for a quick overview.
#
# Optionally runs the ensure-repo-sync validator against each repo too.
#
# Usage:
#   ./repo-status.sh            # just print status, ask before syncing
#   ./repo-status.sh --sync     # print status AND run sync validator, no prompt
#   ./repo-status.sh --no-sync  # print status only, never prompt

WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/git}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/validate-repo.sh"

RUN_SYNC=""   # "" = ask, "yes" = always, "no" = never
case "${1:-}" in
    --sync)    RUN_SYNC="yes" ;;
    --no-sync) RUN_SYNC="no" ;;
esac

if [ ! -d "$WORKSPACE_ROOT" ]; then
    echo "Directory not found: $WORKSPACE_ROOT"
    exit 1
fi

if [ "$RUN_SYNC" = "" ]; then
    read -r -p "Also run the repo-sync validator on each repo? [y/N] " answer
    case "$answer" in
        [yY]*) RUN_SYNC="yes" ;;
        *)     RUN_SYNC="no" ;;
    esac
fi

if [ "$RUN_SYNC" = "yes" ] && [ ! -x "$SYNC_SCRIPT" ]; then
    echo "Warning: sync script not found or not executable at $SYNC_SCRIPT, skipping sync."
    RUN_SYNC="no"
fi

# Worktrees have a .git file, not a directory, so only primary checkouts are listed.
find "$WORKSPACE_ROOT" -type d -name ".git" -print 2>/dev/null | sort | while read -r gitdir; do
    repo="$(dirname "$gitdir")"
    name="$(basename "$repo")"
    branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    changes="$(git -C "$repo" status --porcelain 2>/dev/null)"

    echo "$name ($branch)"
    if [ -z "$changes" ]; then
        echo "  up-to-date"
    else
        echo "$changes" | sed 's/^/  /'
    fi

    if [ "$RUN_SYNC" = "yes" ]; then
        echo "  -- sync check --"
        "$SYNC_SCRIPT" "$repo" 2>&1 | sed 's/^/  /'
    fi
    echo
done
