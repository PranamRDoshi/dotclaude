#!/usr/bin/env bash
# worktree.sh - create, list, and safely remove git worktrees for repos under the workspace root.
# Enforces a worktree-first workflow: each change headed for a commit gets its own worktree,
# and a worktree is never removed while it holds work that is not on the remote.
# POSIX/bash-3 safe: no associative arrays, no mapfile, no readlink -f. macOS + Linux.
#
# Configuration:
#   WORKSPACE_ROOT  folder that holds the repos (default: $HOME/git)
#   WORKTREES_DIR   folder for worktrees (default: $WORKSPACE_ROOT/worktrees)
#   git config harness.integrationBranch <branch>   per-repo base branch override

set -u

WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/git}"
WT_ROOT="${WORKTREES_DIR:-$WORKSPACE_ROOT/worktrees}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
warn() { printf 'warn: %s\n' "$1" >&2; }

usage() {
  cat <<EOF
usage: worktree.sh <command> [args]

  new <repo> <branch>     create $WT_ROOT/<repo>--<slug> on <branch>
  list                    show every worktree under $WT_ROOT with its state
  remove <name>           safely remove $WT_ROOT/<name> (refuses dirty/unpushed)

<repo> is a folder name under $WORKSPACE_ROOT or an absolute path
<branch> must include a prefix and literal / separator
EOF
}

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
  db=$(git -C "$1" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  db="${db#origin/}"
  printf '%s' "${db:-main}"
}

# Integration branch a new branch is cut from: the harness.integrationBranch git config,
# else develop when origin has it, else the remote default branch. Bash-3 friendly.
integration_branch() {
  ib=$(git -C "$1" config --get harness.integrationBranch 2>/dev/null)
  if [ -z "$ib" ] && remote_has "$1" develop; then ib="develop"; fi
  [ -n "$ib" ] || ib=$(default_branch "$1")
  printf '%s' "$ib"
}

# hotfix/* branches start from production: main, or the remote default branch when origin has no main.
hotfix_base() {
  if remote_has "$1" main; then printf 'main'; else default_branch "$1"; fi
}

# branch -> slug: drop the prefix, turn / and _ into -
slug_of() {
  printf '%s' "$1" | sed -e 's|^[^/]*/||' -e 's|[/_]|-|g'
}

require_repo() {
  [ -n "$1" ] || die "no repo given"
  [ -d "$(repo_path "$1")/.git" ] || die "not a git repo: $(repo_path "$1")"
}

# Is this worktree's tree dirty? Prints porcelain output, empty when clean.
wt_dirty() {
  git -C "$1" status --porcelain 2>/dev/null
}

# Commits on the worktree's branch that are not on its remote counterpart.
# Prints the unpushed commits, or the literal string NO_REMOTE.
wt_unpushed() {
  wt="$1"
  br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null) || return 0
  [ "$br" = "HEAD" ] && { printf 'DETACHED'; return 0; }
  if git -C "$wt" rev-parse --verify --quiet "refs/remotes/origin/$br" >/dev/null 2>&1; then
    git -C "$wt" log --oneline "origin/$br..HEAD" 2>/dev/null
  else
    printf 'NO_REMOTE'
  fi
}

# GitHub deletes a PR's branch on merge, so NO_REMOTE alone cannot tell "never
# pushed" from "landed". HEAD equal to a merged PR's head commit proves every
# local commit reached GitHub. Prints "#<number>" on success, else the reason
# and returns 1. Any gh failure (missing, unauthenticated, offline) refuses.
wt_merged_pr() {
  wt="$1"
  br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null) || { printf 'cannot read branch'; return 1; }
  sha=$(git -C "$wt" rev-parse HEAD 2>/dev/null) || { printf 'cannot read HEAD'; return 1; }
  # git@github.com:org/repo.git and https://github.com/org/repo(.git) -> org/repo
  ghrepo=$(git -C "$wt" remote get-url origin 2>/dev/null | sed -e 's|\.git$||' -e 's|.*[:/]\([^/]*/[^/]*\)$|\1|')
  [ -n "$ghrepo" ] || { printf 'no origin remote'; return 1; }
  command -v gh >/dev/null 2>&1 || { printf 'gh not installed'; return 1; }
  out=$(gh pr list --repo "$ghrepo" --head "$br" --state merged --json number,headRefOid --limit 5 \
    --jq ".[] | select(.headRefOid == \"$sha\") | .number" 2>&1) \
    || { printf 'gh failed: %s' "$(printf '%s\n' "$out" | head -n 1)"; return 1; }
  # Keep only PR numbers, so a gh upgrade notice on stderr cannot pass as one.
  pr=$(printf '%s\n' "$out" | grep -E '^[0-9]+$' | head -n 1)
  [ -n "$pr" ] || { printf 'no merged PR for %s in %s has head %.12s' "$br" "$ghrepo" "$sha"; return 1; }
  printf '#%s' "$pr"
}

# --- CodeGraph (optional) --------------------------------------------------
# Only runs when `codegraph` is on PATH and the primary checkout has an index.
# A CodeGraph index describes the working tree it sits in, so a worktree needs
# its own or agents silently answer from the primary checkout's branch. Paths
# inside the DB are project-root-relative, so copying the primary index and
# running an incremental sync takes seconds where a full rebuild takes minutes.

# Some repos do not gitignore .codegraph/, and an untracked index would trip the
# dirty check in `remove`. info/exclude resolves to the primary checkout via
# --git-common-dir, so one write covers the whole repo.
codegraph_hide() {
  # Check the inner .gitignore, the one file codegraph un-ignores. A bare
  # ".codegraph" misses the dir-only ".codegraph/" rule before the dir exists
  # (one duplicate line per worktree), and ".codegraph/" matches codegraph's
  # own "*" once it does, while .codegraph/.gitignore stays untracked.
  git -C "$1" check-ignore -q .codegraph/.gitignore 2>/dev/null && return 0
  excl="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)/info/exclude"
  mkdir -p "$(dirname "$excl")" 2>/dev/null
  printf '.codegraph/\n' >> "$excl" 2>/dev/null \
    || warn "could not add .codegraph/ to $excl"
}

# Copy the primary checkout's index into the new worktree and sync it. Best effort.
codegraph_provision() {
  repo_dir="$1"; target="$2"
  src="$repo_dir/.codegraph"
  [ -f "$src/codegraph.db" ] || return 0
  command -v codegraph >/dev/null 2>&1 || return 0

  codegraph_hide "$target"

  mkdir -p "$target/.codegraph" || { warn "could not create $target/.codegraph"; return 0; }
  [ -f "$src/.gitignore" ] && cp "$src/.gitignore" "$target/.codegraph/.gitignore"

  # sqlite3's backup API is the only safe way to copy a live WAL database; a
  # plain cp of one mid-write tears. Fall back to cp of the db plus its
  # sidecars. Never copy daemon.pid/daemon.sock/daemon.log: a stale pid would
  # point the new tree's daemon at the primary checkout's process.
  if ! { command -v sqlite3 >/dev/null 2>&1 \
         && sqlite3 "$src/codegraph.db" ".backup '$target/.codegraph/codegraph.db'" 2>/dev/null; }; then
    if cp "$src/codegraph.db" "$target/.codegraph/codegraph.db" 2>/dev/null; then
      for side in -wal -shm; do
        [ -f "$src/codegraph.db$side" ] \
          && cp "$src/codegraph.db$side" "$target/.codegraph/codegraph.db$side"
      done
    else
      rm -rf "$target/.codegraph"
      warn "could not copy the CodeGraph index; build one by hand: codegraph init $target"
      return 0
    fi
  fi

  if codegraph sync -q "$target" >/dev/null 2>&1; then
    printf '  codegraph: index ready, query it with projectPath %s\n' "$target"
  else
    warn "CodeGraph index copied but sync failed; run: codegraph sync $target"
  fi
}

# Drop the worktree's index once removal is actually going ahead. Callers must
# have validated that $1 is under $WT_ROOT first.
codegraph_teardown() {
  target="${1:-}"
  # Belt and braces before an rm -rf: an empty arg would aim it at /.codegraph.
  [ -n "$target" ] || return 0
  [ -d "$target/.codegraph" ] || return 0

  # Stop the watcher first, or it is left holding a path that is about to go.
  # `codegraph daemon` is interactive-only, so there is nothing to script.
  if [ -f "$target/.codegraph/daemon.pid" ]; then
    pid=$(cat "$target/.codegraph/daemon.pid" 2>/dev/null)
    case "$pid" in
      ''|*[!0-9]*) : ;;
      *) kill "$pid" 2>/dev/null ;;
    esac
  fi

  # Never rm -rf a worktree; this deletes only the generated index inside it.
  # `codegraph uninit` does the same but can prompt.
  rm -rf "$target/.codegraph"
}

# new <repo> <branch>: cut <branch> from the repo's integration branch into its own worktree.
cmd_new() {
  repo_arg="${1:-}"; branch="${2:-}"
  require_repo "$repo_arg"
  repo_dir=$(repo_path "$repo_arg")
  repo=$(basename "$repo_dir")
  [ -n "$branch" ] || die "no branch given"

  prefix=$(printf '%s' "$branch" | sed -n 's|^\([^/][^/]*\)/.*|\1|p')
  [ -n "$prefix" ] || die "branch '$branch' must include a prefix and literal / separator"

  if [ "$prefix" = "hotfix" ]; then
    base=$(hotfix_base "$repo_dir")
  else
    base=$(integration_branch "$repo_dir")
  fi

  slug=$(slug_of "$branch")
  target="$WT_ROOT/$repo--$slug"
  [ -e "$target" ] && die "path already exists: $target"

  mkdir -p "$WT_ROOT"

  git -C "$repo_dir" fetch origin "refs/heads/$base:refs/remotes/origin/$base" --force >/dev/null 2>&1 \
    || warn "could not fetch origin/$base; basing on the local ref, verify it is current"

  if git -C "$repo_dir" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1; then
    printf 'branch %s already exists, checking it out in the new worktree\n' "$branch"
    git -C "$repo_dir" worktree add "$target" "$branch" || die "git worktree add failed"
  else
    # --no-track: never let a fresh topic branch track origin/<base>, or a stray
    # `git push` would target the integration branch directly.
    git -C "$repo_dir" worktree add --no-track -b "$branch" "$target" "origin/$base" \
      || die "git worktree add failed"
    # Belt and braces: some git versions still inherit tracking from the base ref
    # despite --no-track. Clear it explicitly.
    git -C "$target" branch --unset-upstream >/dev/null 2>&1 || true
  fi

  printf '\ncreated %s\n  repo:   %s\n  branch: %s (from origin/%s)\n' "$target" "$repo_dir" "$branch" "$base"
  codegraph_provision "$repo_dir" "$target"
  printf '  remove with: %s remove %s--%s\n' "$0" "$repo" "$slug"
}

# list: every worktree under WT_ROOT with its dirty / unpushed / age state.
cmd_list() {
  [ -d "$WT_ROOT" ] || { printf 'no %s yet\n' "$WT_ROOT"; return 0; }
  found=0
  for d in "$WT_ROOT"/*; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    found=1
    br=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '?')
    dirty=$(wt_dirty "$d")
    unpushed=$(wt_unpushed "$d")
    age=$(git -C "$d" log -1 --format='%ci' 2>/dev/null || printf 'unknown')

    state="clean"
    landed=""
    [ -n "$dirty" ] && state="DIRTY($(printf '%s' "$dirty" | wc -l | tr -d ' ') files)"
    case "$unpushed" in
      NO_REMOTE)
        if merged=$(wt_merged_pr "$d"); then
          landed=" (no remote branch; HEAD is merged PR $merged)"
        else
          state="$state, NEVER PUSHED"
        fi ;;
      DETACHED)  state="$state, DETACHED HEAD" ;;
      "")        : ;;
      *)         state="$state, $(printf '%s' "$unpushed" | wc -l | tr -d ' ') unpushed commit(s)" ;;
    esac

    printf '%s\n  branch:    %s\n  last commit: %s\n  state:     %s%s\n' "$name" "$br" "$age" "$state" "$landed"
    if [ "$state" = "clean" ]; then
      printf '  -> safe to remove: %s remove %s\n\n' "$0" "$name"
    else
      printf '  -> NOT removable as-is. Push or report first.\n\n'
    fi
  done
  [ "$found" = "0" ] && printf 'no worktrees under %s\n' "$WT_ROOT"
  return 0
}

# remove <name>: remove WT_ROOT/<name> only when it has no uncommitted or unpushed work.
cmd_remove() {
  name="${1:-}"
  [ -n "$name" ] || die "no worktree name given"

  case "$name" in
    */*|..*) die "pass a bare worktree name, not a path: $name" ;;
  esac

  target="$WT_ROOT/$name"
  [ -d "$target" ] || die "no such worktree: $target"

  # Owning repo: the <repo> part of <repo>--<slug> under WORKSPACE_ROOT. A repo that
  # `new` got by absolute path can live elsewhere, so fall back to the main worktree
  # git records for this one (always the first entry of `worktree list`).
  repo_dir="$WORKSPACE_ROOT/$(printf '%s' "$name" | sed 's|--.*||')"
  [ -d "$repo_dir/.git" ] \
    || repo_dir=$(git -C "$target" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
  [ -n "$repo_dir" ] && [ -d "$repo_dir/.git" ] || die "cannot resolve owning repo for $name"

  # An index provisioned outside this script may not be ignored yet, and it
  # must not be what trips the dirty check below. Hiding it is safe; deleting
  # it is not, because the checks may still refuse and leave the tree in use.
  [ -d "$target/.codegraph" ] && codegraph_hide "$target"

  dirty=$(wt_dirty "$target")
  if [ -n "$dirty" ]; then
    printf 'REFUSING to remove %s: uncommitted changes.\n\n%s\n\n' "$name" "$dirty" >&2
    printf 'Commit and push, or report this to the developer. Do not work around this refusal.\n' >&2
    exit 2
  fi

  unpushed=$(wt_unpushed "$target")
  case "$unpushed" in
    "") : ;;
    NO_REMOTE)
      # A clean tree whose HEAD is a merged PR's head has nothing left to lose.
      if merged=$(wt_merged_pr "$target"); then
        printf 'branch has no remote, but HEAD is merged PR %s: the work landed.\n' "$merged"
      else
        printf 'REFUSING to remove %s: its branch has no remote counterpart (never pushed).\n' "$name" >&2
        printf 'Push the branch, or report this to the developer.\n' >&2
        printf 'Merged-PR check did not clear it: %s\n' "$merged" >&2
        exit 2
      fi ;;
    DETACHED)
      printf 'REFUSING to remove %s: detached HEAD, cannot verify the work is saved.\n' "$name" >&2
      exit 2 ;;
    *)
      printf 'REFUSING to remove %s: commits not on the remote.\n\n%s\n\n' "$name" "$unpushed" >&2
      printf 'Push them, or report this to the developer.\n' >&2
      exit 2 ;;
  esac

  # Only now that both safety checks have passed is the index expendable.
  codegraph_teardown "$target"

  git -C "$repo_dir" worktree remove "$target" || die "git worktree remove failed for $target"
  git -C "$repo_dir" worktree prune
  printf 'removed %s (branch kept: removing a worktree never deletes its branch)\n' "$name"
}

case "${1:-}" in
  new)    shift; cmd_new "$@" ;;
  list)   shift; cmd_list "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage; exit 1 ;;
esac
