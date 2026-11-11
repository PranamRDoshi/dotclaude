/** Draws the timeline pane's MCP block and the worktree list: one header, then numbered worktrees grouped by repo, each with a tree of labelled details that wrap and a Remove button on a remove verdict. */
import type { Elements } from 'claude-code'

import { shortName } from './mcp'
import type { McpStatus, Row, Scan } from './types'

// Every surface's table carries these four with the same props.
type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

// One detail line: a dim label, then the value with an optional theme color, after an optional link and before an optional button.
type Piece = {
  label: string; text: string; color?: string; link?: { href: string; label: string }
  button?: { key: string; label: string; onPress: () => unknown }
}

// Wrap, never truncate, so no width cuts a name or a status. Fits the longest label, "verdict".
const LABEL_WIDTH = 8
// Check states worth a color; pass and the rest stay plain.
const STATE_COLOR: Record<string, string> = { fail: 'error', errored: 'error', pending: 'warning', running: 'warning' }
// One accent per repo, its name and its worktrees' numbers and names. Theme keys, so they follow
// the person's theme, and none of success/warning/error, which stay for status.
// ponytail: picked by group order, so a repo's accent shifts when an earlier repo's last worktree goes.
const ACCENTS = ['claude', 'ide', 'planMode', 'autoAccept', 'suggestion']

/** The row's marker: ! needs you, + safe to remove, ? unknown; none when the row is fine. */
function mark(row: Row): { text: string; color: string } | undefined {
  if (row.verdict === 'remove') return { text: '+', color: 'success' }
  if (row.verdict === 'unknown') return { text: '?', color: 'subtle' }
  if (row.dirty > 0 || (typeof row.unpushed === 'number' && row.unpushed > 0)) return { text: '!', color: 'warning' }
  return undefined
}

/** Local git state, only the parts that need attention. */
function localPieces(row: Row): Piece[] {
  const out: Piece[] = []
  if (row.dirty > 0) out.push({ label: 'local', text: `${row.dirty} dirty`, color: 'warning' })
  if (typeof row.unpushed === 'number' && row.unpushed > 0) out.push({ label: 'local', text: `${row.unpushed} unpushed`, color: 'warning' })
  if (row.unpushed === 'DETACHED') out.push({ label: 'local', text: 'detached' })
  // A merged PR's remote branch is gone by design, so "no remote" only matters on a row being kept.
  if (row.unpushed === 'NO_REMOTE' && row.verdict !== 'remove') out.push({ label: 'local', text: 'no remote' })
  return out
}

/** Every detail under a worktree: its PR, an open PR's checks, local state, then the verdict where it adds something. */
function statusPieces(row: Row, onRemove: (row: Row) => unknown): Piece[] {
  // Skipped rows show their name and nothing else.
  if (row.skipped) return []
  if (row.error) return [{ label: 'error', text: row.error, color: 'subtle' }]
  const out: Piece[] = []
  const pr = row.pr
  // The base branch is left to the PR itself.
  if (pr) out.push({ label: 'pr', text: pr.isDraft ? 'draft' : pr.state.toLowerCase(), link: { href: pr.url, label: `#${pr.number}` } })
  // The review line shows only once the configured check exists; with no reviewCheck it is always none.
  if (pr?.state === 'OPEN') {
    if (pr.ci !== 'none') out.push({ label: 'ci', text: pr.ci, color: STATE_COLOR[pr.ci] })
    if (pr.review !== 'none') out.push({ label: 'review', text: pr.review, color: STATE_COLOR[pr.review] })
  }
  out.push(...localPieces(row))
  // One press removes, only on a remove verdict; the remove command can still refuse unsaved work.
  if (row.verdict === 'remove') {
    const button = { key: `remove:${row.name}`, label: 'Remove', onPress: () => onRemove(row) }
    out.push({ label: 'verdict', text: 'remove', color: 'success', button })
  }
  // An unknown verdict on a row without an error is a gh failure, and the reason names it.
  else if (row.verdict === 'unknown') out.push({ label: 'gh', text: row.reason, color: 'subtle' })
  else if (!pr && out.length === 0) out.push({ label: 'pr', text: 'none', color: 'subtle' })
  return out
}

/** One detail as a tree branch: connector and padded label dim, then the value, which wraps. */
function detailLine(el: El, row: Row, p: Piece, i: number, isLast: boolean) {
  const { Box, Button, Link, Text } = el
  return (
    <Box key={`detail:${row.name}:${i}`} flexDirection="row">
      <Text dimColor>{`${isLast ? '└' : '├'} ${p.label.padEnd(LABEL_WIDTH)}`}</Text>
      <Box flexGrow={1} flexDirection="row" gap={1}>
        {p.link && <Link href={p.link.href} label={p.link.label} />}
        <Text color={p.color} wrap="wrap">{p.text}</Text>
        {p.button && <Button key={p.button.key} label={p.button.label} onPress={p.button.onPress} />}
      </Box>
    </Box>
  )
}

/** One worktree: its number, marker and bold slug in the repo's accent, then its details hung under the number. */
function rowBlock(el: El, row: Row, n: number, numWidth: number, accent: string, onRemove: (row: Row) => unknown) {
  const { Box, Text } = el
  const m = mark(row)
  const num = `${String(n).padStart(numWidth)}.`
  const pieces = statusPieces(row, onRemove)
  return (
    <Box key={`row:${row.name}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={accent}>{num}</Text>
        {m && <Text color={m.color} bold>{m.text}</Text>}
        <Text bold color={accent} wrap="wrap">{row.slug}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={num.length + 1}>
        {pieces.map((p, i) => detailLine(el, row, p, i, i === pieces.length - 1))}
      </Box>
    </Box>
  )
}

/** Rows grouped by repo in scan order; a folder git does not know groups under "other". */
function groups(rows: Row[]): [string, Row[]][] {
  const byRepo = new Map<string, Row[]>()
  for (const row of rows) {
    const repo = row.repo || 'other'
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), row])
  }
  return [...byRepo]
}

/** One repo after a blank line: bold name in its accent with a worktree count, then its rows numbered from `first`. */
function repoBlock(el: El, repo: string, rows: Row[], accent: string, first: number, numWidth: number, onRemove: (row: Row) => unknown) {
  const { Box, Text } = el
  return (
    <Box key={`repo:${repo}`} flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2}>
        <Text bold color={accent}>{repo}</Text>
        <Text dimColor>{String(rows.length)}</Text>
        {rows.every(row => row.skipped) && <Text dimColor>skipped</Text>}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {rows.map((row, i) => rowBlock(el, row, first + i, numWidth, accent, onRemove))}
      </Box>
    </Box>
  )
}

/** The header line: counts, scan time, gh health and the Refresh button. */
function header(el: El, scan: Scan, onRefresh: () => unknown) {
  const { Box, Button, Text } = el
  const removable = scan.rows.filter(row => row.verdict === 'remove').length
  const time = scan.scannedAt ? new Date(scan.scannedAt).toTimeString().slice(0, 5) : 'never'
  const when = scan.status === 'scanning' ? 'scanning...' : scan.status === 'error' ? 'scan failed' : time
  return (
    <Box flexDirection="row" gap={2}>
      <Text bold>inflight</Text>
      <Box flexGrow={1}>
        <Text dimColor wrap="wrap">{`${scan.rows.length} wt · ${removable} to remove · ${when} · gh ${scan.ghError ? 'failed' : 'ok'}`}</Text>
      </Box>
      <Button key="refresh" label="Refresh" hotkey="r" onPress={onRefresh} />
    </Box>
  )
}

/**
 * The MCP block: a count line, a red row per configured server that never connected, a yellow row per non-claude.ai
 * server waiting on a sign-in, the connected names as one wrapping line, and the unsigned claude.ai connectors as a count.
 */
export function mcpTree(el: El, status: McpStatus) {
  const { Box, Text } = el
  const of = (state: string) => status.servers.filter(s => s.state === state)
  const connected = of('connected')
  const down = of('down')
  // Unsigned claude.ai connectors are mostly unused ones, so one dim line, not a yellow row each.
  const auth = of('auth').filter(s => !s.isClaudeAi)
  const unsigned = of('auth').length - auth.length
  const counts = [`${connected.length} connected`, down.length > 0 && `${down.length} down`, auth.length > 0 && `${auth.length} need auth`]
  const summary = status.checkedAt === 0 ? 'checking...' : counts.filter(Boolean).join(', ')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text bold>MCP</Text>
        <Text color={down.length > 0 ? 'error' : undefined} dimColor={down.length === 0} wrap="wrap">{summary}</Text>
      </Box>
      {status.error && <Text color="subtle" wrap="wrap">{`check failed: ${status.error}`}</Text>}
      {down.map(s => <Text key={`mcp:${s.name}`} color="error" wrap="wrap">{`✗ ${s.name}  not connected`}</Text>)}
      {auth.map(s => <Text key={`mcp:${s.name}`} color="warning" wrap="wrap">{`! ${s.name}  needs auth`}</Text>)}
      {connected.length > 0 && (
        <Text wrap="wrap">
          {connected.map((s, i) => [i > 0 && '  ', <Text color="success">●</Text>, ` ${shortName(s)}`])}
        </Text>
      )}
      {unsigned > 0 && <Text dimColor wrap="wrap">{`○ ${unsigned} claude.ai connector${unsigned === 1 ? '' : 's'} not signed in`}</Text>}
    </Box>
  )
}

/** The whole list for a scan; every text wraps to the pane's width, so no width is needed here. */
export function paneTree(el: El, scan: Scan, onRefresh: () => unknown, onRemove: (row: Row) => unknown) {
  const { Box, Text } = el
  // Numbers run 1..N across repos, so "remove 3" names one worktree; padded so names line up past 9.
  const numWidth = String(scan.rows.length).length
  let first = 1
  return (
    <Box flexDirection="column">
      {header(el, scan, onRefresh)}
      {scan.ghError && <Text color="error" wrap="wrap">{`gh: ${scan.ghError}`}</Text>}
      {scan.rows.length === 0 && <Text dimColor wrap="wrap">{scan.scannedAt ? (scan.emptyText ?? 'No worktrees.') : 'Not scanned yet.'}</Text>}
      {groups(scan.rows).map(([repo, rows], i) => {
        const block = repoBlock(el, repo, rows, ACCENTS[i % ACCENTS.length]!, first, numWidth, onRemove)
        first += rows.length
        return block
      })}
    </Box>
  )
}
