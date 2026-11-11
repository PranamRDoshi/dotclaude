/** Pure guardrails rules: lists what a tool call touches, then decides from facts the hook gathered (real paths, current branch, PR base) and the options. */
import { commandName, resolvePath as resolveLexical, searchRoots } from './bash'
import type { Consents } from './consent'
import type { GitIntent, Segment } from './types'
import { type Config, normalizePath, topFolder, zoneOf } from './zones'

export type Deny = { rule: string; deny: string }

/** What a call touches: every path, the subset it writes, and the roots of a recursive search. */
export type Targets = { paths: string[]; writes: string[]; roots: string[] }

/** One Bash segment with its targets made real by the hook, plus the git and gh lookups it needed. */
export type SegmentFacts = {
  seg: Segment
  git: GitIntent | null
  /** Real path of seg.cwd; null when unknown or the directory does not exist (that cd fails, so the shell stays elsewhere). */
  cwd: string | null
  real: Targets
  /** `git rev-parse --abbrev-ref HEAD` in cwd ('HEAD' when detached), looked up only when needsBranch; null when the lookup failed. */
  branch: string | null
  /** Only for `gh pr merge`: the PR's base branch, null when the lookup failed. */
  prBase?: string | null
  /** Env files the segment names (envHits in the hook). */
  env: string[]
}

/** An Edit or Write's own fields plus settings.json's current text, to tell whether enabledPlugins changes. */
export type FileEdit = { before: string | null; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }

export type DecideInput = { kind: 'bash'; segments: SegmentFacts[] } | { kind: 'file'; real: Targets; edit: FileEdit; env: string[] }

const TAIL = ' Do not retry with another spelling or path.'
// .env, .env.* and *.env files are never read, written or named while envFiles is "block"; the agent gets no override.
// Templates pass: they hold no secrets and list the keys a service needs.
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])
// An env-file name anywhere in a word: a path, a glob (*.env), an option value (--env-file=x), code (open('.env')).
// The lookbehind skips regex escapes such as process\.env, which name no file.
const ENV_TOKEN = /(?<![\\\w])[\w./~-]*\.env(?:\.[\w.-]+)?(?!\w)/gi
const FILE_KEYS: Record<string, string> = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', Grep: 'path', Glob: 'path' }
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// Read allow-list for Bash outside git: these may run in a read-only repo and under an unknown cwd. Kept short on purpose.
const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'ls', 'tree', 'file', 'stat', 'du', 'grep', 'egrep', 'fgrep', 'rg', 'diff',
  'cmp', 'jq', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[', 'realpath', 'readlink', 'basename', 'dirname', 'which',
  'cd', 'pushd', 'popd', 'sleep',
])
const READ_SUBS: Record<string, string[]> = { go: ['test', 'vet', 'list', 'doc', 'env', 'version'] }
const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/
// Absolute or ~ paths inside a longer word: `--git-dir=/x`, `open('/x')`.
const EMBEDDED_PATH = /(?:^|[\s='"(,:])((?:~|\/)[^\s'"`;|&<>(),]*)/g

// Fail closed: a write whose directory cannot be known statically is refused, a plain read passes.
const UNKNOWN_CWD = denyOf('unknown-cwd', 'could not tell which directory this command runs in. Split it, or use absolute paths and git -C <dir>.')

/** Builds a deny in the agreed wording: rule clause, next step, no-retry tail. */
function denyOf(rule: string, text: string): Deny {
  return { rule, deny: `guardrails: ${text}${TAIL}` }
}

/** Deny for a consent-gated step the person can unlock with /consent. */
function gateDeny(gate: string, what: string, cfg: Config): Deny {
  return denyOf(gate, `${what}. Ask ${cfg.ownerName} to run /consent ${gate}, then retry.`)
}

/** The protected branches as prose for deny messages: "main, master or develop". */
function branchText(cfg: Config): string {
  const list = cfg.protectedBranches
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`
}

/** Lexical paths a word names: itself (relative to cwd) and any absolute path inside it, cut before a glob or expansion. */
function wordPaths(cwd: string | null, word: string, home: string): string[] {
  const out: string[] = []
  for (const w of [word, ...[...word.matchAll(EMBEDDED_PATH)].map(m => m[1])]) {
    // ponytail: `~/code/ops/*.yaml` keeps its static head; `$X/...` and `~/code/*/x` stay accepted gaps (see README).
    const head = w.split(/[$`*?[]/)[0]
    const p = head === '' ? null : resolveLexical(cwd, head, home)
    if (p !== null) out.push(p)
  }
  return out
}

/** Lexical targets of a Bash segment: cwd, every non-option word (relative ones too, so `cd ~/code && cat ops/x` hits), redirects. */
export function segmentTargets(seg: Segment, home: string): Targets {
  const words = seg.argv.flatMap(a => (!a.startsWith('-') ? [a] : a.includes('=') ? [a.slice(a.indexOf('=') + 1)] : []))
  const writes = seg.redirects.flatMap(r => wordPaths(seg.cwd, r, home))
  const paths = [...words.flatMap(w => wordPaths(seg.cwd, w, home)), ...writes, ...(seg.cwd === null ? [] : [seg.cwd])]
  const roots = (searchRoots(seg, home) ?? []).filter((r): r is string => r !== null)
  return { paths: [...new Set(paths)], writes, roots }
}

/** Lexical targets of a file tool; null for tools guardrails does not cover (MCP tools included). */
export function toolTargets(tool: string, input: Record<string, unknown>, cwd: string, home: string): Targets | null {
  const key = FILE_KEYS[tool]
  if (key === undefined) return null
  const given = input[key]
  const path = normalizePath(typeof given === 'string' && given !== '' ? given : cwd, cwd, home)
  if (tool === 'Glob') {
    // The pattern's static directory is where the walk really starts: `api/**` under the root only walks api.
    const head = String(input.pattern ?? '').split(/[*?[{]/)[0]
    const root = normalizePath(head.slice(0, head.lastIndexOf('/') + 1) || '.', path, home)
    return { paths: [path, root], writes: [], roots: [root] }
  }
  return { paths: [path], writes: WRITE_TOOLS.has(tool) ? [path] : [], roots: tool === 'Grep' ? [path] : [] }
}

/** True for a segment that only reads: a git read, or an allow-listed command used without its writing flags. */
function isReadSegment(seg: Segment, git: GitIntent | null): boolean {
  if (git !== null) return git.kind === 'read'
  const name = commandName(seg.argv)
  const args = seg.argv.slice(1)
  if (name === 'find') return !args.some(a => FIND_WRITES.test(a))
  if (name === 'sed') return !args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))
  if (name === 'claude') return args[0] === 'plugin' && ['validate', 'test', 'list'].includes(args[1] ?? '')
  if (name === 'gh') return ['pr', 'issue'].includes(args[0] ?? '') && ['view', 'list', 'diff', 'checks', 'status'].includes(args[1] ?? '')
  return READ_COMMANDS.has(name) || (READ_SUBS[name]?.includes(args[0] ?? '') ?? false)
}

/** Env-file kind of a path's last segment (git's HEAD:.env counts): 'dot' for .env and .env.*, 'suffix' for *.env, else null. */
export function envKind(path: string): 'dot' | 'suffix' | null {
  const name = path.toLowerCase().split(/[/:]/).pop() ?? ''
  if (ENV_TEMPLATES.has(name)) return null
  if (name === '.env' || name.startsWith('.env.')) return 'dot'
  return name.endsWith('.env') ? 'suffix' : null
}

/** Env-file names a string mentions, templates left out; the hook then drops directories and *.env names that are not files. */
export function envTokens(text: string): string[] {
  return [...text.matchAll(ENV_TOKEN)].map(m => m[0]).filter(t => envKind(t) !== null)
}

/** No consent gate: denies on the first env file a call names, unless envFiles is "allow". */
function envDeny(hits: string[], cfg: Config): Deny | null {
  const name = hits[0]?.split('/').pop()
  if (name === undefined || !cfg.blockEnvFiles) return null
  // A message that only mentions .env trips the same check, so point at the file-based flags.
  return denyOf('env-file', `${name} is a .env file, and reading, writing or naming .env files is blocked, no override exists. Ask ${cfg.ownerName} for the value you need. If .env only appears in a commit or PR message, pass the text with -F or --body-file.`)
}

/** True when `root` is the workspace root or one of its ancestors, so a recursive walk from it enters every repo. */
function coversRoot(root: string, workspace: string): boolean {
  const r = root.toLowerCase().replace(/\/+$/, '')
  const w = workspace.toLowerCase().replace(/\/+$/, '')
  return r === w || r === '' || w.startsWith(`${r}/`)
}

/** Read gates on every touched path, then recursive searches over the workspace root while any gate is locked. */
function readDeny(real: Targets, held: Consents, cfg: Config): Deny | null {
  if (cfg.root === null) return null
  for (const p of real.paths) {
    // By folder, not zone: a folder that is both read-only and consent-gated still needs consent to read.
    const top = topFolder(p, cfg)
    if (top !== null && cfg.consentRepos.includes(top) && held[top] === undefined) return gateDeny(top, `${top} is consent-gated this session`, cfg)
  }
  const isLocked = cfg.consentRepos.some(g => held[g] === undefined)
  const root = cfg.root
  if (isLocked && real.roots.some(r => coversRoot(r, root))) {
    return denyOf('recursive-search', `recursive searches rooted at ${root} or above are blocked while a consent-gated repo is locked. Narrow the path to one repo folder under ${root}, then retry.`)
  }
  return null
}

/** True when an Edit or Write of settings.json would change enabledPlugins; unreadable or unparsable text counts as a change. */
function touchesPlugins(edit: FileEdit): boolean {
  const { before, content, old_string: from, new_string: to } = edit
  if (before === null) return true
  let after: string | null = typeof content === 'string' ? content : null
  if (after === null && typeof from === 'string') {
    const into = typeof to === 'string' ? to : ''
    after = edit.replace_all === true ? before.split(from).join(into) : before.replace(from, () => into)
  }
  if (after === null) return true
  try {
    return JSON.stringify(JSON.parse(before).enabledPlugins) !== JSON.stringify(JSON.parse(after).enabledPlugins)
  } catch {
    return true
  }
}

/** Written paths: read-only repos never; this plugin, installed plugins and protected paths only with self-edit; settings only when enabledPlugins moves. */
function writeDeny(writes: string[], held: Consents, edit: FileEdit | null, cfg: Config): Deny | null {
  for (const p of writes) {
    const zone = zoneOf(p, cfg)
    if (zone === 'read-only') {
      return denyOf('read-only-repo', `${topFolder(p, cfg)} is read-only, no override exists. Report the needed change to ${cfg.ownerName} instead.`)
    }
    const isSelf = zone === 'self' || (zone === 'settings' && (edit === null || touchesPlugins(edit)))
    if (isSelf && held['self-edit'] === undefined) {
      return gateDeny('self-edit', 'the guardrails plugin, installed plugins, enabledPlugins and protected paths are locked', cfg)
    }
  }
  return null
}

/** History-writing intents: commit-creating subcommands (ff-only merge and pull excluded, a sync runs them) and reset. */
function isHistoryWrite(g: GitIntent): boolean {
  return (g.kind === 'commit' && !g.isFfOnly) || g.sub === 'reset'
}

/** True when the hook must look up the current branch: a 'HEAD' target, or a history write. */
export function needsBranch(g: GitIntent | null): boolean {
  return g !== null && (g.targets.includes('HEAD') || isHistoryWrite(g))
}

/** No consent gate: no history writes while a protected branch is checked out, and no forced branch create onto one. */
function historyDeny(g: GitIntent, branch: string | null, cfg: Config): Deny | null {
  // An emptied protectedBranches list turns the rule off, failed branch lookups included.
  if (cfg.protectedBranches.length === 0) return null
  const isProtected = (b: string) => cfg.protectedBranches.includes(b)
  const onProtected = isHistoryWrite(g) && (branch === null || isProtected(branch))
  const forcedOnto = g.kind === 'branch-create' && g.isForce && g.targets.some(isProtected)
  if (!onProtected && !forcedOnto) return null
  // A failed lookup fails closed here only; a detached HEAD reads 'HEAD' and passes.
  const list = branchText(cfg)
  const what = branch === null && !forcedOnto ? `could not tell the current branch, and local history writes on ${list} are blocked` : `local history writes on ${list} are blocked, no override exists`
  return denyOf('protected-branch-history', `${what}. Create a work branch first.`)
}

/** Protected-branch, branch-lock, write-gate and primary-commit rules for one git segment whose cwd is known. */
function gitDeny(f: SegmentFacts, held: Consents, cfg: Config): Deny | null {
  const g = f.git
  if (g === null || g.kind === 'read' || f.cwd === null) return null
  const targets = g.targets.map(t => (t === 'HEAD' ? f.branch : t))
  const isProtected = (t: string | null) => t !== null && cfg.protectedBranches.includes(t)
  // With no protected branch there is nothing a push or delete could hit, so an unknown target passes too.
  const hasProtected = cfg.protectedBranches.length > 0
  if (hasProtected && g.kind === 'push' && targets.some(t => t === null)) {
    return denyOf('push-unknown-branch', 'could not tell which branch this push targets. Name it explicitly, as in git push origin <branch>.')
  }
  if (hasProtected && g.kind === 'push' && targets.some(t => t === '*' || isProtected(t))) {
    return denyOf('push-protected', `direct pushes to ${branchText(cfg)} (incl. force, deletes and --all) are blocked, no override exists. Push a feature branch and open a PR instead.`)
  }
  if (hasProtected && g.kind === 'branch-delete' && targets.some(t => t === null || isProtected(t))) {
    return denyOf('branch-delete-protected', `deleting or renaming ${branchText(cfg)} locally is blocked, no override exists. Leave that branch alone.`)
  }
  // History writes run before the zone gates so /consent primary-commit can never unlock them.
  const history = historyDeny(g, f.branch, cfg)
  if (history !== null) return history
  const top = topFolder(f.cwd, cfg)
  const lock = top === null ? undefined : cfg.branchLocks.get(top)
  if (lock !== undefined && (g.kind === 'branch-create' || g.kind === 'checkout') && targets.some(t => t !== lock)) {
    return denyOf('branch-lock', `${top} is locked to the ${lock} branch, no override exists. Stay on ${lock} and ask ${cfg.ownerName} if another branch is needed.`)
  }
  // ff-only merge and pull are what a sync runs to update a checkout; they create no commit.
  const isCommit = g.kind === 'commit' && !g.isFfOnly
  if ((isCommit || g.kind === 'push') && top !== null && cfg.consentRepos.includes(top) && held[`${top}-write`] === undefined) {
    return gateDeny(`${top}-write`, `commits and pushes in ${top} need their own consent`, cfg)
  }
  if (isCommit && cfg.blockPrimaryCommits && zoneOf(f.cwd, cfg) === 'primary' && held['primary-commit'] === undefined) {
    return denyOf('primary-commit', `commits in a primary checkout are blocked. Create a worktree under ${cfg.root}/${cfg.worktreesDir} first, or ask ${cfg.ownerName} for /consent primary-commit.`)
  }
  return null
}

/** Blocked commands, env files, plugin disable, read gates, unknown cwd, writes, PR merges and git rules for one Bash segment; the first deny wins. */
function segmentDeny(f: SegmentFacts, held: Consents, cfg: Config): Deny | null {
  const { seg, git } = f
  const argv = seg.argv
  const name = commandName(argv)
  // Lowercased: on a case-insensitive volume `TERRAFORM` runs the same binary as `terraform`.
  if (cfg.blockedCommands.includes(name.toLowerCase())) {
    return denyOf('blocked-command', `${name} is on the blocked command list and must never be run. Ask ${cfg.ownerName} to run the command instead.`)
  }
  const env = envDeny(f.env, cfg)
  if (env !== null) return env
  const isPluginOff = name === 'claude' && argv.includes('plugin') && argv.some(a => /^(disable|uninstall|remove|rm)$/.test(a))
  if (isPluginOff && argv.some(a => a.includes('guardrails')) && held['self-edit'] === undefined) {
    return gateDeny('self-edit', 'disabling or removing the guardrails plugin is protected', cfg)
  }
  const isRead = isReadSegment(seg, git)
  const unknown = readDeny(f.real, held, cfg) ?? (!isRead && (f.cwd === null || git?.repoDir === null) ? UNKNOWN_CWD : null)
  if (unknown !== null) return unknown
  // A non-read command may write anything it names; a read writes only its redirect targets.
  // git add and commit leave the plugin's files as they are, so committing a repo that holds it needs no self-edit.
  const touched = isRead ? f.real.writes : f.real.paths
  const selfTouched = isRead || git?.sub === 'add' || git?.sub === 'commit' ? f.real.writes : f.real.paths
  const readOnly = touched.filter(p => zoneOf(p, cfg) === 'read-only')
  const written = writeDeny(readOnly, held, null, cfg) ?? writeDeny(selfTouched, held, null, cfg)
  if (written !== null) return written
  if (f.prBase === null && cfg.protectedBranches.length > 0) return denyOf('pr-merge-unknown-base', `could not look up this PR's base branch. Pass the PR number, or ask ${cfg.ownerName} to merge it.`)
  if (f.prBase !== undefined && cfg.protectedBranches.includes(f.prBase)) {
    return denyOf('pr-merge-protected', `merging a PR into ${f.prBase} is blocked, no override exists. Ask ${cfg.ownerName} to merge it.`)
  }
  return gitDeny(f, held, cfg)
}

/** The single rules entry point: the first deny for this call, or null to let it run. */
export function decide(input: DecideInput, held: Consents, cfg: Config): Deny | null {
  if (input.kind === 'file') return envDeny(input.env, cfg) ?? readDeny(input.real, held, cfg) ?? writeDeny(input.real.writes, held, input.edit, cfg)
  for (const f of input.segments) {
    const d = segmentDeny(f, held, cfg)
    if (d !== null) return d
  }
  return null
}
