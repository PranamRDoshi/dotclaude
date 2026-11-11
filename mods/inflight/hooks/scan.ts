/** Worktree scan: pure helpers for the options, local git facts, GitHub PR facts and the removal verdict of each worktree row. */
import type { CiState, Pr, ReviewState, Row } from './types'

export const PR_FIELDS = 'number,title,state,isDraft,baseRefName,headRefName,headRefOid,url,updatedAt,statusCheckRollup'
export const PR_PAGE = 100
export const GH_TIMEOUT_MS = 20_000
// Conclusions that fail a check; SKIPPED and NEUTRAL CI runs count as passing.
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

// A row before its verdict.
export type Bare = Omit<Row, 'verdict' | 'reason'>
// One repo's GitHub answer: branch -> PR, and branch -> the gh failure that left it unanswered.
export type RepoPrs = { prs: Map<string, Pr>; errors: Map<string, string> }

export type RollupEntry = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

export type GhPr = {
  number: number
  title: string
  state: Pr['state']
  isDraft: boolean
  baseRefName: string
  headRefName: string
  headRefOid: string
  url: string
  statusCheckRollup?: RollupEntry[] | null
}

/** A leading ~ as HOME, so an option can name a path the way a shell would. */
export function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
}

/** The linked worktrees in `git worktree list --porcelain` output; the first entry is the main worktree, so it is left out. */
export function linkedWorktrees(porcelain: string): string[] {
  return porcelain.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length)).slice(1)
}

/**
 * The Remove button's argv: the command split on whitespace, then {path} and {name} filled in per token, so a path
 * with spaces stays one argument; a leading ~ on the program expands. No shell runs it.
 */
export function removeArgv(command: string, row: Pick<Row, 'path' | 'name'>, home: string): string[] {
  const argv = command.trim().split(/\s+/).map(token => token.replaceAll('{path}', row.path).replaceAll('{name}', row.name))
  argv[0] = expandHome(argv[0] ?? '', home)
  return argv
}

/** The Bash commands that trigger a rescan: git push, git worktree, or the remove command's program. */
export function rescanPattern(removeCommand: string): RegExp {
  // With or without global options before the verb (git -C <dir> push).
  const git = String.raw`\bgit\b[^|;&]*\b(push|worktree)\b`
  const program = removeCommand.trim().split(/\s+/)[0]?.split('/').pop() ?? ''
  // A program named git is covered above; matching bare git would rescan after every git call.
  if (!program || program === 'git') return new RegExp(git)
  // ponytail: substring match, so a short program name also fires inside longer words; a false hit costs one debounced rescan.
  return new RegExp(`${git}|${program.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
}

/**
 * Folds a PR's statusCheckRollup into one CI state and one review state. Only the check named `reviewCheck` feeds
 * the review state; with no name configured every check counts toward CI and the review state stays none.
 */
export function rollup(entries: readonly RollupEntry[], reviewCheck: string): { ci: CiState; review: ReviewState } {
  let review: ReviewState = 'none'
  let ci: CiState = 'none'
  for (const entry of entries) {
    // A StatusContext has state only; a CheckRun has status plus a conclusion once COMPLETED.
    const isContext = entry.__typename === 'StatusContext'
    const result = (isContext ? entry.state : entry.conclusion) ?? ''
    const isDone = isContext ? result !== 'PENDING' && result !== 'EXPECTED' : entry.status === 'COMPLETED'
    if (reviewCheck && (entry.name ?? entry.context) === reviewCheck) {
      // NEUTRAL means the review ran but reached no result, so errored; ACTION_REQUIRED and the rest are findings.
      review = !isDone ? 'running' : result === 'SUCCESS' ? 'pass' : result === 'NEUTRAL' ? 'errored' : 'fail'
      continue
    }
    if (isDone && FAILED.includes(result)) ci = 'fail'
    else if (!isDone && ci !== 'fail') ci = 'pending'
    else if (ci === 'none') ci = 'pass'
  }
  return { ci, review }
}

/** Picks the PR that speaks for a branch: the OPEN one, else the highest number. */
export function pickPr(prs: readonly GhPr[]): GhPr | undefined {
  return prs.find(pr => pr.state === 'OPEN') ?? [...prs].sort((a, b) => b.number - a.number)[0]
}

/** Maps gh's PR record to the row's Pr. */
export function toPr(raw: GhPr, reviewCheck: string): Pr {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    isDraft: raw.isDraft,
    base: raw.baseRefName,
    url: raw.url,
    headOid: raw.headRefOid,
    ...rollup(raw.statusCheckRollup ?? [], reviewCheck),
  }
}

/**
 * Decides keep/remove/unknown for one row; first match wins. Anything not provably on GitHub keeps the tree.
 * `hasReview` adds the review state to an open PR's reason, only when a review check is configured.
 */
export function verdict(row: Bare, ghError?: string, hasReview = false): Pick<Row, 'verdict' | 'reason'> {
  const { pr, unpushed } = row
  if (row.skipped) return { verdict: 'keep', reason: 'skipped' }
  if (row.error) return { verdict: 'unknown', reason: row.error }
  if (unpushed === 'DETACHED') return { verdict: 'keep', reason: 'detached HEAD' }
  if (row.dirty > 0) return { verdict: 'keep', reason: `${row.dirty} uncommitted` }
  if (typeof unpushed === 'number' && unpushed > 0) return { verdict: 'keep', reason: `${unpushed} unpushed` }
  if (ghError) return { verdict: 'unknown', reason: ghError }
  if (unpushed === 'NO_REMOTE') {
    if (!pr) return { verdict: 'keep', reason: 'never pushed' }
    // HEAD equal to the merged PR's head proves the work is on GitHub even though its remote branch is gone.
    if (pr.state === 'MERGED' && pr.headOid === row.head) {
      return { verdict: 'remove', reason: 'merged, remote branch deleted' }
    }
    return { verdict: 'keep', reason: `PR #${pr.number} ${pr.state.toLowerCase()}, no remote branch` }
  }
  if (!pr) return { verdict: 'keep', reason: 'no PR' }
  if (pr.state === 'OPEN') return { verdict: 'keep', reason: `ci ${pr.ci}${hasReview ? `, review ${pr.review}` : ''}` }
  return { verdict: 'remove', reason: `PR #${pr.number} ${pr.state.toLowerCase()}, clean, pushed` }
}

/** Sets a row's repo and the slug it implies: the folder name without a leading `<repo>--`, else the whole name. */
export function withRepo(row: Bare, repo: string): Bare {
  return { ...row, repo, slug: row.name.startsWith(`${repo}--`) ? row.name.slice(repo.length + 2) : row.name }
}

/** A worktree folder's row skeleton; a `<repo>--` name prefix in skipRepos marks it skipped before any git call. */
export function baseRow(path: string, skipRepos: readonly string[]): Bare {
  const name = path.split('/').pop() ?? path
  const skipped = skipRepos.find(repo => name.startsWith(`${repo}--`))
  const row: Bare = {
    name, repo: '', slug: name, path, mainRepo: '', skipped: skipped !== undefined,
    branch: null, head: '', dirty: 0, unpushed: 0, lastCommitAt: '',
  }
  return skipped ? withRepo(row, skipped) : row
}

/** Joins local rows with their main repo's PR answers and decides each verdict. */
export function assemble(local: readonly Bare[], byRepo: ReadonlyMap<string, RepoPrs>, hasReview: boolean): { rows: Row[]; ghError?: string } {
  const rows = local.map(row => {
    const found = byRepo.get(row.mainRepo)
    const branch = row.branch ?? ''
    const withPr = { ...row, pr: found?.prs.get(branch) }
    return { ...withPr, ...verdict(withPr, found?.errors.get(branch), hasReview) }
  })
  const ghError = [...byRepo.values()].flatMap(result => [...result.errors.values()])[0]
  return ghError ? { rows, ghError } : { rows }
}
