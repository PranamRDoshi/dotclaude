/** Git intent classifier: what one Bash segment's git call would do to a repo (read, commit, push, branch create/delete, checkout, other write). */
import { splitGit } from './bash'
import type { GitIntent, Segment } from './types'

type Verdict = Partial<GitIntent> & Pick<GitIntent, 'kind'>

// Subcommands that never change refs, index or work tree. fetch counts as a read: it only moves remote-tracking refs.
const READS = new Set([
  'status', 'log', 'diff', 'show', 'fetch', 'rev-parse', 'rev-list', 'ls-files', 'ls-remote', 'ls-tree', 'cat-file',
  'describe', 'blame', 'annotate', 'grep', 'shortlog', 'merge-base', 'for-each-ref', 'name-rev', 'check-ignore',
  'check-attr', 'diff-tree', 'diff-index', 'diff-files', 'whatchanged', 'count-objects', 'help', 'version', 'var',
  'cherry', 'range-diff', 'show-ref', 'show-branch', 'fsck', 'verify-commit', 'verify-tag',
])
// Subcommands that are reads only when their first arg is one of these ('' = no args).
const READ_FIRST = new Map([
  ['stash', ['list', 'show']],
  ['remote', ['', '-v', '--verbose', 'show', 'get-url']],
  ['reflog', ['', 'show']],
  ['submodule', ['', 'status']],
  ['notes', ['', 'list', 'show']],
  ['worktree', ['list']],
])
const COMMIT_SUBS = new Set(['commit', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am'])
const TAG_READ = /^(-l|--list|-n\d*|-v|--verify|--(no-)?contains|--points-at|--(no-)?merged)(=|$)|^--(sort|format|column)/
const CONFIG_WRITE = /^(--(unset|unset-all|add|replace-all|rename-section|remove-section|edit)|-e)$/
const CONFIG_READ = /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list)$/
const CONFIG_VALUE = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment'])
const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const BRANCH_LIST = new Set(['--list', '--all', '--remotes', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'])
const BRANCH_VALUE = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--set-upstream-to'])
const BRANCH_OTHER = new Set(['--set-upstream-to', '--unset-upstream', '--edit-description'])

/** Classifies a segment's git invocation; null when the segment is not git. Unknown subcommands are 'other-write' (fail closed). */
export function gitIntent(seg: Segment): GitIntent | null {
  const g = splitGit(seg.argv)
  if (!g) return null
  const base: GitIntent = { kind: 'read', repoDir: g.customRepo ? null : seg.cwd, targets: [], isForce: false, isFfOnly: false, sub: g.sub ?? '', isDelete: false }
  return { ...base, ...classify(g.sub, g.args) }
}

/** Maps a git subcommand and its args to a verdict. */
function classify(sub: string | null, args: string[]): Verdict {
  if (sub === null || READS.has(sub)) return { kind: 'read' }
  if (COMMIT_SUBS.has(sub)) {
    // --abort/--quit unwind an operation without creating a commit.
    if (args.includes('--abort') || args.includes('--quit')) return { kind: 'other-write' }
    return { kind: 'commit', isFfOnly: args.includes('--ff-only') }
  }
  if (sub === 'push') return push(args)
  if (sub === 'branch') return branch(args)
  if (sub === 'checkout') return checkout(args)
  if (sub === 'switch') return switchTo(args)
  if (sub === 'worktree' && args[0] === 'add') return worktreeAdd(args.slice(1))
  if (sub === 'tag') return { kind: !args.length || args.some((a) => TAG_READ.test(a)) ? 'read' : 'other-write' }
  if (sub === 'config') return { kind: configIsRead(args) ? 'read' : 'other-write' }
  if (sub === 'symbolic-ref') return { kind: args.filter((a) => !a.startsWith('-')).length < 2 && !args.some((a) => a === '-d' || a === '--delete') ? 'read' : 'other-write' }
  const reads = READ_FIRST.get(sub)
  return { kind: reads?.includes(args[0] ?? '') ? 'read' : 'other-write' }
}

/** `git config`: read for --get/--list/get/list or a single key, write otherwise. */
function configIsRead(args: string[]): boolean {
  if (args.some((a) => CONFIG_WRITE.test(a))) return false
  if (args.some((a) => CONFIG_READ.test(a))) return true
  const pos: string[] = []
  for (let k = 0; k < args.length; k++) {
    if (CONFIG_VALUE.has(args[k])) k++
    else if (!args[k].startsWith('-')) pos.push(args[k])
  }
  return pos[0] === 'get' || pos[0] === 'list' || pos.length === 1
}

/** `git push`: targets from refspecs (dst side), --delete names, 'HEAD' when no refspec, '*' for --all/--mirror. */
function push(args: string[]): Verdict {
  const pos: string[] = []
  let isForce = false
  let isDelete = false
  let all = false
  let tagsOnly = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--') {
      pos.push(...args.slice(k + 1))
      break
    }
    if (/^--force(-with-lease|-if-includes)?(=|$)/.test(a)) isForce = true
    else if (a === '--delete') isDelete = true
    else if (a === '--all' || a === '--mirror' || a === '--branches') all = true
    else if (a === '--tags') tagsOnly = true
    else if (PUSH_VALUE.has(a)) k++
    else if (/^-[^-]/.test(a)) {
      if (a.includes('f')) isForce = true
      if (a.includes('d')) isDelete = true
      if (a.endsWith('o')) k++
    } else if (!a.startsWith('-')) pos.push(a)
  }
  const targets: string[] = all ? ['*'] : []
  // pos[0] is the remote; the rest are refspecs like `+src:dst`, `:dst`, `HEAD:dst` or a bare name.
  for (let r of pos.slice(1)) {
    if (r.startsWith('+')) {
      isForce = true
      r = r.slice(1)
    }
    const colon = r.indexOf(':')
    if (colon === 0) isDelete = true
    const dst = colon >= 0 && colon < r.length - 1 ? r.slice(colon + 1) : r.slice(0, colon >= 0 ? colon : undefined)
    targets.push(dst)
  }
  if (!targets.length && !tagsOnly) targets.push('HEAD')
  return { kind: 'push', targets: targets.map(branchName), isForce, isDelete }
}

/** `git branch`: delete, rename (old name is removed), copy/create, upstream edits, or a listing. */
function branch(args: string[]): Verdict {
  let mode: 'create' | 'delete' | 'move' | 'copy' | 'other' = 'create'
  let isForce = false
  let listy = false
  const pos: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a.startsWith('--')) {
      const n = a.split('=')[0]
      if (n === '--delete') mode = 'delete'
      else if (n === '--move') mode = 'move'
      else if (n === '--copy') mode = 'copy'
      else if (n === '--force') isForce = true
      else if (BRANCH_OTHER.has(n)) mode = 'other'
      else if (BRANCH_LIST.has(n)) listy = true
      if (BRANCH_VALUE.has(n) && !a.includes('=')) k++
    } else if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (ch === 'd' || ch === 'D') mode = 'delete'
        else if (ch === 'm' || ch === 'M') mode = 'move'
        else if (ch === 'c' || ch === 'C') mode = 'copy'
        else if (ch === 'u') mode = 'other'
        else if ('lavr'.includes(ch)) listy = true
        if ('DMCf'.includes(ch)) isForce = true
      }
      if (a.endsWith('u')) k++
    } else pos.push(a)
  }
  if (mode === 'delete') return { kind: 'branch-delete', targets: pos, isForce }
  // ponytail: a rename reports only the removed old name; 'HEAD' when renaming the current branch.
  if (mode === 'move') return { kind: 'branch-delete', targets: [pos.length > 1 ? pos[0] : 'HEAD'], isForce }
  if (mode === 'copy') return { kind: 'branch-create', targets: pos.slice(-1), isForce }
  if (mode === 'other') return { kind: 'other-write' }
  if (listy || !pos.length) return { kind: 'read' }
  return { kind: 'branch-create', targets: [pos[0]], isForce }
}

/** `git checkout`: -b/-B/--orphan create, one positional switches, paths (`--`, -p, several args) are a work-tree write. */
function checkout(args: string[]): Verdict {
  const pos: string[] = []
  let create: string | null = null
  let paths = false
  let isForce = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--') {
      paths = true
      break
    }
    if (a === '-b' || a === '-B' || a === '--orphan') create = args[++k] ?? ''
    else if (a === '-p' || a === '--patch' || a.startsWith('--pathspec-from-file')) paths = true
    else if (!a.startsWith('-') || a === '-') pos.push(a)
    if (a === '-B' || a === '-f' || a === '--force') isForce = true
  }
  if (create !== null) return { kind: 'branch-create', targets: [create], isForce }
  if (paths || pos.length > 1) return { kind: 'other-write', isForce }
  return pos.length ? { kind: 'checkout', targets: pos, isForce } : { kind: 'read' }
}

/** `git switch`: -c/-C/--orphan create, otherwise a switch to the named branch. */
function switchTo(args: string[]): Verdict {
  const pos: string[] = []
  let create: string | null = null
  let isForce = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (['-c', '-C', '--create', '--force-create', '--orphan'].includes(a)) create = args[++k] ?? ''
    else if (/^--(create|force-create|orphan)=/.test(a)) create = a.slice(a.indexOf('=') + 1)
    else if (!a.startsWith('-') || a === '-') pos.push(a)
    if (['-C', '--force-create', '-f', '--force', '--discard-changes'].includes(a)) isForce = true
  }
  if (create !== null) return { kind: 'branch-create', targets: [create], isForce }
  return pos.length ? { kind: 'checkout', targets: [pos[0]], isForce } : { kind: 'read' }
}

/** `git worktree add`: -b/-B create; else the commit-ish is checked out; with neither, git creates a branch named after the path. */
function worktreeAdd(args: string[]): Verdict {
  const pos: string[] = []
  let create: string | null = null
  let detach = false
  let isForce = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-b' || a === '-B') create = args[++k] ?? ''
    else if (a === '--reason') k++
    else if (a === '-d' || a === '--detach') detach = true
    else if (!a.startsWith('-')) pos.push(a)
    if (a === '-B' || a === '-f' || a === '--force') isForce = true
  }
  if (create !== null) return { kind: 'branch-create', targets: [create], isForce }
  if (pos[1]) return { kind: 'checkout', targets: [pos[1]], isForce }
  if (detach) return { kind: 'checkout', targets: ['HEAD'], isForce }
  if (pos[0]) return { kind: 'branch-create', targets: [pos[0].replace(/\/+$/, '').split('/').pop() ?? ''], isForce }
  return { kind: 'other-write' }
}

/** Normalizes a ref to a branch name: strips refs/heads/, maps `@` to HEAD. */
function branchName(ref: string): string {
  const r = ref.replace(/^refs\/heads\//, '')
  return r === '@' ? 'HEAD' : r
}
