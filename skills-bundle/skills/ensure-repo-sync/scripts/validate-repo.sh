#!/usr/bin/env bash
# validate-repo.sh - Validate that one or more repos are on their integration branch and in sync
# with the remote, so planning and edits never start from stale code.
#
# Integration branch per repo: `git config harness.integrationBranch`, else develop when origin
# has it, else the remote default branch (origin/HEAD), else main.
# On the integration branch (or develop): auto-pulls (ff-only) if behind remote.
# A configured integration branch that is neither develop nor the remote default branch is a
#   long-lived working branch (for example dev/<name>): auto-pulls (ff-only) from its own remote
#   if behind, allows unpushed local commits, then checks that the remote default branch is
#   fully merged in.
#
# Usage: validate-repo.sh <repo> [<repo> ...]
#   <repo> is a folder name under WORKSPACE_ROOT (default: $HOME/git) or an absolute path.
# Exit codes:
#   0 - all repos valid (on the expected branch, in sync or were auto-pulled)
#   1 - wrong branch, or the working branch is behind the default branch (needs manual merge)
#   2 - repo is ahead of its remote branch (needs push), or the working branch has diverged from its remote
#   3 - fetch or pull failed
#   4 - invalid arguments or repo path

set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "ERR: Usage: validate-repo.sh <repo> [<repo> ...]" >&2
  exit 4
fi

WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/git}"
# Generic alternate branch accepted for any repo, validated against origin/develop the same
# way as the resolved branch.
ALT_DEFAULT_BRANCH="develop"
OVERALL_EXIT=0

# <repo> argument -> repo path. Absolute and ./ ../ paths are used as given; anything else
# is a folder under WORKSPACE_ROOT.
repo_path() {
  case "$1" in
    /*|.|..|./*|../*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$WORKSPACE_ROOT" "$1" ;;
  esac
}

# Does origin have this branch? The local remote-tracking ref answers without a network call;
# ls-remote covers clones whose narrow fetch refspec never created that ref.
remote_has() {
  git -C "$1" rev-parse --verify --quiet "refs/remotes/origin/$2" >/dev/null 2>&1 \
    || git -C "$1" ls-remote --exit-code origin "refs/heads/$2" >/dev/null 2>&1
}

# Remote default branch as the clone recorded it (origin/HEAD), else main.
default_branch() {
  local b
  b=$(git -C "$1" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  b="${b#origin/}"
  printf '%s' "${b:-main}"
}

# Integration branch: harness.integrationBranch git config, else develop when origin has it,
# else the remote default branch (bash 3.x compatible, no associative arrays).
integration_branch() {
  local b
  b=$(git -C "$1" config --get harness.integrationBranch 2>/dev/null)
  if [[ -z "$b" ]] && remote_has "$1" develop; then b="develop"; fi
  [[ -n "$b" ]] || b=$(default_branch "$1")
  printf '%s' "$b"
}

# Updates OVERALL_EXIT to the highest-priority exit code seen so far.
# Priority order (highest first): 4, 3, 2, 1, 0
update_exit() {
  local code="$1"
  if [[ "$code" -gt "$OVERALL_EXIT" ]]; then
    OVERALL_EXIT="$code"
  fi
}

# Checks one repo and records its exit code; never exits itself, so every repo gets checked.
validate_repo() {
  local REPO
  REPO=$(repo_path "$1")

  if [[ ! -d "$REPO/.git" ]]; then
    echo "ERR: '$REPO' is not a git repository." >&2
    update_exit 4
    return
  fi

  local REPO_NAME
  REPO_NAME=$(basename "$REPO")

  # Resolve the branch this repo should sit on. DEFAULT_BRANCH is what a normal checkout syncs
  # against; DEV_BRANCH is set only for a configured long-lived working branch, which must
  # absorb the remote default branch instead.
  local INTEGRATION REMOTE_DEFAULT DEFAULT_BRANCH DEV_BRANCH=""
  INTEGRATION=$(integration_branch "$REPO")
  REMOTE_DEFAULT=$(default_branch "$REPO")
  DEFAULT_BRANCH="$INTEGRATION"
  if [[ "$INTEGRATION" != "$ALT_DEFAULT_BRANCH" && "$INTEGRATION" != "$REMOTE_DEFAULT" ]]; then
    DEV_BRANCH="$INTEGRATION"
    DEFAULT_BRANCH="$REMOTE_DEFAULT"
  fi

  # 1. Branch check
  local BRANCH
  BRANCH=$(git -C "$REPO" branch --show-current 2>/dev/null || true)

  if [[ -n "$DEV_BRANCH" && "$BRANCH" == "$DEV_BRANCH" ]]; then
    # --- Part A: sync the local working branch with its own remote (origin/<branch>) ---
    # Only if the remote branch exists (it may be a purely local working branch for some repos).
    if git -C "$REPO" ls-remote --exit-code --heads origin "$DEV_BRANCH" >/dev/null 2>&1; then
      if ! git -C "$REPO" fetch origin "refs/heads/$DEV_BRANCH:refs/remotes/origin/$DEV_BRANCH" --quiet --force 2>/dev/null; then
        echo "ERR: Fetch failed for '$REPO_NAME' $DEV_BRANCH." >&2
        update_exit 3
        return
      fi

      local DEV_LOCAL DEV_REMOTE DEV_BASE
      DEV_LOCAL=$(git -C "$REPO" rev-parse HEAD)
      DEV_REMOTE=$(git -C "$REPO" rev-parse "origin/$DEV_BRANCH")
      DEV_BASE=$(git -C "$REPO" merge-base HEAD "origin/$DEV_BRANCH")

      if [[ "$DEV_LOCAL" == "$DEV_REMOTE" ]]; then
        : # already up to date with its remote
      elif [[ "$DEV_LOCAL" == "$DEV_BASE" ]]; then
        # Behind its remote: auto fast-forward pull.
        echo "INFO: '$REPO_NAME' $DEV_BRANCH is behind origin/$DEV_BRANCH by $(git -C "$REPO" rev-list --count "HEAD..origin/$DEV_BRANCH") commit(s). Pulling..." >&2
        if git -C "$REPO" pull --ff-only origin "$DEV_BRANCH" --quiet 2>/dev/null; then
          echo "INFO: '$REPO_NAME' $DEV_BRANCH pulled to $(git -C "$REPO" rev-parse --short HEAD)." >&2
        else
          echo "ERR: Pull of $DEV_BRANCH failed for '$REPO_NAME'. Resolve manually." >&2
          update_exit 3
          return
        fi
      elif [[ "$DEV_REMOTE" == "$DEV_BASE" ]]; then
        # Ahead of its remote: normal unpushed local work on a working branch; not an error.
        echo "INFO: '$REPO_NAME' $DEV_BRANCH is ahead of origin/$DEV_BRANCH by $(git -C "$REPO" rev-list --count "origin/$DEV_BRANCH..HEAD") unpushed commit(s)." >&2
      else
        # Diverged from its remote: needs manual resolution.
        echo "ERR: '$REPO_NAME' $DEV_BRANCH has diverged from origin/$DEV_BRANCH (ahead $(git -C "$REPO" rev-list --count "origin/$DEV_BRANCH..HEAD"), behind $(git -C "$REPO" rev-list --count "HEAD..origin/$DEV_BRANCH")). Resolve manually." >&2
        update_exit 2
        return
      fi
    else
      echo "INFO: '$REPO_NAME' could not reach origin/$DEV_BRANCH (no remote branch or fetch failed); skipping remote pull." >&2
    fi

    # --- Part B: ensure the working branch has incorporated all commits from the default remote branch ---
    if ! git -C "$REPO" fetch origin "refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH" --quiet --force 2>/dev/null; then
      echo "ERR: Fetch failed for '$REPO_NAME' $DEFAULT_BRANCH." >&2
      update_exit 3
      return
    fi
    if git -C "$REPO" merge-base --is-ancestor "origin/$DEFAULT_BRANCH" HEAD 2>/dev/null; then
      echo "OK: '$REPO_NAME' is on $DEV_BRANCH and up-to-date with $DEFAULT_BRANCH."
      update_exit 0
    else
      local BEHIND
      BEHIND=$(git -C "$REPO" rev-list --count "HEAD..origin/$DEFAULT_BRANCH" 2>/dev/null || echo "?")
      echo "ERR: '$REPO_NAME' $DEV_BRANCH is behind origin/$DEFAULT_BRANCH by $BEHIND commit(s). Merge $DEFAULT_BRANCH into $DEV_BRANCH before proceeding." >&2
      update_exit 1
    fi
    return
  fi

  # Accept the repo's resolved branch, or the generic alternate branch "develop".
  # Whichever one matches becomes the remote branch to sync against.
  local SYNC_BRANCH=""
  if [[ "$BRANCH" == "$DEFAULT_BRANCH" ]]; then
    SYNC_BRANCH="$DEFAULT_BRANCH"
  elif [[ "$BRANCH" == "$ALT_DEFAULT_BRANCH" ]]; then
    SYNC_BRANCH="$ALT_DEFAULT_BRANCH"
  else
    local ACCEPTED="'$DEFAULT_BRANCH'"
    [[ "$ALT_DEFAULT_BRANCH" != "$DEFAULT_BRANCH" ]] && ACCEPTED="$ACCEPTED, '$ALT_DEFAULT_BRANCH'"
    [[ -n "$DEV_BRANCH" ]] && ACCEPTED="$ACCEPTED, '$DEV_BRANCH'"
    echo "ERR: Repo '$REPO_NAME' is on branch '$BRANCH', not one of $ACCEPTED. Switch to the correct branch before proceeding." >&2
    update_exit 1
    return
  fi

  # 2. Fetch and sync check
  if ! git -C "$REPO" fetch origin "refs/heads/$SYNC_BRANCH:refs/remotes/origin/$SYNC_BRANCH" --quiet --force 2>/dev/null; then
    echo "ERR: Fetch failed for '$REPO_NAME' $SYNC_BRANCH." >&2
    update_exit 3
    return
  fi

  local LOCAL REMOTE BASE
  LOCAL=$(git -C "$REPO" rev-parse HEAD)
  REMOTE=$(git -C "$REPO" rev-parse "origin/$SYNC_BRANCH")
  BASE=$(git -C "$REPO" merge-base HEAD "origin/$SYNC_BRANCH")

  if [[ "$LOCAL" == "$REMOTE" ]]; then
    echo "OK: '$REPO_NAME' is on $SYNC_BRANCH and up to date."
    update_exit 0
    return
  fi

  if [[ "$LOCAL" == "$BASE" ]]; then
    # Local is behind remote: auto-pull
    echo "INFO: '$REPO_NAME' is behind remote by $(git -C "$REPO" rev-list --count "HEAD..origin/$SYNC_BRANCH") commit(s). Pulling..." >&2
    if git -C "$REPO" pull --ff-only "origin" "$SYNC_BRANCH" --quiet 2>/dev/null; then
      echo "OK: '$REPO_NAME' pulled to $(git -C "$REPO" rev-parse --short HEAD)."
      update_exit 0
    else
      echo "ERR: Pull failed for '$REPO_NAME'. Resolve manually." >&2
      update_exit 3
    fi
    return
  fi

  if [[ "$REMOTE" == "$BASE" ]]; then
    # Local is ahead of remote
    local AHEAD_COUNT
    AHEAD_COUNT=$(git -C "$REPO" rev-list --count "origin/$SYNC_BRANCH..HEAD")
    echo "ERR: '$REPO_NAME' is ahead of remote $SYNC_BRANCH by $AHEAD_COUNT commit(s). Push or reset before proceeding." >&2
    update_exit 2
    return
  fi

  # Diverged (both ahead and behind)
  local AHEAD_COUNT BEHIND_COUNT
  AHEAD_COUNT=$(git -C "$REPO" rev-list --count "origin/$SYNC_BRANCH..HEAD")
  BEHIND_COUNT=$(git -C "$REPO" rev-list --count "HEAD..origin/$SYNC_BRANCH")
  echo "ERR: '$REPO_NAME' has diverged from remote $SYNC_BRANCH (ahead by $AHEAD_COUNT, behind by $BEHIND_COUNT). Resolve manually." >&2
  update_exit 2
}

for REPO_ARG in "$@"; do
  validate_repo "$REPO_ARG"
done

exit "$OVERALL_EXIT"
