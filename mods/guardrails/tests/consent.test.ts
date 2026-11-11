/** Consent tests: gate list, pure parsing and origin checks, plus /consent and /guardrails run through the engine. */
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { applyConsent, gatesOf, isUserTyped, parseConsent, refusalOf } from '../src/consent'

const PRESENTATION = { isFullscreen: false, columns: 80 }
const OPTS = { workspaceRoot: '~/code', consentRepos: 'ops,archive' }
const GATES = gatesOf({ consentRepos: ['ops', 'archive'] })

/** Answers the engine calls the plugin makes at session start and on /consent, and records status lines. */
function stubEngine(on: On): (string | undefined)[] {
  const statuses: (string | undefined)[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return statuses
}

describe('pure helpers', () => {
  test('only composer counts as typed by the person', () => {
    expect(isUserTyped({ kind: 'composer' })).toBe(true)
    expect(isUserTyped({ kind: 'bridge' })).toBe(false)
    expect(isUserTyped({ kind: 'sdk' })).toBe(false)
    expect(isUserTyped({ kind: 'plugin', name: 'guardrails' } as never)).toBe(false)
  })

  test('the gate set is self-edit, primary-commit, then a read and a write gate per consent-gated repo', () => {
    expect(GATES).toEqual(['self-edit', 'primary-commit', 'ops', 'ops-write', 'archive', 'archive-write'])
    expect(gatesOf({ consentRepos: [] })).toEqual(['self-edit', 'primary-commit'])
  })

  test('parses list, grant, revoke and rejects unknown gates', () => {
    expect(parseConsent('', GATES)).toEqual({ kind: 'list' })
    expect(parseConsent('  list ', GATES)).toEqual({ kind: 'list' })
    expect(parseConsent('archive', GATES)).toEqual({ kind: 'grant', gate: 'archive' })
    expect(parseConsent('Ops-Write', GATES)).toEqual({ kind: 'grant', gate: 'ops-write' })
    expect(parseConsent('revoke ops', GATES)).toEqual({ kind: 'revoke', gate: 'ops' })
    expect(parseConsent('revoke', GATES).kind).toBe('invalid')
    expect(parseConsent('vendor-sdk', GATES).kind).toBe('invalid')
  })

  test('grant stamps the gate, revoke removes it, input untouched', () => {
    const held = {}
    const granted = applyConsent(held, { kind: 'grant', gate: 'archive' }, 42)
    expect(granted).toEqual({ archive: 42 })
    expect(held).toEqual({})
    expect(applyConsent(granted, { kind: 'revoke', gate: 'archive' }, 43)).toEqual({})
  })
})

describe('commands through the engine', () => {
  test('an unknown gate lists the valid ones and grants nothing', { options: OPTS }, async ($, on) => {
    stubEngine(on)
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    const ran = await $.command.run({ command: 'consent', args: 'nope', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(ran.text).toBe('guardrails: unknown gate "nope". Gates: self-edit, primary-commit, ops, ops-write, archive, archive-write')
    expect((await $.command.run({ command: 'consent', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })).text).toBe('consents: none')
  })

  test('with no options only the two built-in gates exist', async ($, on) => {
    stubEngine(on)
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    const ran = await $.command.run({ command: 'consent', args: 'ops', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(ran.text).toContain('Gates: self-edit, primary-commit')
  })

  test('a plugin-origin /consent grants nothing', { options: OPTS }, async ($, on) => {
    stubEngine(on)
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    const ran = await $.command.run({
      command: 'consent',
      args: 'archive',
      origin: { kind: 'plugin', name: 'other' } as never,
      presentation: PRESENTATION,
    })
    expect(ran.text).toBe(refusalOf('the user'))
    const report = await $.command.run({ command: 'guardrails', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(report.text).toContain('consents: none')
    expect(report.text).toContain('denials: none')
  })

  test('a bridge-origin /consent grants nothing, and the refusal names ownerName', { options: { ...OPTS, ownerName: 'Sam' } }, async ($, on) => {
    stubEngine(on)
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    const ran = await $.command.run({ command: 'consent', args: 'archive', origin: { kind: 'bridge' }, presentation: PRESENTATION })
    expect(ran.text).toBe('guardrails: only Sam typing at the prompt can grant or revoke consent. Nothing changed.')
  })

  test('composer grant, list, revoke, and session.end clears', { options: OPTS }, async ($, on) => {
    const statuses = stubEngine(on)
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    const typed = { origin: { kind: 'composer' as const }, presentation: PRESENTATION }
    const granted = await $.command.run({ command: 'consent', args: 'ops', ...typed })
    expect(granted.text).toBe('consent granted for ops (this session)')
    expect(statuses.at(-1)).toBe('consent: ops')
    expect((await $.command.run({ command: 'consent', args: 'list', ...typed })).text).toContain('ops since')
    await $.command.run({ command: 'consent', args: 'revoke ops', ...typed })
    expect(statuses.at(-1)).toBe(undefined)
    await $.command.run({ command: 'consent', args: 'archive', ...typed })
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} as never })
    expect((await $.command.run({ command: 'consent', args: '', ...typed })).text).toBe('consents: none')
  })
})
