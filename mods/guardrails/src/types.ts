/** Shared shapes between the Bash parser (bash.ts), the git classifier (git.ts) and the rules (rules.ts). */

/** One simple command out of a Bash string, after wrappers and env assignments are stripped. */
export type Segment = {
  /** Command words with quotes removed. `~`, `$HOME` and `${HOME}` are expanded; any other `$...` or backtick stays as raw text. */
  argv: string[]
  /** Effective working directory (cd tracked, `git -C` applied); null when it cannot be known statically. */
  cwd: string | null
  /** Reconstructed text of the segment before wrapper stripping, for deny summaries. */
  raw: string
  /** Output redirect targets (`>`, `>>`, `>|`, `&>`) as written, not in argv. Resolve with resolvePath(seg.cwd, r). */
  redirects: string[]
}

/** What a git segment would do. */
export type GitIntent = {
  /** 'commit' means commit-creating: commit (incl. --amend), merge, pull, rebase, cherry-pick, revert, am. */
  kind: 'read' | 'commit' | 'push' | 'branch-create' | 'branch-delete' | 'checkout' | 'other-write'
  /** Directory git runs in (cwd after -C), not necessarily the repo root; null when unknown or --git-dir/--work-tree is used. */
  repoDir: string | null
  /** Branch names, `refs/heads/` stripped. 'HEAD' means the current branch (resolve it), '*' means every branch (push --all/--mirror). */
  targets: string[]
  isForce: boolean
  isFfOnly: boolean
  /** The git subcommand as typed ('' for bare `git`), so rules can match exact verbs. */
  sub: string
  /** True for a push that deletes remote branches (`--delete`, `-d`, `:branch`). Stays kind 'push' so the protected-branch push rule sees it. */
  isDelete: boolean
}
