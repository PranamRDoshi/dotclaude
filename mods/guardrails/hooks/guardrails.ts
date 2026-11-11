/** Guardrails hooks module: reads the install-time options and wires the session lifecycle, /consent, /guardrails and every tool call to the pure modules in src/. */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'
import type { GuardrailsDenial } from '../types'
import { ghPrMerge, parseBash } from '../src/bash'
import {
  type Consents,
  applyConsent,
  describeConsents,
  describeGuardrails,
  gatesOf,
  isUserTyped,
  MAX_DENIALS,
  parseConsent,
  refusalOf,
  statusText,
} from '../src/consent'
import { gitIntent } from '../src/git'
import { decide, type Deny, envKind, envTokens, needsBranch, type SegmentFacts, segmentTargets, type Targets, toolTargets } from '../src/rules'
import type { Segment } from '../src/types'
import { type Config, configOf, normalizePath, type Options, parseOptions, zoneOf } from '../src/zones'

// The engine only follows $ into functions declared in this file, and reads state refs only from consts
// here, so the atoms and every $-using helper live in this file while src/ stays pure.

// $.state only, never $.store: consent must not outlive the session (a --resume starts clean).
const consents = atom({ plugin: 'guardrails', key: 'consents' } as const, {} as Consents)
const denials = atom({ plugin: 'guardrails', key: 'denials' } as const, [] as GuardrailsDenial[])
// Shown when the check itself throws or is re-entered: fail closed.
const CHECK_FAILED =
  'guardrails: could not check this call. Split the command, or use absolute paths and git -C <dir>. Do not retry with another spelling or path.'
// gh and git lookups are quick; a hung one must not stall the tool call past this.
const LOOKUP_TIMEOUT_MS = 15_000

/** Clears consents, denials and the status line; run on session start and end (/clear has no new start). */
async function resetState($: EngineInterface): Promise<void> {
  await update($, consents, () => ({}))
  await update($, denials, () => [])
  $.ui.status(undefined)
}

/** Appends a denial to the session log (last 50 kept) and toasts the rule name. */
async function recordDenial($: EngineInterface, tool: string, rule: string, summary: string): Promise<void> {
  await update($, denials, list => [...list, { at: Date.now(), tool, rule, summary }].slice(-MAX_DENIALS))
  $.ui.toast(`guardrails: ${rule}`)
}

/** Resolves symlinks on the deepest existing ancestor via $.fs.stat, keeping the missing tail; lexical when nothing resolves. */
async function resolvePath($: EngineInterface, path: string, cwd: string, home: string): Promise<string> {
  const abs = normalizePath(path, cwd, home)
  // A Write may name a file, or folders, not there yet: walk up until something stats, then re-append the rest.
  let head = abs
  let tail = ''
  while (head !== '') {
    const stat = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    if (stat?.realPath !== undefined) return `${stat.realPath.replace(/\/$/, '')}${tail}`
    const cut = head.lastIndexOf('/')
    tail = head.slice(cut) + tail
    head = head.slice(0, cut)
  }
  // Nothing resolved (a test kit with no fs.stat, a vanished tree): the lexical spelling still classifies.
  return abs
}

/** Real path of a directory that exists, else null: a cd into a missing directory fails, so the shell's cwd is unknown. */
async function existingDir($: EngineInterface, dir: string | null): Promise<string | null> {
  if (dir === null) return null
  const stat = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
  return stat?.kind === 'dir' ? (stat.realPath ?? null) : null
}

/** Makes every target real, so a symlink into a gated repo lands in that repo's zone. */
async function realTargets($: EngineInterface, t: Targets, cwd: string, home: string): Promise<Targets> {
  const real = (list: string[]) => Promise.all(list.map(p => resolvePath($, p, cwd, home)))
  return { paths: await real(t.paths), writes: await real(t.writes), roots: await real(t.roots) }
}

/** This call's Config: the options plus HOME and this plugin's folder, every configured path made real the way targets are. */
async function configFor($: EngineInterface, o: Options): Promise<Config> {
  const home = await $.env.get('HOME')
  // Fail closed: without HOME neither ~ nor the built-in protected paths can be placed. The tool.call .catch denies.
  if (home === undefined || home === '') throw new Error('HOME is unset')
  const cfg = configOf(o, home, $.plugin.root)
  const real = (p: string) => resolvePath($, p, home, home)
  const root = cfg.root === null ? null : await real(cfg.root)
  return { ...cfg, root, selfRoots: await Promise.all(cfg.selfRoots.map(real)), settingsFile: await real(cfg.settingsFile) }
}

/** Env files named in the call's words or reached through its real paths (a symlink to .env). */
async function envHits($: EngineInterface, words: unknown[], real: string[], cwd: string, home: string): Promise<string[]> {
  const named = words.flatMap(w => (typeof w === 'string' ? envTokens(w).map(t => normalizePath(t, cwd, home)) : []))
  const hits: string[] = []
  for (const p of new Set([...named, ...real.filter(r => envKind(r) !== null)])) {
    const stat = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
    // A directory never counts (a venv named .env). A missing .env still counts, so creating one is blocked;
    // a missing *.env does not, so `rg process.env src` passes.
    if (stat?.kind !== 'dir' && (envKind(p) === 'dot' || stat !== undefined)) hits.push(p)
  }
  return hits
}

/** Runs a short read-only host command; its trimmed stdout, or null on a failure, timeout or empty output. */
async function runQuiet($: EngineInterface, argv: string[], cwd: string | undefined): Promise<string | null> {
  const ran = await $.process.run(argv, { cwd, timeoutMs: LOOKUP_TIMEOUT_MS }).catch(() => null)
  const out = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  return out === '' ? null : out
}

/** Base branch of the PR a `gh pr merge` names (or the current branch's PR); null when it cannot be looked up. */
async function prBaseOf($: EngineInterface, merge: { pr: string | null; repo: string | null }, cwd: string | null): Promise<string | null> {
  // Without --repo, gh reads the repo from cwd, so an unknown cwd cannot be looked up: fail closed.
  if (merge.repo === null && cwd === null) return null
  const argv = ['gh', 'pr', 'view', ...(merge.pr === null ? [] : [merge.pr]), '--json', 'baseRefName', '-q', '.baseRefName']
  return runQuiet($, merge.repo === null ? argv : [...argv, '--repo', merge.repo], cwd ?? undefined)
}

/** Facts for one Bash segment: real targets, git intent, the current branch when a branch rule needs it, and a gh pr merge's base. */
async function segmentFacts($: EngineInterface, seg: Segment, sessionCwd: string, cfg: Config): Promise<SegmentFacts> {
  const git = gitIntent(seg)
  const cwd = await existingDir($, seg.cwd)
  const real = await realTargets($, segmentTargets(seg, cfg.home), sessionCwd, cfg.home)
  // rev-parse prints 'HEAD' when detached, which the history rule allows; only a failed lookup comes back null.
  const branch = cwd !== null && needsBranch(git) ? await runQuiet($, ['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], cwd) : null
  const merge = ghPrMerge(seg)
  const prBase = merge === null ? undefined : await prBaseOf($, merge, cwd)
  const env = await envHits($, [...seg.argv, ...seg.redirects], real.paths, seg.cwd ?? sessionCwd, cfg.home)
  return { seg, git, cwd, real, branch, prBase, env }
}

/** Gathers the facts a tool call needs and asks the pure rules; null when the call may run. */
async function check($: EngineInterface, e: ToolCallInput, o: Options): Promise<Deny | null> {
  const input = e as unknown as Record<string, unknown>
  const tool = String(e.tool)
  const cwd = await $.session.cwd()
  const held = await read($, consents)
  const cfg = await configFor($, o)
  if (tool === 'Bash') {
    const segs = parseBash(String(input.command ?? ''), cwd, cfg.home)
    return decide({ kind: 'bash', segments: await Promise.all(segs.map(seg => segmentFacts($, seg, cwd, cfg))) }, held, cfg)
  }
  const targets = toolTargets(tool, input, cwd, cfg.home)
  if (targets === null) return null
  const real = await realTargets($, targets, cwd, cfg.home)
  // Only a write landing on settings.json needs its current text, to see whether enabledPlugins changes.
  const isSettings = real.writes.some(p => zoneOf(p, cfg) === 'settings')
  const before = isSettings ? await $.fs.read(cfg.settingsFile).catch(() => null) : null
  const edit = { before, content: input.content, old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }
  // The path fields plus Grep's glob; never Grep's pattern, which searches text and names no file.
  const env = await envHits($, [input.file_path, input.notebook_path, input.path, input.glob], real.paths, cwd, cfg.home)
  return decide({ kind: 'file', real, edit, env }, held, cfg)
}

/** One-line description of a denied call for the /guardrails log. */
function summaryOf(e: ToolCallInput): string {
  const input = e as unknown as Record<string, unknown>
  const named = [input.command, input.file_path, input.notebook_path, input.path, input.pattern].find(v => typeof v === 'string')
  return String(named ?? e.tool).slice(0, 160)
}

/** Handles `/consent`: list for anyone, grant or revoke only when typed at the prompt. */
async function runConsent($: EngineInterface, args: string, isTyped: boolean, o: Options): Promise<{ text: string }> {
  const action = parseConsent(args, gatesOf(o))
  if (action.kind === 'invalid') return { text: action.text }
  if (action.kind === 'list') return { text: describeConsents(await read($, consents)) }
  // The engine stamps origin: a plugin's $.command.run reads kind 'plugin', so the model cannot forge this.
  if (!isTyped) return { text: refusalOf(o.ownerName) }
  const held = await update($, consents, current => applyConsent(current, action, Date.now()))
  $.ui.status(statusText(held))
  const verb = action.kind === 'grant' ? 'granted' : 'revoked'
  return { text: `consent ${verb} for ${action.gate}${action.kind === 'grant' ? ' (this session)' : ''}` }
}

/** Reads the options once per load (a change in /config reloads the module), then hooks the session, both commands and every tool call. */
export const register: Register = (on, options) => {
  const o = parseOptions(options)

  on('session.start', async ($, e, next) => {
    await resetState($)
    await $.command.register({
      name: 'consent',
      description: 'Grant, revoke or list guardrails consent for this session',
      argumentHint: '<gate> | revoke <gate> | list',
    })
    await $.command.register({ name: 'guardrails', description: 'Show active guardrails consents and recent denials' })
    return next(e)
  })

  // A /clear ends the session with no new session.start, so consent is dropped here too.
  on('session.end', async ($, e, next) => {
    await resetState($)
    return next(e)
  })

  on('command.run', { command: 'consent' }, ($, e) => runConsent($, e.args, isUserTyped(e.origin), o))
  on('command.run', { command: 'guardrails' }, async $ => ({
    text: describeGuardrails(await read($, consents), await read($, denials)),
  }))

  // One hook for every tool, no matcher: check() picks what each tool touches. Subagent calls arrive here too (agentId set).
  // The .catch denies when check throws and on every re-entry, where $ calls reject and nothing can be resolved.
  on('tool.call', async ($, e, next) => {
    const verdict = await check($, e, o)
    if (verdict === null) return next(e)
    await recordDenial($, String(e.tool), verdict.rule, summaryOf(e))
    return { deny: verdict.deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: CHECK_FAILED }))
}
