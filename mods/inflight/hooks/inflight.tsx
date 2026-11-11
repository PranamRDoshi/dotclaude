/**
 * Inflight mod: draws the MCP status above the timeline pane's milestones and the git worktree list below them.
 * Rescans worktrees every 5 minutes and after git push, git worktree or the remove command runs in Bash, MCP every
 * minute; /inflight rescans both; Remove runs the configured remove command.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { classify, configuredServers } from './mcp'
import { mcpTree, paneTree } from './render'
import {
  GH_TIMEOUT_MS, PR_FIELDS, PR_PAGE, assemble, baseRow, expandHome, linkedWorktrees, pickPr, removeArgv, rescanPattern,
  toPr, withRepo,
} from './scan'
import type { Bare, GhPr, RepoPrs } from './scan'
import type { McpStatus, Pr, Row, Scan } from './types'

type Dollar = EngineInterface

// The list sits under the timeline mod's pane. The engine shows one plugin pane at a time, the rest as tabs,
// so a pane of our own could never sit below it.
const TIMELINE_PANE = 'timeline'
const REFRESH_MS = 5 * 60_000
// A burst of Bash calls (push, then a remove) settles into one scan this long after the last.
const DEBOUNCE_MS = 3_000
const MAX_STORED_ROWS = 200
// A new store key: the earlier one holds rows in the old shape, which this version leaves unread.
const STORE_KEY = 'worktrees'
// A remove command can run cleanup of its own, which can outlast the 30 s default.
const REMOVE_TIMEOUT_MS = 60_000
const MCP_REFRESH_MS = 60_000
// Servers are still connecting right after start, so the first check waits instead of flagging them down.
const MCP_FIRST_CHECK_MS = 10_000

const scan = atom({ plugin: 'inflight', key: 'worktrees' } as const, { status: 'idle', scannedAt: 0, rows: [] })
const mcp = atom({ plugin: 'inflight', key: 'mcp' } as const, { checkedAt: 0, servers: [] } as McpStatus)

// The userConfig options; register sets them, and a change in /config reloads the module with the new ones.
let cfg = { worktreesRoot: '', removeCommand: '', skipRepos: [] as string[], reviewCheck: '', rescanAfter: rescanPattern('') }

// Timers and the in-flight scan are per module load; a hot reload drops them and session.start re-arms.
let timer: Timer | undefined
let debounce: Timer | undefined
let inFlight: Promise<void> | undefined
let mcpTimer: Timer | undefined
// Worktrees whose removal is running, so a second press cannot race the first.
const removing = new Set<string>()

/** Runs one git command in a folder without taking optional locks; null when it fails. */
async function git($: Dollar, path: string, args: string[]): Promise<string | null> {
  try {
    const ran = await $.process.run(['git', '-C', path, '--no-optional-locks', ...args])
    return ran.exitCode === 0 ? ran.stdout.trim() : null
  } catch {
    return null
  }
}

type Local = Pick<Row, 'branch' | 'head' | 'dirty' | 'unpushed' | 'lastCommitAt' | 'error'>

/** Reads a worktree's local git facts: branch, HEAD, uncommitted files and commits not on origin. No fetch. */
async function readGit($: Dollar, path: string): Promise<Local> {
  const [abbrev, head, status, lastCommitAt] = await Promise.all([
    git($, path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, path, ['rev-parse', 'HEAD']),
    git($, path, ['status', '--porcelain']),
    git($, path, ['log', '-1', '--format=%ci']),
  ])
  const base = { head: head ?? '', dirty: 0, lastCommitAt: lastCommitAt ?? '' }
  if (abbrev === null || status === null) return { ...base, branch: null, unpushed: 0, error: 'git read failed' }
  const dirty = status === '' ? 0 : status.split('\n').length
  if (abbrev === 'HEAD') return { ...base, dirty, branch: null, unpushed: 'DETACHED' }
  const hasRemote = (await git($, path, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${abbrev}`])) !== null
  if (!hasRemote) return { ...base, dirty, branch: abbrev, unpushed: 'NO_REMOTE' }
  const ahead = await git($, path, ['rev-list', '--count', `origin/${abbrev}..HEAD`])
  return { ...base, dirty, branch: abbrev, unpushed: Number(ahead ?? 0) }
}

/**
 * The worktree folders to scan and what the pane says when there are none: the child folders of worktreesRoot when
 * it is set, else the linked worktrees of the repo the session runs in.
 */
async function worktreePaths($: Dollar, home: string): Promise<{ paths: string[]; emptyText: string }> {
  if (cfg.worktreesRoot) {
    const root = expandHome(cfg.worktreesRoot, home)
    const dirs = (await $.fs.list(root)).filter(entry => entry.kind === 'dir')
    return { paths: dirs.map(({ name }) => `${root}/${name}`), emptyText: `No worktrees under ${root}.` }
  }
  const cwd = await $.session.cwd()
  const listed = await git($, cwd, ['worktree', 'list', '--porcelain'])
  if (listed === null) return { paths: [], emptyText: `${cwd} is not in a git repository.` }
  return { paths: linkedWorktrees(listed), emptyText: `No linked worktrees in ${cwd}.` }
}

/** One worktree's local row: skipped repos stop at their name, a folder git does not know stops at its error. */
async function readRow($: Dollar, path: string): Promise<Bare> {
  const row = baseRow(path, cfg.skipRepos)
  // A skipRepos name prefix stops here, before any git call.
  if (row.skipped) return row
  // The repo comes from git, not the folder name: the common dir is <main repo>/.git for every linked worktree.
  const common = await git($, path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common === null) return { ...row, error: 'unrecognised: not a git worktree' }
  const mainRepo = common.replace(/\/\.git\/?$/, '')
  const named = { ...withRepo(row, mainRepo.split('/').pop() ?? ''), mainRepo }
  // git has named a skipped repo: no further git and no gh for this row.
  if (cfg.skipRepos.includes(named.repo)) return { ...named, skipped: true }
  return { ...named, ...(await readGit($, path)) }
}

/** Runs one `gh pr list` in a worktree; the PRs, or the first stderr line when gh fails. */
async function ghPrList($: Dollar, cwd: string, extra: string[]): Promise<{ prs: GhPr[] } | { error: string }> {
  try {
    const argv = ['gh', 'pr', 'list', '--state', 'all', ...extra, '--json', PR_FIELDS]
    const ran = await $.process.run(argv, { cwd, timeoutMs: GH_TIMEOUT_MS })
    if (ran.exitCode !== 0) return { error: ran.stderr.split('\n').find(line => line.trim()) ?? `gh exited ${ran.exitCode}` }
    return { prs: JSON.parse(ran.stdout) as GhPr[] }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Finds each branch's PR for one repo: one batched page, then a per-branch call for branches not on it. */
async function readPrs($: Dollar, rows: readonly Bare[]): Promise<RepoPrs> {
  const prs = new Map<string, Pr>()
  const errors = new Map<string, string>() // branch -> the gh failure that left it without an answer
  const branches = rows.filter(row => row.branch && !row.skipped && !row.error).map(row => ({ branch: row.branch as string, path: row.path }))
  const first = branches[0]
  if (!first) return { prs, errors }
  // cwd is a worktree of the repo so gh resolves the owner/repo slug itself.
  const page = await ghPrList($, first.path, ['--limit', String(PR_PAGE)])
  if ('error' in page) {
    for (const { branch } of branches) errors.set(branch, page.error)
    return { prs, errors }
  }
  const byBranch = new Map<string, GhPr[]>()
  for (const pr of page.prs) byBranch.set(pr.headRefName, [...(byBranch.get(pr.headRefName) ?? []), pr])
  await Promise.all(
    branches.map(async ({ branch, path }) => {
      let found = byBranch.get(branch) ?? []
      // A short page holds every PR the repo has, so a miss there is a real "no PR".
      if (found.length === 0 && page.prs.length >= PR_PAGE) {
        const one = await ghPrList($, path, ['--head', branch, '--limit', '1'])
        if ('error' in one) errors.set(branch, one.error)
        else found = one.prs
      }
      const picked = pickPr(found)
      if (picked) prs.set(branch, toPr(picked, cfg.reviewCheck))
    }),
  )
  return { prs, errors }
}

/** Scans everything: local pass over all rows, then one GitHub pass per main repo, then verdicts. */
async function collect($: Dollar, home: string) {
  const { paths, emptyText } = await worktreePaths($, home)
  const local = await Promise.all(paths.map(path => readRow($, path)))
  // Grouped by main repo folder, not name, so two clones that share a name never share a gh answer.
  const repos = [...new Set(local.filter(row => !row.skipped && !row.error).map(row => row.mainRepo))]
  const results = await Promise.all(repos.map(repo => readPrs($, local.filter(row => row.mainRepo === repo))))
  return { ...assemble(local, new Map(repos.map((repo, i) => [repo, results[i]!])), cfg.reviewCheck !== ''), emptyText }
}

/** One scan into the atom and the store; failures leave the last rows and say so. */
async function scanOnce($: Dollar) {
  await update($, scan, prev => ({ ...prev, status: 'scanning' as const }))
  try {
    const { rows, ghError, emptyText } = await collect($, (await $.env.get('HOME')) ?? '')
    const done: Scan = { status: 'ok', scannedAt: await $.clock.now(), rows: rows.slice(0, MAX_STORED_ROWS), emptyText }
    if (ghError) done.ghError = ghError
    await update($, scan, () => done)
    await $.store.set(STORE_KEY, done)
  } catch (err) {
    await update($, scan, prev => ({ ...prev, status: 'error' as const }))
    $.ui.toast(`inflight: scan failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Starts a scan, or joins the one already running so two triggers never race. */
function runScan($: Dollar) {
  inFlight ??= scanOnce($).finally(() => (inFlight = undefined))
  return inFlight
}

/** A file's text, or undefined when it is missing or unreadable. */
async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/** One MCP check: the servers behind the context's MCP tools against the configured ones; a failure keeps the last list and says so. */
async function checkMcp($: Dollar) {
  try {
    // summary: counted locally, no token-count requests; it lists deferred tools too, which $.tool.list may not.
    const [usage, home, cwd] = await Promise.all([$.session.usage({ breakdown: 'summary' }), $.env.get('HOME'), $.session.cwd()])
    const tools = usage.context.breakdown?.mcpTools
    if (!tools) throw new Error('no context breakdown')
    const [claudeJson, mcpJson] = await Promise.all([readText($, `${home ?? ''}/.claude.json`), readText($, `${cwd}/.mcp.json`)])
    const servers = classify(tools, configuredServers(claudeJson, mcpJson, cwd))
    const checkedAt = await $.clock.now()
    await update($, mcp, () => ({ checkedAt, servers }))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, mcp, prev => ({ ...prev, error }))
  }
}

/** Remove button: runs the remove command from the mod itself, no agent turn, toasts its answer, then rescans. */
async function removeWorktree($: Dollar, row: Row) {
  if (removing.has(row.name)) return
  removing.add(row.name)
  try {
    const argv = removeArgv(cfg.removeCommand, row, (await $.env.get('HOME')) ?? '')
    // From the main repo, so a command like git worktree remove acts on the right repository.
    const ran = await $.process.run(argv, { cwd: row.mainRepo, timeoutMs: REMOVE_TIMEOUT_MS })
    const ok = ran.exitCode === 0
    const lines = (ok ? ran.stdout : ran.stderr).split('\n').filter(line => line.trim())
    // Success shows the last stdout line, a refusal the first stderr line; git worktree remove prints nothing on success.
    $.ui.toast(`inflight: ${(ok ? lines.at(-1) : lines[0]) ?? (ok ? `removed ${row.name}` : `${argv[0]} exited ${ran.exitCode}`)}`)
  } catch (err) {
    $.ui.toast(`inflight: remove failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    removing.delete(row.name)
  }
  // A scan that began before the removal still lists the tree, so wait it out and scan fresh.
  await inFlight
  await runScan($)
}

/** Reads the options, then hooks session start, /inflight, the timeline pane's drawing and Bash calls. */
export const register: Register = (on, options) => {
  const text = (key: string) => String(options[key] ?? '').trim()
  // An unset or blanked option falls back to plain git, so the Remove button never runs an empty command.
  const removeCommand = text('removeCommand') || 'git worktree remove {path}'
  cfg = {
    worktreesRoot: text('worktreesRoot'),
    removeCommand,
    skipRepos: text('skipRepos').split(',').map(repo => repo.trim()).filter(Boolean),
    reviewCheck: text('reviewCheck'),
    rescanAfter: rescanPattern(removeCommand),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'inflight', description: 'Rescan worktrees and MCP status and open the timeline pane they sit in' })
    // Restore the last scan so the list shows "scanned HH:MM" data before the new scan lands.
    const stored = (await $.store.get(STORE_KEY)) as Scan | undefined
    if (stored && (await read($, scan)).status === 'idle') await update($, scan, () => stored)
    const result = await next(e)
    // The list is always on screen now, so scan for the whole session; never in a -p run, which draws nothing.
    // session.start runs again on a hot reload, which is when the module's timer was dropped.
    if (e.isInteractive) {
      void runScan($)
      timer ??= $.clock.every(REFRESH_MS, () => void runScan($))
      $.clock.after(MCP_FIRST_CHECK_MS, () => void checkMcp($))
      mcpTimer ??= $.clock.every(MCP_REFRESH_MS, () => void checkMcp($))
    }
    return result
  })

  on('command.run', { command: 'inflight' }, async $ => {
    void runScan($)
    void checkMcp($)
    // Unawaited: a queued command runs once the session is idle, after this one returns.
    void $.command.run({ command: 'timeline' }).catch(err => $.ui.toast(`inflight: /timeline failed: ${String(err)}`))
    return { text: 'Rescanning; MCP and the worktrees sit in the timeline pane.' }
  })

  // Wraps the timeline pane: the MCP block, whatever the chain draws, then the worktrees. Timeline draws its
  // milestones above next(e), so the worktrees land at the bottom whichever mod's hook runs first; the MCP block
  // tops the pane only while this hook runs outside timeline's.
  on('ui.render', { component: 'Pane', requestId: TIMELINE_PANE }, async ($, e, next) => {
    const el = $.ui.resolve(e)
    const above = await next(e)
    const refresh = () => Promise.all([runScan($), checkMcp($)])
    return (
      <el.Box flexDirection="column">
        <el.Box marginBottom={1}>{mcpTree(el, await read($, mcp))}</el.Box>
        {above}
        <el.Box marginTop={1}>{paneTree(el, await read($, scan), refresh, row => removeWorktree($, row))}</el.Box>
      </el.Box>
    )
  })

  // After a Bash call that pushed, changed worktrees or ran the remove command, rescan once the burst is over.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (cfg.rescanAfter.test(e.command)) {
      debounce?.cancel()
      debounce = $.clock.after(DEBOUNCE_MS, () => void runScan($))
    }
    return ran
  }).catch(($, e, next) => next(e)) // never stand in a Bash call's way: replay or run it
}
