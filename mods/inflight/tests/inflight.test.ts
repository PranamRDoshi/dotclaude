/**
 * Inflight tests: rollup with and without a review check, PR pick and verdicts, both discovery modes and skipRepos
 * over mocked git and gh, the list under the timeline pane on both surfaces, the Remove button and its argv, the
 * session-long refresh, the debounced rescan, the old stored shape, and the MCP block above the timeline.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify, configuredServers } from '../hooks/mcp'
import { pickPr, removeArgv, rescanPattern, rollup, verdict } from '../hooks/scan'
import type { Bare, GhPr } from '../hooks/scan'
import type { Scan } from '../hooks/types'
import { REVIEW, SRC, page, pr, prefixSkipped, run, running, strayDir, worktrees } from './fixtures'

const HOME = '/home/t'
const CWD = '/proj'
// Root mode with both skip paths and a review check: every option but removeCommand set.
const OPTS = { worktreesRoot: '~/wt', skipRepos: 'ops, docs', reviewCheck: REVIEW }
// What `git worktree list --porcelain` prints in CWD: the main worktree first, then two linked ones.
const LISTED = [
  `worktree ${CWD}`, 'HEAD oidMain', 'branch refs/heads/main', '',
  'worktree /else/api--merged-gone', 'HEAD oidMergedHead', 'branch refs/heads/fix/merged-gone', '',
  'worktree /else/api--open-stacked', 'HEAD oid710', 'branch refs/heads/feat/open-stacked', '',
].join('\n')

// The context's MCP tools: signoz and ClickUp connected, Gmail and linear waiting on a sign-in.
const MCP_TOOLS = [
  { name: 'mcp__signoz__search_logs', serverName: 'signoz' },
  { name: 'mcp__claude_ai_Gmail__authenticate', serverName: 'claude.ai Gmail' },
  { name: 'mcp__claude_ai_Gmail__complete_authentication', serverName: 'claude.ai Gmail' },
  { name: 'mcp__claude_ai_ClickUp__clickup_search', serverName: 'claude.ai ClickUp' },
  { name: 'mcp__linear__authenticate', serverName: 'linear' },
].map(tool => ({ ...tool, tokens: 10, isLoaded: false }))
// Configured: tracker-mcp and proj-db never connected; local-one is disabled for the project.
const CLAUDE_JSON = JSON.stringify({
  mcpServers: { signoz: {}, 'tracker-mcp': {}, linear: {} },
  projects: { [CWD]: { mcpServers: { 'local-one': {} }, disabledMcpServers: ['local-one'] } },
})
const MCP_JSON = JSON.stringify({ mcpServers: { 'proj-db': {} } })
const SURFACES = ['terminal', 'desktop'] as const

type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

/** A process result with the given exit code and output. */
const out = (exitCode: number, stdout = '', stderr = ''): Ran => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

/** gh answering with a PR list. */
const ghOk = (prs: GhPr[]) => out(0, JSON.stringify(prs))

/** Answers `git -C <dir>` calls: the worktree list in CWD, else the fixture worktree the folder's name picks. */
function fakeGit(argv: readonly string[]): Ran {
  const dir = String(argv[2])
  const args = argv.slice(4).join(' ')
  if (args === 'worktree list --porcelain') return dir === CWD ? out(0, LISTED) : out(128, '', 'fatal: not a git repository')
  const f = worktrees[dir.split('/').pop() ?? '']
  if (!f) return out(128, '', 'fatal: not a git repository')
  if (args === 'rev-parse --path-format=absolute --git-common-dir') return out(0, `${SRC}/${f.repo}/.git\n`)
  if (args === 'rev-parse --abbrev-ref HEAD') return out(0, `${f.branch}\n`)
  if (args === 'rev-parse HEAD') return out(0, `${f.head}\n`)
  if (args === 'status --porcelain') return out(0, f.porcelain ? `${f.porcelain}\n` : '')
  if (args.startsWith('log -1')) return out(0, '2026-10-10 10:00:00 +0530\n')
  if (args.startsWith('rev-parse --verify')) return out(f.remote ? 0 : 1)
  if (args.startsWith('rev-list --count')) return out(0, `${f.ahead ?? 0}\n`)
  return out(1, '', `unexpected git ${args}`)
}

/** The engine beneath the plugin: fs, env, clock, store, processes and the timeline pane's own tree, recording every argv. */
function world(on: On, other: (argv: readonly string[]) => Ran = argv => ghOk(argv.includes('--head') ? [] : page)) {
  const w = {
    calls: [] as { argv: readonly string[]; cwd?: string }[],
    listed: [] as string[],
    stored: {} as Record<string, unknown>,
    toasts: [] as string[],
    cwd: CWD,
    clock: mock.clock(on, { now: 1_000 }),
    // The context session.usage answers with; a test empties it to fail the MCP check.
    mcpContext: { breakdown: { mcpTools: MCP_TOOLS } } as object,
  }
  mock.env(on, { HOME })
  const dirs = [...Object.keys(worktrees), prefixSkipped, strayDir]
  // Every $ call's hook answers { value }.
  on('fs.list', ($, e) => {
    w.listed.push(e.path)
    return {
      value: [
        ...dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
        { name: 'AGENTS.md', kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true },
      ],
    }
  })
  // git -C goes to the fake repos; gh and the remove command go to the test's own answer.
  on('process.run', ($, e) => {
    w.calls.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: e.argv[0] === 'git' && e.argv[1] === '-C' ? fakeGit(e.argv) : other(e.argv) }
  })
  on('store.set', ($, e) => {
    w.stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: w.stored[e.key] }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: w.mcpContext, rateLimits: [] } as never }))
  const files: Record<string, string> = { [`${HOME}/.claude.json`]: CLAUDE_JSON, [`${CWD}/.mcp.json`]: MCP_JSON }
  on('fs.read', ($, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path] } as never
  })
  // Stands in for the timeline mod's tree, which the list must keep above itself.
  on('ui.render', { component: 'Pane', requestId: 'timeline' }, ($, e) => h($.ui.resolve(e).Text, null, 'timeline rows') as never)
  return w
}

/** Runs /inflight and lets its scan finish. */
async function runInflight($: Engine, w: ReturnType<typeof world>) {
  await $.command.run({ command: 'inflight', args: '' } as never)
  await w.clock.settle()
  return w.stored.worktrees as Scan
}

/** The batched `gh pr list --limit 100` calls made so far. */
const batches = (w: ReturnType<typeof world>) => w.calls.filter(c => c.argv[0] === 'gh' && c.argv.includes('--limit') && c.argv.includes('100'))

/** Pane props as a surface hands them, at a body width. */
const paneProps = (bodyColumns: number) => ({
  title: 'Timeline', isFocused: false, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {},
})

/** Mounts the timeline pane on the terminal at a body width. */
const mount = ($: Engine, columns = 80) => $.ui.mount({ plugin: 'inflight', surface: 'terminal', component: 'Pane', requestId: 'timeline', props: paneProps(columns) })

/** A row skeleton for verdict cases: clean, pushed, branch with no PR. */
const bare = (extra: Partial<Bare> = {}): Bare => ({
  name: 'api--x', repo: 'api', slug: 'x', path: '/w', mainRepo: `${SRC}/api`, skipped: false, branch: 'feat/x', head: 'h1',
  dirty: 0, unpushed: 0, lastCommitAt: '', ...extra,
})

const openPr = { number: 9, title: 't', state: 'OPEN' as const, isDraft: false, base: 'develop', url: 'https://x/9', headOid: 'h1', ci: 'pass' as const, review: 'none' as const }

describe('rollup', () => {
  test('reviewCheck set: that check alone is the review state, pass, running, errored, findings, never CI', () => {
    expect(rollup([run(REVIEW, 'SUCCESS')], REVIEW)).toEqual({ ci: 'none', review: 'pass' })
    expect(rollup([running(REVIEW)], REVIEW).review).toBe('running')
    expect(rollup([run(REVIEW, 'NEUTRAL')], REVIEW).review).toBe('errored')
    expect(rollup([run(REVIEW, 'ACTION_REQUIRED')], REVIEW).review).toBe('fail')
  })
  test('reviewCheck unset: every check is CI, from CheckRuns and StatusContexts', () => {
    expect(rollup([], '')).toEqual({ ci: 'none', review: 'none' })
    expect(rollup([run(REVIEW, 'ACTION_REQUIRED')], '')).toEqual({ ci: 'fail', review: 'none' })
    expect(rollup([run('test', 'SUCCESS'), run('lint', 'SKIPPED')], '').ci).toBe('pass')
    expect(rollup([run('test', 'SUCCESS'), running('build')], '').ci).toBe('pending')
    expect(rollup([running('build'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE' }], '').ci).toBe('fail')
    expect(rollup([{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' }], '').ci).toBe('pending')
  })
})

test('pickPr: OPEN beats MERGED, else the highest number', () => {
  expect(pickPr([pr(5, 'b', { state: 'MERGED' }), pr(3, 'b')])?.number).toBe(3)
  expect(pickPr([pr(5, 'b', { state: 'CLOSED' }), pr(8, 'b', { state: 'MERGED' })])?.number).toBe(8)
  expect(pickPr([])).toBeUndefined()
})

test('verdict: one case per table row, first match wins; review text only with a review check', () => {
  const merged = { ...openPr, state: 'MERGED' as const }
  expect(verdict(bare({ skipped: true, dirty: 3 }))).toEqual({ verdict: 'keep', reason: 'skipped' })
  expect(verdict(bare({ error: 'unrecognised: not a git worktree' }))).toEqual({ verdict: 'unknown', reason: 'unrecognised: not a git worktree' })
  expect(verdict(bare({ unpushed: 'DETACHED', dirty: 2 })).reason).toBe('detached HEAD')
  expect(verdict(bare({ dirty: 2, pr: merged })).reason).toBe('2 uncommitted')
  expect(verdict(bare({ unpushed: 4, pr: merged })).reason).toBe('4 unpushed')
  // Merged PR, remote branch deleted, HEAD is the PR head: removable.
  expect(verdict(bare({ unpushed: 'NO_REMOTE', pr: merged }))).toEqual({ verdict: 'remove', reason: 'merged, remote branch deleted' })
  expect(verdict(bare({ unpushed: 'NO_REMOTE', head: 'later', pr: merged })).verdict).toBe('keep')
  expect(verdict(bare({ unpushed: 'NO_REMOTE' })).reason).toBe('never pushed')
  expect(verdict(bare({ pr: merged }))).toEqual({ verdict: 'remove', reason: 'PR #9 merged, clean, pushed' })
  expect(verdict(bare({ pr: openPr }), undefined, true)).toEqual({ verdict: 'keep', reason: 'ci pass, review none' })
  expect(verdict(bare({ pr: openPr }))).toEqual({ verdict: 'keep', reason: 'ci pass' })
  expect(verdict(bare())).toEqual({ verdict: 'keep', reason: 'no PR' })
  expect(verdict(bare(), 'HTTP 401: Bad credentials')).toEqual({ verdict: 'unknown', reason: 'HTTP 401: Bad credentials' })
  expect(verdict(bare({ dirty: 1 }), 'HTTP 401: Bad credentials').verdict).toBe('keep')
})

test('default discovery: linked worktrees of the session repo from git worktree list, main left out, no review text; outside git the pane says so', async ($, on) => {
  const w = world(on)
  const scan = await runInflight($, w)
  expect(w.listed).toEqual([])
  expect(scan.rows.map(row => row.path)).toEqual(['/else/api--merged-gone', '/else/api--open-stacked'])
  // reviewCheck unset: the running review check counts toward CI and no review state is reported.
  expect(scan.rows[1]).toMatchObject({ repo: 'api', slug: 'open-stacked', mainRepo: `${SRC}/api`, reason: 'ci pending', pr: { ci: 'pending', review: 'none' } })
  let ui = await mount($)
  expect(await ui.find({ text: /review/ })).toBeUndefined()
  expect(await ui.find({ text: /· gh ok$/ })).toBeDefined()
  await ui.unmount()
  w.cwd = '/plain'
  expect((await runInflight($, w)).rows).toEqual([])
  ui = await mount($)
  expect(await ui.find({ type: 'Text', text: '/plain is not in a git repository.' })).toBeDefined()
  // No rows means gh was never called, so the header must not vouch for it.
  expect(await ui.find({ text: /· gh not checked$/ })).toBeDefined()
  await ui.unmount()
})

test('worktreesRoot: the child folders of the root, ~ expanded, are the rows; verdicts and the store write', { options: OPTS }, async ($, on) => {
  const w = world(on)
  const scan = await runInflight($, w)
  const byName = Object.fromEntries(scan.rows.map(row => [row.name, row]))
  expect(w.listed).toEqual([`${HOME}/wt`])
  expect(scan.status).toBe('ok')
  expect(scan.rows).toHaveLength(6)
  expect(byName['api--merged-gone']).toMatchObject({ verdict: 'remove', reason: 'merged, remote branch deleted', unpushed: 'NO_REMOTE', mainRepo: `${SRC}/api` })
  expect(byName['api--open-stacked']).toMatchObject({ verdict: 'keep', reason: 'ci pass, review running', pr: { number: 710, base: 'feat/base' } })
  expect(byName['web--dirty-work']).toMatchObject({ repo: 'web', slug: 'dirty-work', verdict: 'keep', reason: '1 uncommitted', dirty: 1 })
  expect(byName[strayDir]).toMatchObject({ slug: strayDir, verdict: 'unknown', reason: 'unrecognised: not a git worktree' })
  // One batched call per repo with worktrees; the page is short, so no per-branch fallback.
  expect(batches(w)).toHaveLength(2)
  expect(w.calls.filter(c => c.argv.includes('--head'))).toEqual([])
})

test('skipRepos: a name prefix stops before any git call, a git-derived name and a stray folder after one', { options: OPTS }, async ($, on) => {
  const w = world(on)
  const scan = await runInflight($, w)
  const byName = Object.fromEntries(scan.rows.map(row => [row.name, row]))
  expect(byName[prefixSkipped]).toMatchObject({ skipped: true, repo: 'ops', slug: 'rollback', verdict: 'keep', reason: 'skipped' })
  expect(byName['handbook']).toMatchObject({ skipped: true, repo: 'docs', slug: 'handbook', verdict: 'keep', reason: 'skipped', branch: null })
  const touching = (name: string) => w.calls.filter(c => [...c.argv, c.cwd ?? ''].some(arg => arg.includes(name)))
  expect(touching(prefixSkipped)).toEqual([])
  for (const name of ['handbook', strayDir]) {
    expect(touching(name).map(c => c.argv.slice(4).join(' '))).toEqual(['rev-parse --path-format=absolute --git-common-dir'])
  }
})

test('gh failure: banner text, unknown verdicts, local facts kept', { options: OPTS }, async ($, on) => {
  const w = world(on, () => out(1, '', 'HTTP 401: Bad credentials\n'))
  const scan = await runInflight($, w)
  const byName = Object.fromEntries(scan.rows.map(row => [row.name, row]))
  expect(scan.ghError).toBe('HTTP 401: Bad credentials')
  expect(byName['api--merged-gone']).toMatchObject({ verdict: 'unknown', reason: 'HTTP 401: Bad credentials' })
  expect(byName['web--dirty-work']?.verdict).toBe('keep')
  const ui = await mount($, 140)
  expect(await ui.find({ text: /gh: HTTP 401: Bad credentials/ })).toBeDefined()
  expect(await ui.find({ text: /· gh failed$/ })).toBeDefined()
})

test('a full page falls back to one per-branch call for branches not on it', { options: OPTS }, async ($, on) => {
  // 100 unrelated PRs: the worktrees' branches are older than the page.
  const full = Array.from({ length: 100 }, (_, i) => pr(1000 + i, `other/${i}`))
  const w = world(on, argv => {
    const head = argv[argv.indexOf('--head') + 1]
    if (!argv.includes('--head')) return ghOk(full)
    return ghOk(head === 'fix/merged-gone' ? [pr(683, head, { state: 'MERGED', headRefOid: 'oidMergedHead' })] : [])
  })
  const scan = await runInflight($, w)
  const heads = w.calls.filter(c => c.argv.includes('--head')).map(c => c.argv[c.argv.indexOf('--head') + 1])
  expect(heads.sort()).toEqual(['feat/open-stacked', 'feature/dirty-work', 'fix/merged-gone'])
  expect(scan.rows.find(row => row.name === 'api--merged-gone')?.verdict).toBe('remove')
})

test('list draws under the timeline pane on terminal and desktop: numbered rows, repo accents, labelled details wrapped at any width, skipped rows name only; Refresh rescans', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await runInflight($, w)
  for (const surface of SURFACES) {
    for (const columns of [50, 80, 140]) {
      const ui = await $.ui.mount({ plugin: 'inflight', surface, component: 'Pane', requestId: 'timeline', props: paneProps(columns) })
      const texts = (await ui.findAll({ type: 'Text' })).map(node => node.text)
      // The MCP block first, then the timeline's rows, then the worktrees.
      expect(texts.indexOf('MCP')).toBe(0)
      expect(texts.indexOf('timeline rows')).toBeGreaterThan(0)
      // One number per worktree, 1..N across repos.
      for (let n = 1; n <= 6; n++) expect(texts).toContain(`${n}.`)
      const row = await ui.find({ key: 'row:api--merged-gone' })
      expect(row?.props.flexDirection).toBe('column')
      // Name and each detail value are Texts of their own that wrap; the stacked PR's checks sit on separate lines.
      const name = await ui.find({ type: 'Text', text: 'open-stacked' })
      expect(name?.props).toMatchObject({ wrap: 'wrap', bold: true })
      expect((await ui.find({ type: 'Text', text: 'running' }))?.props).toMatchObject({ wrap: 'wrap', color: 'warning' })
      expect(await ui.find({ type: 'Text', text: /^└ review/ })).toBeDefined()
      // Each repo's name and its worktrees' names share one accent; two repos never share it.
      const api = await ui.find({ type: 'Text', text: 'api' })
      const web = await ui.find({ type: 'Text', text: 'web' })
      expect(api?.props.bold).toBe(true)
      expect(name?.props.color).toBe(api?.props.color)
      expect(web?.props.color).not.toBe(api?.props.color)
      expect(await ui.find({ key: 'repo:api' })).toBeDefined()
      // Skipped rows carry no details at all, and their repo says why.
      for (const skipped of [prefixSkipped, 'handbook']) {
        expect(await ui.find({ key: `row:${skipped}` })).toBeDefined()
        expect(await ui.find({ key: `detail:${skipped}:0` })).toBeUndefined()
      }
      expect(await ui.find({ type: 'Text', text: 'skipped' })).toBeDefined()
      expect(await ui.find({ text: 'remove' })).toBeDefined()
      expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/example/repo/pull/683')
      expect(await ui.find({ text: /6 wt · 1 to remove/ })).toBeDefined()
      const before = batches(w).length
      await ui.press({ key: 'refresh' })
      expect(batches(w).length).toBe(before + 2)
      await ui.unmount()
    }
  }
})

test('removeCommand: split on whitespace, {path} and {name} filled in per token, ~ on the program expanded', () => {
  const row = { path: '/w/my tree', name: 'api--x' }
  expect(removeArgv('~/bin/wt-remove remove {name} --dir={path}', row, HOME)).toEqual([`${HOME}/bin/wt-remove`, 'remove', 'api--x', '--dir=/w/my tree'])
  expect(removeArgv('git worktree remove {path}', row, HOME)).toEqual(['git', 'worktree', 'remove', '/w/my tree'])
})

test('Remove shows only on a remove verdict; a press runs the default command in the main repo, toasts its answer and rescans', { options: OPTS }, async ($, on) => {
  const name = 'api--merged-gone'
  const path = `${HOME}/wt/${name}`
  let answer = out(0)
  const w = world(on, argv => (argv[1] === 'worktree' ? answer : ghOk(argv.includes('--head') ? [] : page)))
  await runInflight($, w)
  const ui = await mount($)
  const keys = (await ui.findAll({ type: 'Button' })).map(node => node.props.key)
  expect(keys.sort()).toEqual(['refresh', `remove:${name}`])
  const before = batches(w).length
  await ui.press({ key: `remove:${name}` })
  await w.clock.settle()
  const removes = w.calls.filter(c => c.argv[1] === 'worktree')
  expect(removes).toEqual([{ argv: ['git', 'worktree', 'remove', path], cwd: `${SRC}/api` }])
  // git worktree remove prints nothing on success, so the toast says what happened.
  expect(w.toasts.at(-1)).toBe(`inflight: removed ${name}`)
  expect(batches(w).length).toBe(before + 2)
  // A refusal toasts the command's first stderr line.
  answer = out(128, '', `fatal: '${path}' contains modified or untracked files, use --force to delete it\n`)
  await ui.press({ key: `remove:${name}` })
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe(`inflight: fatal: '${path}' contains modified or untracked files, use --force to delete it`)
  await ui.unmount()
})

test('auto-rescan after git push, git worktree or the remove program is debounced into one scan', { options: { ...OPTS, removeCommand: '~/bin/wt-remove remove {name}' } }, async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await runInflight($, w)
  const before = batches(w).length
  await $.tool.call({ tool: 'Bash', command: 'git -C ~/wt/api--x push -u origin feat/x' })
  await $.tool.call({ tool: 'Bash', command: 'git worktree add ../y' })
  await $.tool.call({ tool: 'Bash', command: '~/bin/wt-remove list' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await w.clock.advance(1_000)
  expect(batches(w).length).toBe(before)
  await w.clock.advance(3_000)
  expect(batches(w).length).toBe(before + 2) // one scan: one batch per repo
  // Each trigger alone matches; other git calls do not, and a git remove command adds no bare git match.
  const re = rescanPattern('~/bin/wt-remove remove {name}')
  for (const command of ['git -C x push', 'git worktree prune', 'wt-remove list']) expect(re.test(command)).toBe(true)
  expect(re.test('git status')).toBe(false)
  expect(rescanPattern('git worktree remove {path}').test('git log')).toBe(false)
})

test('an interactive session scans at start and every 5 minutes; a -p run never scans', { options: OPTS }, async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await w.clock.advance(10 * 60_000)
  expect(batches(w)).toHaveLength(0)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(batches(w)).toHaveLength(2)
  await w.clock.advance(5 * 60_000)
  expect(batches(w)).toHaveLength(4)
})

test('a scan stored by the earlier version, under its old key and shape, reads as empty', async ($, on) => {
  const w = world(on)
  // The earlier shape: no skipped or review field.
  w.stored.lastScan = { status: 'ok', scannedAt: 5, rows: [{ name: 'api--old', repo: 'api', slug: 'old', gated: false, pr: { ci: 'pass' } }] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: 'Not scanned yet.' })).toBeDefined()
  expect(await ui.find({ key: 'row:api--old' })).toBeUndefined()
  await ui.unmount()
})

test('MCP: configured servers minus disabled ones; tools sort servers into connected, auth and down', () => {
  expect(configuredServers(CLAUDE_JSON, MCP_JSON, CWD).sort()).toEqual(['linear', 'proj-db', 'signoz', 'tracker-mcp'])
  // A broken or missing file counts as empty.
  expect(configuredServers('{oops', undefined, CWD)).toEqual([])
  const servers = classify(MCP_TOOLS, configuredServers(CLAUDE_JSON, MCP_JSON, CWD))
  expect(servers.map(s => `${s.name}:${s.state}`)).toEqual([
    'claude.ai ClickUp:connected', 'claude.ai Gmail:auth', 'linear:auth', 'proj-db:down', 'signoz:connected', 'tracker-mcp:down',
  ])
})

test('MCP block tops the pane 10 s after start: down red, local auth yellow, connected on one line, unsigned claude.ai as a count; a failed check says so', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  let ui = await mount($)
  expect(await ui.find({ type: 'Text', text: 'checking...' })).toBeDefined()
  await ui.unmount()
  await w.clock.advance(10_000)
  ui = await mount($)
  const texts = (await ui.findAll({ type: 'Text' })).map(node => node.text)
  expect(texts[0]).toBe('MCP')
  expect((await ui.find({ type: 'Text', text: '2 connected, 2 down, 1 need auth' }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: '✗ proj-db  not connected' }))?.props.color).toBe('error')
  expect(await ui.find({ type: 'Text', text: '✗ tracker-mcp  not connected' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '! linear  needs auth' }))?.props.color).toBe('warning')
  expect(await ui.find({ type: 'Text', text: /● ClickUp {2}● signoz/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '○ 1 claude.ai connector not signed in' })).toBeDefined()
  await ui.unmount()
  // A check that cannot read the breakdown keeps the last list and says why.
  w.mcpContext = {}
  await w.clock.advance(60_000)
  ui = await mount($)
  expect(await ui.find({ type: 'Text', text: 'check failed: no context breakdown' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✗ proj-db  not connected' })).toBeDefined()
  await ui.unmount()
})
