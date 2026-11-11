/**
 * cache-clock: the session's status line. It shows context fill, cost, how long
 * the main thread's prompt cache stays warm, 5-hour and weekly usage with the time
 * left until each resets, then model
 * (effort), cwd and branch, each graded by colour, and offers one Keep warm button in
 * the band above the prompt while the cache is cooling. Why: an idle session
 * that lets its cache lapse pays a full prefix write on the next message.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, ModelUsage, Register } from 'claude-code'

import type { CacheClockUsageSplit } from '../types'

const TTL_1H_MS = 60 * 60 * 1000
const TTL_5M_MS = 5 * 60 * 1000
const TICK_MS = 30 * 1000
const FALLBACK_TTL_MS: Record<string, number | null> = { none: null, '5m': TTL_5M_MS, '1h': TTL_1H_MS }
const BAR_SEGMENTS = 10
// ponytail: macOS and Linux home layouts only; a HOME elsewhere shows its full path.
const HOME_PREFIX = /^\/(Users|home)\/[^/]+/

// A red branch flags one you should not commit on. Matches the protectedBranches default in plugin.json.
const DEFAULT_PROTECTED = 'main,master,develop'
const PHASE_COLOR = { warm: 'success', cooling: 'warning', cold: 'error' } as const

// Module-level: one load serves one session, and a reload re-reads both on session.start.
let currentBranch: string | undefined
// The engine has no effort getter; main-thread requests carry it. ponytail: blank after a reload until the next reply.
let currentEffort: string | number | undefined
// The parts the PromptHint hook draws; refresh() recomputes them.
let currentParts: Run[][] = []
// Branches drawn red; register() replaces it from the protectedBranches option.
let protectedBranches = parseBranches(DEFAULT_PROTECTED)

/** Splits the comma-separated protectedBranches option into a set; an empty value flags no branch. */
export function parseBranches(value: string): Set<string> {
  return new Set(value.split(',').map(name => name.trim()).filter(Boolean))
}

const lastAt = atom({ plugin: 'cache-clock', key: 'lastAt' } as const, null)
const ttlMs = atom({ plugin: 'cache-clock', key: 'ttlMs' } as const, null)
const isWarming = atom({ plugin: 'cache-clock', key: 'isWarming' } as const, false)

type Usage = ModelUsage & CacheClockUsageSplit
export type Phase = { kind: 'warm' | 'cooling'; leftMs: number } | { kind: 'cold' }

/**
 * Reads the TTL a response wrote its cache entry with, from the per-TTL split.
 * Undefined for a pure read, or when the runtime does not pass the split.
 */
export function ttlFromUsage(usage: Usage): number | undefined {
  const split = usage.cache_creation
  if ((split?.ephemeral_1h_input_tokens ?? 0) > 0) return TTL_1H_MS
  if ((split?.ephemeral_5m_input_tokens ?? 0) > 0) return TTL_5M_MS
  return undefined
}

/**
 * Where the clock stands at `now`. Null when no TTL is known yet (show nothing).
 * Cooling is the last 10 min of a 1h TTL and the last 60 s of a 5m one.
 */
export function phaseAt(last: number | null, ttl: number | null, now: number): Phase | null {
  if (last === null || ttl === null) return null
  const leftMs = ttl - (now - last)
  if (leftMs <= 0) return { kind: 'cold' }
  const coolingMs = ttl >= TTL_1H_MS ? 10 * 60 * 1000 : 60 * 1000
  return { kind: leftMs <= coolingMs ? 'cooling' : 'warm', leftMs }
}

/** The status-line text for a phase; undefined clears the line. */
export function statusText(phase: Phase | null): string | undefined {
  if (phase === null) return undefined
  if (phase.kind === 'cold') return 'cache cold'
  // Round up so "1m" still means time is left; under a minute, count seconds.
  const left = phase.leftMs >= 60_000 ? `${Math.ceil(phase.leftMs / 60_000)}m` : `${Math.ceil(phase.leftMs / 1000)}s`
  return `cache ${phase.kind} ${left}`
}

/** The session figures the line shows beside the clock; any may be missing. */
export type SessionFigures = {
  cwd?: string
  branch?: string
  model?: string
  effort?: string | number
  percent?: number
  usd?: number
  /** Percent used of the five_hour and seven_day rate-limit windows. */
  fiveHour?: number
  week?: number
  /** Time left until each window resets, from its resetsAt. */
  fiveHourLeftMs?: number
  weekLeftMs?: number
}

/** Time left as the line shows it: 42m under an hour, 2h13m under a day, else 4d6h. */
export function leftText(ms: number): string {
  // Minutes round up, as the cache clock does, so "1m" still means time is left.
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h${mins % 60}m`
  const hours = Math.floor(mins / 60)
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

/** Draws a 10-segment bar for a 0-100 percentage, as the old status-line script did. */
export function contextBar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round(percent / 10)))
  return '█'.repeat(filled) + '░'.repeat(BAR_SEGMENTS - filled)
}

/** One colored run of the line: a theme color, or none for the text color; isDim draws it dim. */
export type Run = { text: string; color?: string; isDim?: boolean }

/** Fill grade for context and the usage windows: green below 50%, yellow from 50%, red from 80%. */
export function ctxColor(percent: number): string {
  return percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success'
}

/** Session cost grade: plain under $10, yellow from $10, red from $25. */
export function usdColor(usd: number): string | undefined {
  return usd >= 25 ? 'error' : usd >= 10 ? 'warning' : undefined
}

/**
 * The session figures and the clock as colored parts, each a list of runs: context
 * bar, cost, cache, 5h, wk, model (effort), cwd (branch). Missing parts drop out.
 */
export function composeParts(figures: SessionFigures, phase: Phase | null): Run[][] {
  const cache = statusText(phase)
  const branch = figures.branch
  // Countdown only, no wall-clock reset time; a past or unknown reset drops it.
  const usedPart = (label: string, percent?: number, leftMs?: number) => {
    if (percent === undefined) return false
    const left = leftMs !== undefined && leftMs > 0 ? ` ${leftText(leftMs)}` : ''
    return [{ text: `${label} ${Math.round(percent)}%${left}`, color: ctxColor(percent) }]
  }
  const model = figures.model && (figures.effort === undefined ? figures.model : `${figures.model} (${figures.effort})`)
  // Short figures lead: the row truncates at its end, so a long cwd or branch goes last.
  // Usage windows and the model sit before cwd.
  const parts = [
    figures.percent !== undefined && [
      { text: `ctx [${contextBar(figures.percent)}] ${Math.round(figures.percent)}%`, color: ctxColor(figures.percent) },
    ],
    figures.usd !== undefined && [{ text: `$${figures.usd.toFixed(2)}`, color: usdColor(figures.usd) }],
    cache !== undefined && phase !== null && [{ text: cache, color: PHASE_COLOR[phase.kind] }],
    usedPart('5h', figures.fiveHour, figures.fiveHourLeftMs),
    usedPart('wk', figures.week, figures.weekLeftMs),
    model && [{ text: model, isDim: true }],
    figures.cwd && [
      { text: figures.cwd.replace(HOME_PREFIX, '~'), color: 'ide' },
      ...(branch ? [{ text: ` (${branch})`, color: protectedBranches.has(branch) ? 'error' : 'planMode' }] : []),
    ],
  ]
  return parts.filter((part): part is Run[] => Array.isArray(part))
}

/** Shortens a model id for the line: claude-opus-5-5 reads Opus 5.5; any other id shows as given. */
export function shortModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(.*)$/.exec(model)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}${m[4]}` : model
}

/** Reads the session's figures; one the engine cannot give is left out, never guessed. */
async function sessionFigures($: EngineInterface): Promise<SessionFigures> {
  // allSettled: one failed read must not blank the whole line.
  const [cwd, model, usage, now] = await Promise.allSettled([
    $.session.cwd(),
    $.session.model(),
    $.session.usage(),
    $.clock.now(),
  ])
  const figures = usage.status === 'fulfilled' ? usage.value : undefined
  // Empty off a subscription or before the first reply: those parts drop out.
  const limitOf = (kind: string) => figures?.rateLimits.find(limit => limit.kind === kind)
  const used = (kind: string) => limitOf(kind)?.percentUsed
  // NaN for an unparsable resetsAt, which the line treats as unknown.
  const left = (kind: string) => {
    const resetsAt = limitOf(kind)?.resetsAt
    return resetsAt && now.status === 'fulfilled' ? Date.parse(resetsAt) - now.value : undefined
  }
  return {
    cwd: cwd.status === 'fulfilled' ? cwd.value : undefined,
    branch: currentBranch,
    model: model.status === 'fulfilled' ? shortModel(model.value) : undefined,
    effort: currentEffort,
    percent: figures?.context.percent,
    usd: figures?.cost?.usd,
    fiveHour: used('five_hour'),
    week: used('seven_day'),
    fiveHourLeftMs: left('five_hour'),
    weekLeftMs: left('seven_day'),
  }
}

/** The branch checked out in the session's directory; undefined outside a repo or detached. */
async function readBranch($: EngineInterface): Promise<string | undefined> {
  try {
    // --no-optional-locks, as the old script did: never block a git command running beside it.
    const r = await $.process.run(['git', '--no-optional-locks', 'branch', '--show-current'], { timeoutMs: 2000 })
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** Reads the clock's state and the time, and computes the phase. */
async function currentPhase($: EngineInterface): Promise<Phase | null> {
  const [last, ttl, now] = await Promise.all([read($, lastAt), read($, ttlMs), $.clock.now()])
  return phaseAt(last, ttl, now)
}

/** Recomputes the line and redraws the hint row and band, since phases move with time alone. */
async function refresh($: EngineInterface): Promise<void> {
  const [figures, phase] = await Promise.all([sessionFigures($), currentPhase($)])
  currentParts = composeParts(figures, phase)
  $.ui.invalidate('ui.render')
}

/** Logs the usage counts and any TTL split to the debug log, as live evidence. */
function logUsage($: EngineInterface, label: string, usage: Usage): void {
  const split = usage.cache_creation
  const splitText = split
    ? `1h=${split.ephemeral_1h_input_tokens ?? 0} 5m=${split.ephemeral_5m_input_tokens ?? 0}`
    : 'split absent'
  $.ui.log(
    `cache-clock: ${label} read=${usage.cache_read_input_tokens} write=${usage.cache_creation_input_tokens} ${splitText}`,
    { to: 'debug' },
  )
}

/**
 * Stamps a cache touch at now. TTL comes from the split, else the last known
 * one (a pure read keeps it), else the configured fallback; none means no stamp.
 */
async function stamp($: EngineInterface, usage: Usage, fallbackTtl: number | null): Promise<void> {
  const ttl = ttlFromUsage(usage) ?? (await read($, ttlMs)) ?? fallbackTtl
  if (ttl === null) return
  const now = await $.clock.now()
  await update($, ttlMs, () => ttl)
  await update($, lastAt, () => now)
  await refresh($)
}

/** Forgets the clock: compaction and /clear replace the cached prefix. */
async function clearClock($: EngineInterface): Promise<void> {
  await update($, lastAt, () => null)
  await update($, ttlMs, () => null)
  await refresh($)
}

/** Why a fork did not keep the cache warm, for the toast. */
function forkFailure(r: ModelForkResult): string {
  if (r.isAnswered) return 'cache read 0 tokens'
  if (r.reason === 'api-error') return `api-error ${r.status ?? 'no status'} ${r.error}`
  return r.reason
}

/**
 * The Keep warm press: one fork over the main transcript, which reads the
 * cached prefix and so refreshes it. Clicks during a fork are ignored.
 */
async function keepWarm($: EngineInterface, fallbackTtl: number | null): Promise<void> {
  // Claim the flag atomically: update retries on a version miss, so two quick
  // presses cannot both see false.
  let isClaimed = false
  await update($, isWarming, held => {
    isClaimed = !held
    return true
  })
  if (!isClaimed) return
  try {
    const r = await $.model.fork({ prompt: 'Reply with OK.' })
    if ('usage' in r) logUsage($, `fork ${r.isAnswered ? 'answered' : r.reason}`, r.usage)
    // Only a real cache read proves the entry was refreshed; anything else
    // leaves the clock alone so it never overstates warmth.
    if (r.isAnswered && r.usage.cache_read_input_tokens > 0) {
      await stamp($, r.usage, fallbackTtl)
      $.ui.toast(`cache kept warm (${Math.round(r.usage.cache_read_input_tokens / 1000)}k tokens read)`)
    } else {
      $.ui.toast(`keep warm failed: ${forkFailure(r)}`)
    }
  } finally {
    await update($, isWarming, () => false)
  }
}

/** Registers the clock's hooks: stamping, clearing, ticking, the hint-row line and the band. */
export const register: Register = (on, options) => {
  const fallbackTtl = FALLBACK_TTL_MS[String(options.fallbackTtl)] ?? null
  // An unset option keeps the default; an empty string means "flag no branch".
  protectedBranches = parseBranches(String(options.protectedBranches ?? DEFAULT_PROTECTED))
  // Module-level so a second session.start in the same environment does not
  // stack timers; a reload drops the old environment's timers anyway.
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    // A reload loses any fork in flight, so the flag cannot still be true.
    await update($, isWarming, () => false)
    tick?.cancel()
    // $.clock.every, not a sleep loop: a sleep is billed to the hook's budget,
    // while timers started here outlive the dispatch.
    tick = $.clock.every(TICK_MS, () => void refresh($))
    // Clears the pinned status an earlier version set; the line lives in the hint row now.
    $.ui.status(undefined)
    currentBranch = await readBranch($)
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A turn may switch branch or directory; re-read once the main thread's turn ends.
    if (e.agentId === undefined) {
      currentBranch = await readBranch($)
      await refresh($)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    // Absent for a model without effort, which drops the brackets.
    if (e.agentId === undefined) currentEffort = e.effort
    const result = yield* next(e)
    const usage = result.usage as Usage | null
    // Subagents keep their own cache; a step that touched no cache refreshed nothing.
    const isMainCacheTouch =
      e.agentId === undefined &&
      usage !== null &&
      usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0
    if (isMainCacheTouch) {
      if (usage.cache_creation_input_tokens > 0) logUsage($, 'step', usage)
      await stamp($, usage, fallbackTtl)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // precompute installs nothing (its result waits for the real compaction),
    // and a skip leaves the prefix as it was.
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      await clearClock($)
    }
    return result
  }).catch(($, e, next) => next(e)) // never block a compaction: replay or pass it on

  on('session.end', async ($, e, next) => {
    // /clear is session.end with reason clear; no session.start follows it.
    if (e.reason === 'clear') await clearClock($)
    return next(e)
  })

  // The hint row, not $.ui.status, which the engine draws with a warning glyph and the
  // plugin's name. Our own tree, not `tail`, which the engine draws dim only and so cannot
  // carry the colour grades; the engine's line goes first, whole, so its pills stay live.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    if (currentParts.length === 0) return engineLine
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        <Box flexShrink={0}>{engineLine}</Box>
        {/* Cut at the row's end, as the engine cut `tail`. */}
        <Box key="cache-clock-line" flexShrink={1}>
          <Text wrap="truncate-end">
            {currentParts.map((runs, i) => [
              i > 0 && '  ',
              runs.map(run => <Text color={run.color} dimColor={run.isDim}>{run.text}</Text>),
            ])}
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Yield to surveys, and hide while a turn runs: that turn refreshes the cache.
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const [phase, warming] = await Promise.all([currentPhase($), read($, isWarming)])
    // Warm needs no button; warming a cold cache costs what the next message would.
    if (phase?.kind !== 'cooling') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{statusText(phase)} </Text>
        <Button
          key="keep-warm"
          hotkey="w"
          label={warming ? 'Warming...' : 'Keep warm'}
          onPress={() => keepWarm($, fallbackTtl)}
        />
      </Box>
    )
  })
}
