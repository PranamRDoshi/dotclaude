/**
 * timeline mod: one Haiku call per main-thread turn. The call may add one
 * outcome milestone to the session's timeline (shown by `/timeline` in a
 * pane) and may suggest one memory (shown in the Reflect band above the
 * prompt with Save and Skip). Save goes through `$.prompt.submit` only: the
 * main session writes the memory under its own rules, never this mod.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register, RenderElement, RenderInput } from 'claude-code'

import type { TimelineArea, TimelineEntry, TimelineKind } from '../types'
import { FALLBACK_KIND, buildPrompt, floorMilestone, parseReply, summarizeTool } from './reflect'
import type { ToolSummary } from './reflect'

const PANE = 'timeline'
// Plan: the call sees the last 40 main-thread tool calls and the last 5 entries.
const MAX_TOOLS = 40
const RECENT_ENTRIES = 5
// ponytail: a cap so a marathon session can't bloat $.state; raise it if it ever bites.
const MAX_ENTRIES = 500
// A Haiku call that outruns this resolves `aborted` and the turn adds nothing.
const CALL_TIMEOUT_MS = 30_000

// One colour per area. Theme keys, so light and dark themes both read.
const AREA_COLOR: Record<TimelineArea, string> = {
  hotfix: 'claude',
  deploy: 'success',
  infra: 'autoAccept',
  debug: 'warning',
  ci: 'ide',
  review: 'planMode',
}
// A failed run reads red whatever its area.
const FAILED_KINDS: readonly TimelineKind[] = ['workflow-failed', 'deploy-failed']
// PR numbers draw bold on every row, rows stored before 0.2.0 included.
const PR_NUMBER = '#\\d+'

// Shape tags: change one when its value's fields change, so a stale value reads as empty.
const entries = atom({ plugin: 'timeline', key: 'entries' } as const, [], { shape: 'entries-1' })
const suggestion = atom({ plugin: 'timeline', key: 'suggestion' } as const, null, {
  shape: 'suggestion-1',
})
// $.state outlives a reload but not the session, so this means "opened once this session".
const autoOpened = atom({ plugin: 'timeline', key: 'autoOpened' } as const, false)

/** What the mod gathers while one main-thread turn runs. */
type TurnScratch = { turnId: string; prompt: string; tools: ToolSummary[]; isSkipped: boolean }

/**
 * Per-load scratch. ponytail: kept in the module, not $.state, so a hot reload
 * mid-turn loses that one turn's tool list; the timeline itself is in $.state.
 * `pendingSave` is the Save prompt waiting for its turn to start.
 */
type Scratch = { turn: TurnScratch | null; pendingSave: string | null; memoryPath: string | null }

/** Opens the timeline pane scrolled to the newest row; `end` keeps up as rows land (types: UiScrollTarget). */
async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Timeline' })
  await $.ui.scroll({ in: PANE, to: 'end' })
}

/** Logs one line to the debug log only, never the transcript. */
function debug($: EngineInterface, text: string): void {
  $.ui.log(`timeline: ${text}`, { to: 'debug' })
}

/**
 * Finds the session's MEMORY.md through the engine (the auto-memory files the
 * context carries) and reads it. Never a hardcoded path: no file, no index.
 */
async function readMemoryIndex($: EngineInterface, scratch: Scratch): Promise<string> {
  if (scratch.memoryPath === null) {
    // `summary` estimates locally and sends no token-count request (types: SessionUsageArgs).
    const usage = await $.session.usage({ breakdown: 'summary' })
    const files = usage.context.breakdown?.memoryFiles ?? []
    const index = files.find(file => file.type === 'AutoMem' && /(^|\/)MEMORY\.md$/.test(file.path))
    // Only a found path is kept, so a session whose memory loads later still gets it.
    scratch.memoryPath = index?.path ?? null
    if (index === undefined) debug($, 'no AutoMem MEMORY.md in the session context; index left out')
  }
  if (scratch.memoryPath === null) return ''
  try {
    return await $.fs.read(scratch.memoryPath)
  } catch {
    return ''
  }
}

/**
 * The per-turn call: asks Haiku about the finished turn, then stores what
 * survives the filter. Its milestone, if any, joins the timeline once per
 * turn; its memory replaces any unanswered suggestion.
 */
async function reflect($: EngineInterface, scratch: Scratch, turn: TurnScratch, answer: string, wantsMemory: boolean) {
  const recent = (await read($, entries)).slice(-RECENT_ENTRIES)
  // With suggestions off the memory index is never read, so it never leaves the machine.
  const memoryIndex = wantsMemory ? await readMemoryIndex($, scratch) : ''
  const prompt = buildPrompt({ prompt: turn.prompt, answer, tools: turn.tools, recent, memoryIndex, wantsMemory })
  const reply = await $.model.complete({ model: 'haiku', prompt, maxTokens: 300, timeoutMs: CALL_TIMEOUT_MS })
  // Plan: every call's usage goes to the debug log, so a week of spend can be summed.
  debug($, `haiku ${reply.isAnswered ? 'answered' : reply.reason} usage ${JSON.stringify(reply.usage)}`)

  const reflection = reply.isAnswered ? parseReply(reply.text) : null
  if (reply.isAnswered && reflection === null) debug($, 'reply dropped: not JSON')
  // A null milestone from Haiku means no row for this turn.
  // A failed call or a dropped milestone still falls to the floor, so a real outcome never vanishes.
  if (reflection?.isSkipped === true) {
    debug($, `turn ${turn.turnId}: no milestone`)
  } else {
    const milestone = reflection?.milestone ?? floorMilestone(turn.prompt)
    const entry: TimelineEntry = { ...milestone, at: await $.clock.now(), turnId: turn.turnId }
    // At most one entry per turn, even if this turn's end is heard twice.
    await update($, entries, list =>
      list.some(one => one.turnId === turn.turnId) ? list : [...list, entry].slice(-MAX_ENTRIES),
    )
  }
  // One suggestion at a time: a new one replaces an unanswered older one.
  // Dropped when suggestions are off, even if the model sent one anyway.
  const memory = wantsMemory ? (reflection?.memory ?? null) : null
  if (memory !== null) await update($, suggestion, () => memory)
}

/**
 * Save: clears the band, then submits the suggestion as a prompt. A plugin's
 * prompt waits until the session is idle (types: PromptSubmitArgs), so a
 * press mid-turn is held by the engine, not lost.
 */
async function saveSuggestion($: EngineInterface, scratch: Scratch): Promise<void> {
  // Read at press time, never the value captured when the band was drawn.
  const shown = await read($, suggestion)
  if (shown === null) return
  // Clear first so a double press cannot submit twice.
  await update($, suggestion, () => null)
  const text = `Save this to memory (${shown.type}): ${shown.text}`
  // Marked here, not at prompt.submit: under `claude plugin test` this mod's own
  // prompt.submit hook never saw its own $.prompt.submit.
  scratch.pendingSave = text
  // Unawaited: the call resolves only when the Save turn starts.
  void $.prompt.submit({ text }).then(async result => {
    if (result.drop === undefined) return
    debug($, `save prompt dropped: ${result.drop}`)
    if (scratch.pendingSave === text) scratch.pendingSave = null
    // Put it back unless a newer suggestion took the band meanwhile.
    await update($, suggestion, current => current ?? shown)
  })
}

/** Formats a time as local HH:MM. */
function clockTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** The kind word's color: red for a failed run, else its area's, else none. */
function kindColor(entry: TimelineEntry): string | undefined {
  if (FAILED_KINDS.includes(entry.kind)) return 'error'
  return entry.area && AREA_COLOR[entry.area]
}

/**
 * Splits a row's text into plain and bold runs: the reply's bold spans plus
 * every PR number. Longest span first, so one that contains another wins.
 */
function boldRuns(text: string, spans: readonly string[] = []): { text: string; isBold: boolean }[] {
  const escaped = [...spans].sort((a, b) => b.length - a.length).map(span => span.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // One capture group, so split alternates plain, bold, plain, ...
  const pattern = new RegExp(`(${[...escaped, PR_NUMBER].join('|')})`)
  return text
    .split(pattern)
    .map((part, i) => ({ text: part, isBold: i % 2 === 1 }))
    .filter(run => run.text !== '')
}

/**
 * Draws the `/timeline` pane: `HH:MM  kind  text  ref` per entry, newest at the
 * bottom, then whatever the chain beneath draws (another mod may add to this
 * pane, as inflight does), so that stays last whichever mod's hook runs first.
 */
async function drawPane($: EngineInterface, e: RenderInput<'Pane'>, below: RenderElement): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const list = await read($, entries)
  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No milestones yet.</Text>
        {below}
      </Box>
    )
  }
  // The whole list is drawn: the engine scrolls a body taller than the pane (types: Pane.scroll).
  return (
    <Box flexDirection="column">
      {list.map((entry, i) => {
        // Only the newest row is bold; older rows bold just their spans.
        const isLatest = i === list.length - 1
        // Older fallback rows stay dim so the listed milestones stand out.
        const isDim = entry.kind === FALLBACK_KIND && !isLatest
        const color = kindColor(entry)
        // Sibling runs, never bold nested in dim: many terminals cancel bold inside dim.
        return (
          <Text>
            <Text dimColor={!isLatest} bold={isLatest}>{clockTime(entry.at)}</Text>{'  '}
            <Text color={color} dimColor={isDim && color === undefined} bold={isLatest}>{entry.kind}</Text>{'  '}
            {boldRuns(entry.text, entry.bold).map(run => (
              <Text bold={isLatest || run.isBold} dimColor={isDim && !run.isBold}>{run.text}</Text>
            ))}
            {'  '}<Text dimColor={!isLatest} bold={isLatest}>{entry.ref}</Text>
          </Text>
        )
      })}
      {below}
    </Box>
  )
}

/** Hooks each main-thread turn's start and tool calls into the scratch. */
function trackTurns(on: On, scratch: Scratch): void {
  on('turn.start', ($, e, next) => {
    // Main thread only: a subagent's turn carries an agentId (types: TurnStartInput).
    if (e.agentId === undefined) {
      // A Save turn gets no Haiku call (plan). Matched by text, framed or bare,
      // so a prompt the person queued ahead of it is never the one skipped.
      const isSave = scratch.pendingSave !== null && e.text.includes(scratch.pendingSave)
      if (isSave) {
        scratch.pendingSave = null
        debug($, `turn ${e.turnId} started by Save; no call`)
      }
      scratch.turn = { turnId: e.turnId, prompt: e.text, tools: [], isSkipped: isSave }
    }
    return next(e)
  })

  // Never in the way of a tool: the .catch replays the call's result, or runs it as is.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // Main thread only: a subagent's calls carry an agentId (types: AgentLoop).
    if (e.agentId === undefined && scratch.turn !== null) {
      const isOk = ran.deny === undefined && ran.isError !== true
      const call: ToolSummary = { tool: String(e.tool), summary: summarizeTool(e), isOk }
      scratch.turn.tools = [...scratch.turn.tools, call].slice(-MAX_TOOLS)
    }
    return ran
  }).catch(($, e, next) => next(e))
}

/** Wires the turn tracking, the per-turn call, `/timeline` and the Reflect band. */
export const register: Register = (on, options) => {
  // Both options default to on; only the literal 'off' turns one off.
  const wantsMemory = options.suggestMemories !== 'off'
  const opensByItself = options.autoOpen !== 'off'
  const scratch: Scratch = { turn: null, pendingSave: null, memoryPath: null }
  trackTurns(on, scratch)

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Main thread only (types: TurnCompleteFields.agentId).
    if (e.agentId !== undefined) return result
    const turn = scratch.turn?.turnId === e.turnId ? scratch.turn : null
    scratch.turn = null
    // No start heard (a reload mid-turn), a Save turn, or an empty turn: no call.
    if (turn === null || turn.isSkipped) return result
    if (turn.tools.length === 0 && e.answer.trim() === '') return result
    // Unawaited on purpose: the turn's end is not held for a Haiku round trip.
    void reflect($, scratch, turn, e.answer, wantsMemory).catch(error => debug($, `reflect failed: ${String(error)}`))
    return result
  })

  on('session.start', async ($, e, next) => {
    // immediate: the pane opens mid-turn too; it reads nothing of the running turn.
    await $.command.register({
      name: 'timeline',
      description: "Show this session's milestones in a pane",
      immediate: true,
    })
    const result = await next(e)
    // Open by default each session, closable, unless autoOpen is off. Once per session, so a
    // reload never reopens a pane the person closed. Unasked, the engine seats it
    // only from 144 columns (types: $.ui.open); narrower, it waits for /timeline.
    if (opensByItself && e.isInteractive && !(await read($, autoOpened))) {
      await update($, autoOpened, () => true)
      void openPane($).catch(error => debug($, `auto-open failed: ${String(error)}`))
    }
    return result
  })

  on('command.run', { command: 'timeline' }, async $ => {
    await openPane($)
    return { text: 'Timeline opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => drawPane($, e, await next(e)))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, suggestion)
    // A survey owns the band; with nothing to suggest, leave it to the rest.
    if (e.props.hasSurvey || shown === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>
          <Text bold>Memory?</Text> <Text dimColor>[{shown.type}]</Text> {shown.text}{' '}
        </Text>
        <Button key="timeline-save" label="Save" variant="primary" onPress={() => saveSuggestion($, scratch)} />
        <Button key="timeline-skip" label="Skip" onPress={() => update($, suggestion, () => null)} />
      </Box>
    )
  })
}
