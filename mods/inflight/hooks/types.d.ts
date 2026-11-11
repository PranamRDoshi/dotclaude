/** Inflight's row and scan shapes, and the PluginState contract they live under. */

export type CiState = 'pass' | 'fail' | 'pending' | 'none'
export type ReviewState = 'pass' | 'fail' | 'errored' | 'running' | 'none'

export type Pr = {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  base: string
  url: string
  headOid: string
  ci: CiState
  review: ReviewState // the reviewCheck option's check; none when the option is empty
}

export type Row = {
  name: string // folder name, e.g. api--fix-login
  repo: string // from git's common dir, or the skipRepos prefix of the name
  slug: string // name without a leading `<repo>--`
  path: string
  mainRepo: string // the main worktree's folder, where the remove command runs; '' until git names it
  skipped: boolean // a skipRepos repo: name only, no further git and no gh
  error?: string // not a git worktree, or a failed git read; verdict unknown
  branch: string | null // null = detached HEAD or never read
  head: string
  dirty: number
  unpushed: number | 'NO_REMOTE' | 'DETACHED' // commits ahead of origin/<branch>, or why none can be counted
  lastCommitAt: string
  pr?: Pr
  verdict: 'remove' | 'keep' | 'unknown'
  reason: string
}

export type Scan = {
  status: 'idle' | 'scanning' | 'ok' | 'error'
  scannedAt: number
  rows: Row[]
  ghError?: string
  emptyText?: string // what the pane says with no rows: where it looked, or why it could not
}

export type McpServer = {
  name: string // as /mcp lists it, e.g. github or claude.ai Gmail
  state: 'connected' | 'auth' | 'down' // auth = only sign-in tools; down = configured, no tools
  isClaudeAi: boolean
}

export type McpStatus = {
  checkedAt: number // 0 until the first check
  servers: McpServer[]
  error?: string // the last check failed; servers are the previous check's
}

declare module 'claude-code' {
  interface PluginState {
    // worktrees, not the earlier key: a hot reload keeps state, and the earlier key's rows are the old shape.
    inflight: { worktrees: Scan; mcp: McpStatus }
  }
}
