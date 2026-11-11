/**
 * State contract of the timeline mod: the session's milestones and the one
 * memory suggestion the Reflect band is showing. Both live in `$.state` so a
 * hot reload or a compaction keeps them.
 */

/** The milestone allowlist. Outcomes, not actions. */
export type TimelineKind =
  | 'pr-raised'
  | 'workflow-triggered'
  | 'workflow-passed'
  | 'workflow-failed'
  | 'deploy-failed'
  | 'retry'
  | 'verification-done'
  | 'tests-updated'
  | 'other'
  /** The fallback: no listed kind fits, or the call failed. */
  | 'turn'

/** Area of work a row belongs to; it picks the kind word's color. */
export type TimelineArea = 'hotfix' | 'deploy' | 'infra' | 'debug' | 'ci' | 'review'

/** The auto-memory types a suggestion may carry. */
export type TimelineMemoryType = 'user' | 'feedback' | 'project' | 'reference'

/**
 * One timeline row: when it landed, its kind, the outcome and a short ref.
 * `area` and `bold` came in 0.2.0 and are optional, so rows stored before it
 * still read under the same shape tag.
 */
export type TimelineEntry = {
  at: number
  kind: TimelineKind
  text: string
  ref: string
  turnId: string
  area?: TimelineArea
  /** Exact substrings of `text` drawn bold: PR numbers, repos, services, one critical fact. */
  bold?: string[]
}

/** The memory suggestion waiting for Save or Skip. */
export type TimelineSuggestion = { type: TimelineMemoryType; text: string }

declare module 'claude-code' {
  interface PluginState {
    timeline: {
      entries: Shaped<TimelineEntry[]>
      suggestion: Shaped<TimelineSuggestion | null>
      /** True once the pane has opened by itself this session; a reload keeps it. */
      autoOpened: boolean
    }
  }
}
