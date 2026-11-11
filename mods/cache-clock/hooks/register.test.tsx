/**
 * Tests for cache-clock: TTL detection from usage, the warm/cooling/cold
 * boundaries for both TTLs, the line's parts and colour grades (usage windows and
 * effort included), the band's visibility,
 * and the Keep warm fork.
 * Every hook registered here stands for the engine beneath the plugin.
 */
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

import { composeParts, contextBar, ctxColor, leftText, parseBranches, phaseAt, shortModel, statusText, ttlFromUsage, usdColor } from './register'
import type { Run } from './register'

const MIN = 60 * 1000
const H1 = 60 * MIN
const M5 = 5 * MIN
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const HINT = {
  plugin: 'cache-clock',
  component: 'PromptHint',
  requestId: 'prompt-hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const BAND = {
  plugin: 'cache-clock',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

/** Builds a usage record: cache read and write counts, plus an optional TTL split. */
function usage(read: number, write: number, split?: { h1?: number; m5?: number }) {
  const cacheCreation = split
    ? { cache_creation: { ephemeral_1h_input_tokens: split.h1 ?? 0, ephemeral_5m_input_tokens: split.m5 ?? 0 } }
    : {}
  return { ...ZERO, cache_read_input_tokens: read, cache_creation_input_tokens: write, ...cacheCreation }
}

/** Stands up the engine beneath the plugin and records toasts; `last` reads the hint row's line. */
function world(on: On) {
  const clock = mock.clock(on)
  const toasts: string[] = []
  const step = { usage: usage(0, 0) as ReturnType<typeof usage> | null }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: step.usage && { ...step.usage, model: 'claude-test' } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    // The hint row as the engine draws it: its own hint, which the plugin's line must keep.
    if (e.component === 'PromptHint') return <Text>{(e.props as { hint: string }).hint}</Text>
    return <Text>engine</Text>
  })
  /** The line the plugin put on the hint row, or undefined when it added none; the engine's hint must stay. */
  async function last($: Engine) {
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    const text = (await ui.find({ key: 'cache-clock-line' }))?.text
    await ui.unmount()
    return text || undefined
  }
  return { clock, toasts, step, last }
}

/** Starts the session the way the engine does. */
async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

/** Runs one model request of a turn with the given usage, main thread unless agentId, at the given effort. */
async function runStep(
  $: Engine,
  w: ReturnType<typeof world>,
  u: ReturnType<typeof usage>,
  extra: { agentId?: string; effort?: 'low' | 'xhigh' } = {},
) {
  w.step.usage = u
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 2, ...extra })
  for await (const _chunk of stream) {
    // drain: the result settles once the stream is read to its end
  }
  return stream.result
}

test('TTL comes from the ephemeral split; a pure read keeps it', () => {
  expect(ttlFromUsage(usage(0, 900, { h1: 900 }))).toBe(H1)
  expect(ttlFromUsage(usage(0, 900, { m5: 900 }))).toBe(M5)
  expect(ttlFromUsage(usage(5000, 0, {}))).toBe(undefined)
  expect(ttlFromUsage(usage(0, 900))).toBe(undefined)
})

test('main-thread steps stamp the clock, subagent steps do not', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await w.last($)).toBe(undefined)

  await runStep($, w, usage(0, 900, { h1: 900 }))
  expect(await w.last($)).toBe('cache warm 60m')

  // A pure read 20 min later keeps the 1h TTL and restarts the clock.
  await w.clock.advance(20 * MIN)
  await runStep($, w, usage(5000, 0))
  expect(await w.last($)).toBe('cache warm 60m')

  // A subagent's step changes nothing.
  const before = await w.last($)
  await runStep($, w, usage(0, 900, { m5: 900 }), { agentId: 'agent-1' })
  expect(await w.last($)).toBe(before)
})

test('a 5m write shows a 5 minute clock', async ($, on) => {
  const w = world(on)
  await start($)
  await runStep($, w, usage(0, 900, { m5: 900 }))
  expect(await w.last($)).toBe('cache warm 5m')
})

test('a pure read with no TTL seen yet shows nothing', { options: { fallbackTtl: 'none' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await runStep($, w, usage(5000, 0))
  expect(await w.last($)).toBe(undefined)
})

test('the fallback TTL fills in when usage has no split', { options: { fallbackTtl: '1h' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await runStep($, w, usage(0, 900))
  expect(await w.last($)).toBe('cache warm 60m')
})

test('warm, cooling and cold switch at the exact boundaries', () => {
  // 1h: cooling is the last 10 min.
  expect(phaseAt(0, H1, 50 * MIN - 1)?.kind).toBe('warm')
  expect(phaseAt(0, H1, 50 * MIN)?.kind).toBe('cooling')
  expect(phaseAt(0, H1, H1 - 1)?.kind).toBe('cooling')
  expect(phaseAt(0, H1, H1)?.kind).toBe('cold')
  // 5m: cooling is the last 60 s.
  expect(phaseAt(0, M5, 4 * MIN - 1)?.kind).toBe('warm')
  expect(phaseAt(0, M5, 4 * MIN)?.kind).toBe('cooling')
  expect(phaseAt(0, M5, M5 - 1)?.kind).toBe('cooling')
  expect(phaseAt(0, M5, M5)?.kind).toBe('cold')
  // No TTL known: nothing to show.
  expect(statusText(phaseAt(0, null, 0))).toBe(undefined)
  expect(statusText(phaseAt(0, H1, 19 * MIN))).toBe('cache warm 41m')
  expect(statusText(phaseAt(0, H1, 56 * MIN))).toBe('cache cooling 4m')
  expect(statusText(phaseAt(0, M5, 4 * MIN + 15 * 1000))).toBe('cache cooling 45s')
})

test('the 30 s tick walks the status line through the phases', async ($, on) => {
  const w = world(on)
  await start($)
  await runStep($, w, usage(0, 900, { h1: 900 }))
  await w.clock.advance(50 * MIN - 30 * 1000)
  expect(await w.last($)).toBe('cache warm 11m')
  await w.clock.advance(30 * 1000)
  expect(await w.last($)).toBe('cache cooling 10m')
  await w.clock.advance(10 * MIN)
  expect(await w.last($)).toBe('cache cold')
})

test('the band shows Keep warm only while cooling and idle', async ($, on) => {
  const w = world(on)
  await start($)
  await runStep($, w, usage(0, 900, { m5: 900 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const warm = await $.ui.mount({ ...BAND, surface })
    expect(await warm.find({ key: 'keep-warm' })).toBe(undefined)
    await warm.unmount()
  }
  await w.clock.advance(4 * MIN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const cooling = await $.ui.mount({ ...BAND, surface })
    expect((await cooling.find({ key: 'keep-warm' }))?.text).toBe('Keep warm')
    await cooling.unmount()
    const busy = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, isWorking: true } })
    expect(await busy.find({ key: 'keep-warm' })).toBe(undefined)
    await busy.unmount()
  }
})

/** Stamps a 1h clock at t=0, moves into the cooling window and mounts the band. */
async function coolingBand($: Engine, on: On, fork: () => ModelForkResult | Promise<ModelForkResult>) {
  const w = world(on)
  on('model.fork', async () => ({ value: await fork() }))
  await start($)
  await runStep($, w, usage(0, 900, { h1: 900 }))
  await w.clock.advance(52 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  return { w, ui }
}

test('a failed fork leaves lastAt unchanged and says why', async ($, on) => {
  const failures: ModelForkResult[] = [
    { isAnswered: false, reason: 'nothing-to-fork' },
    { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO },
    { isAnswered: true, text: 'OK', usage: { ...ZERO, cache_creation_input_tokens: 90000 } },
  ]
  let next = 0
  const { w, ui } = await coolingBand($, on, () => failures[next++])
  for (let i = 0; i < failures.length; i++) await $.ui.press({ plugin: 'cache-clock', key: 'keep-warm' })
  expect(w.toasts).toEqual([
    'keep warm failed: nothing-to-fork',
    'keep warm failed: api-error 529 overloaded',
    'keep warm failed: cache read 0 tokens',
  ])
  // lastAt still 0: the clock runs out at 60 min as if no fork had run.
  await w.clock.advance(8 * MIN)
  expect(await w.last($)).toBe('cache cold')
  await ui.unmount()
})

test('a fork that reads the cache resets the clock', async ($, on) => {
  const { w, ui } = await coolingBand($, on, () => ({
    isAnswered: true,
    text: 'OK',
    usage: { ...ZERO, cache_read_input_tokens: 120400 },
  }))
  await $.ui.press({ plugin: 'cache-clock', key: 'keep-warm' })
  expect(w.toasts).toEqual(['cache kept warm (120k tokens read)'])
  expect(await w.last($)).toBe('cache warm 60m')
  // lastAt moved to 52 min: at 60 min the cache is still warm.
  await w.clock.advance(8 * MIN)
  expect(await w.last($)).toBe('cache warm 52m')
  await ui.unmount()
})

test('clicks during a fork in flight are ignored', async ($, on) => {
  let forks = 0
  let clock: ReturnType<typeof mock.clock> | undefined
  const { w, ui } = await coolingBand($, on, async () => {
    forks += 1
    await clock?.sleep(1000)
    return { isAnswered: true, text: 'OK', usage: { ...ZERO, cache_read_input_tokens: 5000 } }
  })
  clock = w.clock
  const first = $.ui.press({ plugin: 'cache-clock', key: 'keep-warm' })
  await w.clock.settle()
  await $.ui.press({ plugin: 'cache-clock', key: 'keep-warm' })
  await w.clock.advance(1000)
  await first
  expect(forks).toBe(1)
  await ui.unmount()
})

test('compaction and /clear forget the clock', async ($, on) => {
  const w = world(on)
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await start($)
  await runStep($, w, usage(0, 900, { h1: 900 }))
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  expect(await w.last($)).toBe(undefined)

  await runStep($, w, usage(0, 900, { h1: 900 }))
  expect(await w.last($)).toBe('cache warm 60m')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(await w.last($)).toBe(undefined)
})

/** The parts as the row reads them: runs joined, parts two spaces apart. */
const lineText = (parts: Run[][]) => parts.map(runs => runs.map(run => run.text).join('')).join('  ')

test('the line joins context, cost, cache, usage, model (effort), cwd and branch, dropping missing parts', () => {
  expect(contextBar(41)).toBe('████░░░░░░')
  expect(contextBar(140)).toBe('██████████')
  const full = { cwd: '/Users/dev/code', branch: 'main', model: 'Opus 5.5', effort: 'high', percent: 41.4, usd: 3.125, fiveHour: 23.5, week: 80 }
  expect(lineText(composeParts(full, phaseAt(0, H1, 19 * MIN)))).toBe(
    'ctx [████░░░░░░] 41%  $3.13  cache warm 41m  5h 24%  wk 80%  Opus 5.5 (high)  ~/code (main)',
  )
  expect(lineText(composeParts({ cwd: '/srv/app', model: 'Opus 5.5' }, null))).toBe('Opus 5.5  /srv/app')
  expect(composeParts({}, null)).toEqual([])
  // Each usage window carries its countdown; a past reset drops it.
  const withLeft = { fiveHour: 23.5, fiveHourLeftMs: 2 * H1 + 13 * MIN, week: 80, weekLeftMs: -MIN }
  expect(lineText(composeParts(withLeft, null))).toBe('5h 24% 2h13m  wk 80%')
})

test('the protectedBranches option splits on commas; main, master and develop draw red by default', () => {
  expect([...parseBranches(' main, release ,,')]).toEqual(['main', 'release'])
  expect(parseBranches('').size).toBe(0)
  const branchRun = (branch: string) => composeParts({ cwd: '/srv/app', branch }, null)[0]![1]!
  expect(branchRun('master').color).toBe('error')
  expect(branchRun('feature/x').color).toBe('planMode')
})

test('time left reads 42m under an hour, 2h13m under a day, 4d6h beyond', () => {
  expect(leftText(30 * 1000)).toBe('1m')
  expect(leftText(42 * MIN)).toBe('42m')
  expect(leftText(59 * MIN + 1)).toBe('1h0m')
  expect(leftText(2 * H1 + 12 * MIN + 1)).toBe('2h13m')
  expect(leftText(24 * H1)).toBe('1d0h')
  expect(leftText(4 * 24 * H1 + 6 * H1 + 30 * MIN)).toBe('4d6h')
})

test('figures are graded: ctx and usage 50/80%, cost $10/$25, cache by phase, protected branches red, model dim', () => {
  expect([49.4, 50, 79, 80].map(ctxColor)).toEqual(['success', 'warning', 'warning', 'error'])
  expect([9.99, 10, 24.99, 25].map(usdColor)).toEqual([undefined, 'warning', 'warning', 'error'])
  const colors = (branch: string, now: number) =>
    composeParts({ cwd: '/srv/app', branch, model: 'Opus 5.5', fiveHour: 49.4, week: 80 }, phaseAt(0, H1, now))
      .flat()
      .map(run => run.color ?? (run.isDim ? 'dim' : 'plain'))
  expect(colors('develop', 19 * MIN)).toEqual(['success', 'success', 'error', 'dim', 'ide', 'error'])
  expect(colors('feature/x', 55 * MIN)).toEqual(['warning', 'success', 'error', 'dim', 'ide', 'planMode'])
  expect(colors('main', H1)[0]).toBe('error')
})

test('the usage windows and the main thread effort reach the line', async ($, on) => {
  const w = world(on)
  const resetIn = (ms: number) => new Date(w.clock.now() + ms).toISOString()
  const rateLimits = [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: resetIn(2 * H1 + 13 * MIN) },
    { kind: 'seven_day', percentUsed: 81, resetsAt: resetIn(4 * 24 * H1 + 6 * H1 + 5 * MIN) },
    { kind: 'spend_limit', percentUsed: 5 },
  ]
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits } as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  await start($)
  await runStep($, w, usage(0, 900, { h1: 900 }), { effort: 'xhigh' })
  expect(await w.last($)).toBe('cache warm 60m  5h 24% 2h13m  wk 81% 4d6h  Opus 5.5 (xhigh)')
  // A subagent's effort is its own; the tick redraws without it and moves the countdowns.
  await runStep($, w, usage(5000, 0), { agentId: 'agent-1', effort: 'low' })
  await w.clock.advance(30 * 1000)
  expect(await w.last($)).toBe('cache warm 60m  5h 24% 2h13m  wk 81% 4d6h  Opus 5.5 (xhigh)')
  // A model without effort drops the brackets.
  await runStep($, w, usage(5000, 0))
  expect(await w.last($)).toBe('cache warm 60m  5h 24% 2h13m  wk 81% 4d6h  Opus 5.5')
})

test('model ids read short; anything else shows as given', () => {
  expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(shortModel('claude-fable-5-1[1m]')).toBe('Fable 5.1[1m]')
  expect(shortModel('gpt-x')).toBe('gpt-x')
})
