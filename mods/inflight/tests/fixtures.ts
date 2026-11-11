/** Saved `gh pr list --json` shapes (titles, URLs and oids replaced) and fake worktrees of two repos, api and web. */
import type { GhPr, RollupEntry } from '../hooks/scan'

// The review check the tests configure, and where the fake main repositories live.
export const REVIEW = 'bot/review'
export const SRC = '/src'

/** A completed CheckRun with the given name and conclusion, as gh prints it. */
export const run = (name: string, conclusion: string): RollupEntry => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion })

/** A CheckRun still going, conclusion empty as gh prints it. */
export const running = (name: string): RollupEntry => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: '' })

/** One gh PR record with sane defaults. */
export const pr = (number: number, headRefName: string, extra: Partial<GhPr> = {}): GhPr => ({
  number,
  title: `PR ${number}`,
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'develop',
  headRefName,
  headRefOid: `oid${number}`,
  url: `https://github.com/example/repo/pull/${number}`,
  statusCheckRollup: [run('test', 'SUCCESS')],
  ...extra,
})

// One page for every repo: a merged PR whose remote branch is gone, a stacked open PR with the review running, an older closed one.
export const page: GhPr[] = [
  pr(683, 'fix/merged-gone', { state: 'MERGED', headRefOid: 'oidMergedHead' }),
  pr(710, 'feat/open-stacked', { baseRefName: 'feat/base', statusCheckRollup: [run('test', 'SUCCESS'), running(REVIEW)] }),
  pr(600, 'feat/open-stacked', { state: 'CLOSED' }),
]

// Local git facts per worktree, keyed by folder name; repo: the main repo git reports; remote: whether origin/<branch> exists.
export type FakeGit = { repo: string; branch: string; head: string; porcelain: string; remote: boolean; ahead?: number }

export const worktrees: Record<string, FakeGit> = {
  'api--merged-gone': { repo: 'api', branch: 'fix/merged-gone', head: 'oidMergedHead', porcelain: '', remote: false },
  'api--open-stacked': { repo: 'api', branch: 'feat/open-stacked', head: 'oid710', porcelain: '', remote: true, ahead: 0 },
  'web--dirty-work': { repo: 'web', branch: 'feature/dirty-work', head: 'oidDirty', porcelain: ' M a.py', remote: false },
  // A skipped repo whose folder name has no prefix: only git can name it.
  handbook: { repo: 'docs', branch: 'main', head: 'oidDocs', porcelain: '', remote: true },
}

// Skipped by its name prefix, so it must never reach git or gh; and a folder that is not a git worktree.
export const prefixSkipped = 'ops--rollback'
export const strayDir = 'scratch'
