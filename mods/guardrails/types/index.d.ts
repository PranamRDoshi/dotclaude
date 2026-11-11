// Guardrails' PluginState contract: the session-scoped consents and the denial log.

/**
 * A consent gate name: 'self-edit', 'primary-commit', or '<folder>' and '<folder>-write' for each
 * consentRepos entry. The set comes from the install-time options, so the type is any string and
 * /consent checks names against the list at run time.
 */
export type GuardrailsGate = string

export type GuardrailsDenial = { at: number; tool: string; rule: string; summary: string }

declare module 'claude-code' {
  interface PluginState {
    guardrails: { consents: Partial<Record<GuardrailsGate, number>>; denials: GuardrailsDenial[] }
  }
}
