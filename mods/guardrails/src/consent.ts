/** Consent gates for guardrails: the gate list the options define, and the pure parsing and text behind /consent and /guardrails. */
import type { PromptOrigin } from 'claude-code'
import type { GuardrailsDenial, GuardrailsGate } from '../types'
import type { Options } from './zones'

export type Consents = Partial<Record<GuardrailsGate, number>>
export type ConsentAction =
  | { kind: 'list' }
  | { kind: 'grant' | 'revoke'; gate: GuardrailsGate }
  | { kind: 'invalid'; text: string }

export const MAX_DENIALS = 50

/** The valid gates: self-edit and primary-commit always, then a read gate and a -write gate per consent-gated repo. */
export function gatesOf(o: Pick<Options, 'consentRepos'>): GuardrailsGate[] {
  return ['self-edit', 'primary-commit', ...o.consentRepos.flatMap(repo => [repo, `${repo}-write`])]
}

/** The answer to a /consent grant or revoke that the person did not type at the prompt. */
export function refusalOf(owner: string): string {
  return `guardrails: only ${owner} typing at the prompt can grant or revoke consent. Nothing changed.`
}

/** True only for the person's own Enter at the prompt; Remote Control (bridge) is ruled out too. */
export function isUserTyped(origin: PromptOrigin): boolean {
  return origin.kind === 'composer'
}

/** Parses `/consent` arguments against the valid gates: nothing or `list`, `<gate>`, or `revoke <gate>`. */
export function parseConsent(args: string, gates: readonly GuardrailsGate[]): ConsentAction {
  const [first = 'list', second] = args.trim().split(/\s+/).filter(Boolean)
  if (first === 'list') return { kind: 'list' }
  const isRevoke = first === 'revoke'
  // Gate names are lowercased folder names, so `/consent Ops` means the same as `/consent ops`.
  const gate = (isRevoke ? second : first)?.toLowerCase()
  if (gate === undefined || !gates.includes(gate)) {
    return { kind: 'invalid', text: `guardrails: unknown gate "${gate ?? ''}". Gates: ${gates.join(', ')}` }
  }
  return { kind: isRevoke ? 'revoke' : 'grant', gate }
}

/** Returns the consents after a grant (stamped now) or a revoke; never mutates its input. */
export function applyConsent(held: Consents, action: { kind: 'grant' | 'revoke'; gate: GuardrailsGate }, now: number): Consents {
  const copy = { ...held }
  if (action.kind === 'revoke') delete copy[action.gate]
  else copy[action.gate] = now
  return copy
}

/** Status-line text for the held gates, or undefined to clear the line. */
export function statusText(held: Consents): string | undefined {
  const gates = Object.keys(held)
  return gates.length === 0 ? undefined : `consent: ${gates.join(', ')}`
}

/** Lists the held gates with the time each was granted. */
export function describeConsents(held: Consents): string {
  const entries = Object.entries(held)
  if (entries.length === 0) return 'consents: none'
  return ['consents:', ...entries.map(([gate, at]) => `  ${gate} since ${new Date(at ?? 0).toISOString()}`)].join('\n')
}

/** The /guardrails report: active consents, then the denial log, newest last. */
export function describeGuardrails(held: Consents, list: readonly GuardrailsDenial[]): string {
  const lines = list.map(d => `  ${new Date(d.at).toISOString()} ${d.tool} ${d.rule}: ${d.summary}`)
  const denialText = lines.length === 0 ? 'denials: none' : [`denials (last ${MAX_DENIALS}):`, ...lines].join('\n')
  return `${describeConsents(held)}\n${denialText}`
}
