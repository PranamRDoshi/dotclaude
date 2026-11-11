/**
 * Tests for the timeline mod, run by `claude plugin test`: the reply filter,
 * at most one entry per turn, no call on a Save-started turn, a new memory
 * suggestion replacing an unanswered one, and the pane's bold and color
 * rules. The test's hooks stand for the engine beneath the plugin, Haiku
 * included.
 */
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { parseReply } from '../hooks/reflect'

const BAND = {
  plugin: 'timeline',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'timeline',
  component: 'Pane',
  requestId: 'timeline',
  props: {
    title: 'Timeline',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/**
 * Stands the engine beneath the plugin: Haiku answers the queued replies in
 * order, the session's memory index is one line, and every event settles.
 * Returns the prompts Haiku was sent and the prompts the plugin submitted.
 */
function engine(on: On, replies: string[]) {
  const asked: string[] = []
  const submitted: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 27, 9, 30) })
  on('model.complete', (_, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true, text: replies.shift() ?? 'null', usage: USAGE } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: { breakdown: { memoryFiles: [{ path: '/mem/MEMORY.md', type: 'AutoMem', tokens: 9 }] } },
    } as never,
  }))
  on('fs.read', () => ({ value: '- [Known thing](known.md) - already saved' }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => (submitted.push(e.text), { text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  // The engine's own drawing, for a band the plugin leaves alone.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { asked, submitted, clock }
}

/** Raises one main-thread turn with one Bash call, then lets the unawaited call land. */
async function runTurn($: Engine, clock: MockClock, turnId: string, text = 'do it') {
  await $.turn.start({ text, turnId })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --base develop' })
  await $.turn.complete({ turnId, answer: 'Opened PR #1680.', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()
}

const PR_REPLY = '{"milestone":{"kind":"pr-raised","text":"PR #1680 raised into develop","ref":"#1680"},"memory":null}'

test('the reply filter keeps allowlisted kinds and drops the rest', () => {
  expect(parseReply('```json\n' + PR_REPLY + '\n```')?.milestone?.kind).toBe('pr-raised')
  expect(parseReply(PR_REPLY)?.isSkipped).toBe(false)
  // Only the reply's own null skips; a dropped milestone still gets the floor row.
  expect(parseReply('{"milestone":null,"memory":null}')?.isSkipped).toBe(true)
  expect(parseReply('{"milestone":{"kind":"worktree-created","text":"x","ref":""},"memory":null}')?.isSkipped).toBe(false)
  expect(parseReply('not json at all')).toBe(null)
  expect(parseReply('{"milestone":{"kind":"worktree-created","text":"made a worktree","ref":""},"memory":null}')?.milestone).toBe(null)
  expect(parseReply(`{"milestone":{"kind":"other","text":"${'x'.repeat(101)}","ref":""},"memory":null}`)?.milestone).toBe(null)
  expect(parseReply('{"milestone":null,"memory":{"type":"opinion","text":"nope"}}')?.memory).toBe(null)
  expect(parseReply('{"milestone":null,"memory":{"type":"feedback","text":"prefers \\u001b[31mred"}}')?.memory?.text).toBe(
    'prefers [31mred',
  )
})

test('a turn adds one entry, heard twice or not, and the pane shows it', async ($, on) => {
  const { asked, clock } = engine(on, [PR_REPLY, PR_REPLY])

  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await empty.find({ type: 'Text' }))?.text).toBe('No milestones yet.')
  await empty.unmount()

  await $.tool.call({ tool: 'Bash', command: 'subagent work', agentId: 'a1' })
  await runTurn($, clock, 't1')
  // The same turn's end heard again adds nothing (the scratch is gone, no call).
  await $.turn.complete({ turnId: 't1', answer: 'again', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('gh pr create')
  expect(asked[0]).not.toContain('subagent work')
  expect(asked[0]).toContain('Known thing')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = await ui.findAll({ type: 'Text', text: /PR #1680 raised into develop/ })
    expect(rows).toHaveLength(1)
    // What the chain beneath draws (another mod's list in a session) stays below the milestones.
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts[texts.length - 1]?.text).toBe('engine')
    await ui.unmount()
  }
})

test('a turn the mod started through Save gets no call', async ($, on) => {
  const memoryReply = '{"milestone":null,"memory":{"type":"feedback","text":"Prefers stacked PRs by concern"}}'
  const { asked, submitted, clock } = engine(on, [memoryReply, PR_REPLY])
  await runTurn($, clock, 't1')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'timeline-save' })
  expect(submitted).toEqual(['Save this to memory (feedback): Prefers stacked PRs by concern'])
  expect(await band.find({ key: 'timeline-save' })).toBeUndefined()
  await band.unmount()

  await runTurn($, clock, 't2', submitted[0])
  expect(asked).toHaveLength(1)

  // The next turn the person starts is asked about again.
  await $.prompt.submit({ text: 'next task' })
  await runTurn($, clock, 't3')
  expect(asked).toHaveLength(2)
})

test('a new suggestion replaces an unanswered one', async ($, on) => {
  const first = '{"milestone":null,"memory":{"type":"project","text":"Old suggestion"}}'
  const second = '{"milestone":null,"memory":{"type":"reference","text":"New suggestion"}}'
  const { clock } = engine(on, [first, second])

  await runTurn($, clock, 't1')
  await runTurn($, clock, 't2')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /New suggestion/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Old suggestion/ })).toBeUndefined()
    await band.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'timeline-skip' })
  expect(await band.find({ type: 'Text', text: /New suggestion/ })).toBeUndefined()
  await band.unmount()
})

test('the pane opens by itself once per session, and a reload does not reopen it', async ($, on) => {
  engine(on, [])
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.scroll', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // A reload runs session.start again with $.state kept.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['timeline'])
})

test('with suggestMemories off the index is not sent and a memory in the reply is dropped', { options: { suggestMemories: 'off' } }, async ($, on) => {
  const { asked, clock } = engine(on, ['{"milestone":null,"memory":{"type":"project","text":"Unwanted suggestion"}}'])
  await runTurn($, clock, 't1')

  // The fixture's index line never reaches the model, and the rule tells it to send no memory.
  expect(JSON.stringify(asked[0])).not.toContain('Known thing')
  expect(JSON.stringify(asked[0])).toContain('suggestions are turned off')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Unwanted suggestion/ })).toBeUndefined()
  await band.unmount()
})

test('with autoOpen off the pane waits for /timeline', { options: { autoOpen: 'off' } }, async ($, on) => {
  engine(on, [])
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual([])
})

test('a null milestone adds no row; turn when nothing listed fits; the prompt when the reply is bad', async ($, on) => {
  const fallback = '{"milestone":{"kind":"turn","text":"fallback kind agreed","ref":""},"memory":null}'
  const skip = '{"milestone":null,"memory":null}'
  const { clock } = engine(on, [fallback, skip, 'not json at all'])
  await runTurn($, clock, 't1')
  await runTurn($, clock, 't2', 'copy the handoff to the clipboard')
  await runTurn($, clock, 't3', 'add a floor so a failed call still gets a row')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Text', text: /turn {2}fallback kind agreed/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /copy the handoff/ })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Text', text: /turn {2}add a floor so a failed call still gets a row/ })).toHaveLength(1)
  await ui.unmount()
})

test('only the newest row is bold; older rows bold their spans and PR numbers; kinds take their area color', async ($, on) => {
  const debug =
    '{"milestone":{"kind":"turn","text":"root cause: billing-api metric id never existed, see #586","ref":"","area":"debug","bold":["billing-api","not in text"]},"memory":null}'
  const failed = '{"milestone":{"kind":"workflow-failed","text":"deploy red on prod","ref":"","area":"deploy"},"memory":null}'
  const latest = '{"milestone":{"kind":"other","text":"plan drafted","ref":"","area":"ci"},"memory":null}'
  expect(parseReply(debug)?.milestone?.bold).toEqual(['billing-api'])
  expect(parseReply('{"milestone":{"kind":"turn","text":"x","ref":"","area":"frontend"},"memory":null}')?.milestone?.area).toBe(undefined)

  const { clock } = engine(on, [debug, failed, latest])
  await runTurn($, clock, 't1')
  await runTurn($, clock, 't2')
  await runTurn($, clock, 't3')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const props = async (text: RegExp) => (await ui.find({ type: 'Text', text }))?.props
  // Older fallback row: spans and the PR number bold and undimmed, the rest dim, kind in debug yellow.
  expect((await props(/^billing-api$/))?.bold).toBe(true)
  expect((await props(/^billing-api$/))?.dimColor).toBe(false)
  expect((await props(/^#586$/))?.bold).toBe(true)
  expect((await props(/^root cause: $/))?.dimColor).toBe(true)
  expect((await props(/^root cause: $/))?.bold).toBe(false)
  expect((await props(/^turn$/))?.color).toBe('warning')
  // A failed run is red over its deploy area, and its older row is not bold.
  expect((await props(/^workflow-failed$/))?.color).toBe('error')
  expect((await props(/^deploy red on prod$/))?.bold).toBe(false)
  // The newest row is bold throughout.
  expect((await props(/^plan drafted$/))?.bold).toBe(true)
  expect((await props(/^other$/))?.color).toBe('ide')
  expect((await props(/^other$/))?.bold).toBe(true)
  await ui.unmount()
})
