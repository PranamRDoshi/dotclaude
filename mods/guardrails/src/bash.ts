/** Quote-aware Bash splitter: turns a command string into segments with argv and effective cwd, plus small argv helpers for rules. */
import type { Segment } from './types'
import { normalizePath } from './zones'

/** How deep we follow nested `sh -c` / `eval` strings; deeper ones stay opaque argv. Four levels cost nothing over one. */
const MAX_DEPTH = 4

type Tok = { t: 'w'; v: string } | { t: 'o'; v: string } | { t: 's'; toks: Tok[] }
// home is the engine's HOME, threaded through so `~` and `$HOME` expand without a machine constant.
type Lexer = { s: string; i: number; toks: Tok[]; heredocs: { delim: string; tabs: boolean }[]; home: string }
type State = { cwd: string | null; depth: number; home: string }

// Digits before a redirect are fd numbers and get dropped; `&>` / `>|` / `>>` all mean "write to the next word".
const OP_RE = /\d*(?:>>|>\||>&|>|<<<|<<-|<<|<&|<)|&>>?|&&|\|\||\|&|[|;&]/y
const VAR_RE = /\$(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*|[0-9#?$!@*-]))?/y
const WORD_END = /[\s;&|<>()]/
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT_ALIAS = new Map([['>>', '>'], ['>|', '>'], ['&>', '>'], ['&>>', '>'], ['<&', '<'], ['<<<', '<']])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}'])
const PIPES = new Set(['|', '|&'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
// Wrapper -> options that take a separate value, and positional words to skip (timeout's duration).
const WRAPPERS = new Map<string, { opts: string[]; skip: number }>([
  ['env', { opts: ['-u', '-C'], skip: 0 }],
  ['command', { opts: [], skip: 0 }],
  ['nohup', { opts: [], skip: 0 }],
  ['time', { opts: ['-f', '-o'], skip: 0 }],
  ['sudo', { opts: ['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t'], skip: 0 }],
  ['xargs', { opts: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'], skip: 0 }],
  ['exec', { opts: ['-a'], skip: 0 }],
  ['nice', { opts: ['-n'], skip: 0 }],
  ['timeout', { opts: ['-s', '-k'], skip: 1 }],
])
const GIT_VALUE_OPTS = new Set(['-c', '--namespace', '--config-env', '--super-prefix'])
const GREP_SHORT = 'efmABCdD'
const GREP_LONG = ['--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context', '--include', '--exclude', '--exclude-dir', '--label', '--binary-files', '--devices', '--directories']
const RG_SHORT = 'efgmABCtTjMEr'
const RG_LONG = ['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add', '--max-count', '--context', '--after-context', '--before-context', '--max-depth', '--threads', '--replace', '--max-filesize', '--encoding', '--sort', '--sortr', '--colors', '--color', '--pre', '--pre-glob', '--path-separator']
const GH_VALUE_OPTS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'])

/** Splits a Bash command into segments with their effective cwd (null when unknown); `home` is what `~` and `$HOME` expand to. */
export function parseBash(command: string, cwd: string, home: string): Segment[] {
  const out: Segment[] = []
  build(lex(command, 0, false, home).toks, { cwd, depth: 0, home }, out)
  return out
}

/** Lexically resolves `p` against `base` (~, $HOME, ., ..); null for expansions, globs, ~user or a relative path on an unknown base. */
export function resolvePath(base: string | null, p: string, home: string): string | null {
  if (/[$`*?[]/.test(p) || /^~[^/]/.test(p)) return null
  if (base === null && !p.startsWith('/') && !p.startsWith('~')) return null
  return normalizePath(p, base ?? '/', home)
}

/** Basename of the command word, so `/usr/bin/git` and `git` compare equal. Rules use it for blockedCommands. */
export function commandName(argv: string[]): string {
  const p = argv[0] ?? ''
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Splits a git argv into its -C dirs, subcommand and args; null when argv is not git. */
export function splitGit(argv: string[]): { dirs: string[]; customRepo: boolean; sub: string | null; args: string[] } | null {
  if (commandName(argv) !== 'git') return null
  const dirs: string[] = []
  let customRepo = false
  let k = 1
  for (; k < argv.length && argv[k].startsWith('-'); k++) {
    const a = argv[k]
    if (a === '-C') dirs.push(argv[++k] ?? '')
    else if (/^--(git-dir|work-tree)(=|$)/.test(a)) {
      customRepo = true // repo no longer follows cwd; git.ts reports repoDir null so rules fail closed
      if (!a.includes('=')) k++
    } else if (GIT_VALUE_OPTS.has(a)) k++
  }
  return { dirs, customRepo, sub: argv[k] ?? null, args: argv.slice(k + 1) }
}

/** Roots of a recursive search (grep -r/-R, rg, find) resolved against seg.cwd; null when the segment is not one. */
export function searchRoots(seg: Segment, home: string): (string | null)[] | null {
  const name = commandName(seg.argv)
  const args = seg.argv.slice(1)
  let roots: string[]
  if (name === 'find') {
    let k = 0
    while (k < args.length && /^-[HLPDO]/.test(args[k])) k += args[k] === '-D' ? 2 : 1
    roots = []
    for (; k < args.length && !/^[-(!]/.test(args[k]); k++) roots.push(args[k])
  } else if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
    const o = scanOpts(args, GREP_SHORT, GREP_LONG)
    if (!/[rR]/.test(o.shorts) && !o.longs.some((l) => l === '--recursive' || l === '--dereference-recursive')) return null
    roots = /[ef]/.test(o.shorts) || o.longs.some((l) => l === '--regexp' || l === '--file') ? o.pos : o.pos.slice(1)
  } else if (name === 'rg') {
    const o = scanOpts(args, RG_SHORT, RG_LONG)
    roots = /[ef]/.test(o.shorts) || o.longs.some((l) => ['--regexp', '--file', '--files'].includes(l)) ? o.pos : o.pos.slice(1)
  } else return null
  // No path means the search starts in cwd.
  return (roots.length ? roots : ['.']).map((r) => resolvePath(seg.cwd, r, home))
}

/** PR selector and --repo of a `gh pr merge` segment; null when it is not one. pr null means the current branch's PR. */
export function ghPrMerge(seg: Segment): { pr: string | null; repo: string | null } | null {
  const [, a1, a2, ...rest] = seg.argv
  if (commandName(seg.argv) !== 'gh' || a1 !== 'pr' || a2 !== 'merge') return null
  let repo: string | null = null
  const pos: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]
    if (a === '-R' || a === '--repo') repo = rest[++k] ?? null
    else if (a.startsWith('--repo=')) repo = a.slice(7)
    else if (GH_VALUE_OPTS.has(a)) k++
    else if (!a.startsWith('-')) pos.push(a)
  }
  return { pr: pos[0] ?? null, repo }
}

/** Splits args into positionals plus the short flag letters and long flag names seen, consuming option values. */
function scanOpts(args: string[], shortValues: string, longValues: string[]): { pos: string[]; shorts: string; longs: string[] } {
  const pos: string[] = []
  const longs: string[] = []
  let shorts = ''
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--') {
      pos.push(...args.slice(k + 1))
      break
    }
    if (a.startsWith('--')) {
      const n = a.split('=')[0]
      longs.push(n)
      if (!a.includes('=') && longValues.includes(n)) k++
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        shorts += a[j]
        // A value letter eats the rest of the cluster, or the next word when it ends the cluster (`-A3` vs `-e pat`).
        if (shortValues.includes(a[j])) {
          if (j === a.length - 1) k++
          break
        }
      }
    } else pos.push(a)
  }
  return { pos, shorts, longs }
}

/** Lexes `s` from `start` into tokens; with inSub it stops after the `)` closing a `$(`. */
function lex(s: string, start: number, inSub: boolean, home: string): { toks: Tok[]; end: number } {
  const L: Lexer = { s, i: start, toks: [], heredocs: [], home }
  let depth = 0
  while (L.i < s.length) {
    const c = s[L.i]
    if (c !== '\n' && /\s/.test(c)) L.i++
    else if (c === '\\' && s[L.i + 1] === '\n') L.i += 2
    else if (c === '\n') {
      L.toks.push({ t: 'o', v: ';' })
      L.i++
      skipHeredocs(L)
    } else if (c === '#') {
      while (L.i < s.length && s[L.i] !== '\n') L.i++
    } else if (c === '(') {
      depth++
      L.toks.push({ t: 'o', v: '(' })
      L.i++
    } else if (c === ')') {
      L.i++
      if (inSub && depth === 0) return { toks: L.toks, end: L.i }
      depth--
      L.toks.push({ t: 'o', v: ')' })
    } else if (!readOp(L)) L.toks.push(readWord(L))
  }
  return { toks: L.toks, end: L.i }
}

/** Reads an operator or redirection at L.i; a heredoc start registers its delimiter instead of emitting a token. */
function readOp(L: Lexer): boolean {
  OP_RE.lastIndex = L.i
  const m = OP_RE.exec(L.s)
  if (!m) return false
  L.i += m[0].length
  const op = m[0].replace(/^\d+/, '')
  if (op === '<<' || op === '<<-') {
    while (L.s[L.i] === ' ' || L.s[L.i] === '\t') L.i++
    L.heredocs.push({ delim: readWord(L).v, tabs: op === '<<-' })
  } else L.toks.push({ t: 'o', v: REDIRECT_ALIAS.get(op) ?? op })
  return true
}

/** After a newline, skips the bodies of pending heredocs so their text is never parsed as commands. */
function skipHeredocs(L: Lexer): void {
  for (const h of L.heredocs) {
    while (L.i < L.s.length) {
      let e = L.s.indexOf('\n', L.i)
      if (e < 0) e = L.s.length
      const line = L.s.slice(L.i, e)
      L.i = e + 1
      if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.delim) break
    }
  }
  L.heredocs = []
}

/** Reads one shell word, removing quotes and expanding a leading ~; substitutions inside it are pushed as tokens first. */
function readWord(L: Lexer): { t: 'w'; v: string } {
  const s = L.s
  let v = ''
  if (s[L.i] === '~' && (L.i + 1 >= s.length || s[L.i + 1] === '/' || WORD_END.test(s[L.i + 1]))) {
    v = L.home
    L.i++
  }
  while (L.i < s.length && !WORD_END.test(s[L.i])) {
    const c = s[L.i]
    if (c === '\\') {
      v += s[L.i + 1] === '\n' ? '' : s[L.i + 1] ?? ''
      L.i += 2
    } else if (c === "'") {
      const e = s.indexOf("'", L.i + 1)
      const end = e < 0 ? s.length : e
      v += s.slice(L.i + 1, end)
      L.i = end + 1
    } else if (c === '"') {
      L.i++
      v += readDouble(L)
    } else if (c === '$' || c === '`') v += readDollar(L)
    else {
      v += c
      L.i++
    }
  }
  return { t: 'w', v }
}

/** Reads a double-quoted body up to its closing quote; `$(...)` and backticks inside still run, so they are lexed. */
function readDouble(L: Lexer): string {
  const s = L.s
  let v = ''
  while (L.i < s.length && s[L.i] !== '"') {
    const c = s[L.i]
    if (c === '\\' && '$`"\\\n'.includes(s[L.i + 1] ?? 'x')) {
      v += s[L.i + 1] === '\n' ? '' : s[L.i + 1]
      L.i += 2
    } else if (c === '$' || c === '`') v += readDollar(L)
    else {
      v += c
      L.i++
    }
  }
  L.i++
  return v
}

/** Reads a `$...` or backtick expansion. Substitutions become 's' tokens; the word keeps the raw text so paths built from it resolve to null. */
function readDollar(L: Lexer): string {
  const s = L.s
  const from = L.i
  if (s[L.i] === '`') {
    let body = ''
    for (L.i++; L.i < s.length && s[L.i] !== '`'; L.i++) body += s[L.i] === '\\' ? s[++L.i] ?? '' : s[L.i]
    L.i++
    L.toks.push({ t: 's', toks: lex(body, 0, false, L.home).toks })
    return s.slice(from, L.i)
  }
  if (s[L.i + 1] === '(') {
    const r = lex(s, L.i + 2, true, L.home)
    L.toks.push({ t: 's', toks: r.toks })
    L.i = r.end
    return s.slice(from, L.i)
  }
  VAR_RE.lastIndex = L.i
  const m = VAR_RE.exec(s) as RegExpExecArray
  L.i += m[0].length
  return (m[1] ?? m[2]) === 'HOME' ? L.home : m[0]
}

/** Walks tokens in order, emitting segments and tracking cwd across cd, subshell parens and && / || lists. */
function build(toks: Tok[], st: State, out: Segment[]): void {
  let words: string[] = []
  let redirects: string[] = []
  let prevOp = ';'
  let listStart = st.cwd
  let uncertain = false // a cd in this && / || list ran only conditionally
  let cdSeen = false
  let afterOr = false // past a || that follows a cd: those commands run only if the cd failed
  const stack: (string | null)[] = []
  const flush = (op: string): void => {
    if (words.length) {
      const next = emit(words, redirects, afterOr ? null : st.cwd, st, out)
      // A cd inside a pipeline or a background job runs in a subshell and does not move this shell.
      if (next !== undefined && !PIPES.has(prevOp) && !PIPES.has(op) && op !== '&') {
        if (prevOp === '&&' || prevOp === '||') uncertain = true
        cdSeen = true
        st.cwd = next
      }
    }
    words = []
    redirects = []
    if (op === '||' && cdSeen) afterOr = true
    if (op !== '&&' && op !== '||' && !PIPES.has(op)) {
      // List ended: a conditional cd may or may not have happened, so later commands get an unknown cwd.
      if (uncertain && st.cwd !== listStart) st.cwd = null
      listStart = st.cwd
      uncertain = cdSeen = afterOr = false
    }
    prevOp = op
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.t === 's') build(t.toks, { ...st }, out) // substitution runs in a subshell: its cd never leaks
    else if (t.t === 'w') words.push(t.v)
    else if (t.v === '>' || t.v === '>&' || t.v === '<') {
      const n = toks[k + 1]
      if (n?.t !== 'w') continue
      k++
      if (t.v !== '<' && !/^(\d+|-)$/.test(n.v)) redirects.push(n.v) // `2>&1` and `>&-` are fd dups, not files
    } else {
      flush(t.v)
      if (t.v === '(') stack.push(st.cwd)
      else if (t.v === ')' && stack.length) listStart = st.cwd = stack.pop() ?? null
    }
  }
  flush(';')
}

/** Emits one command as segments (recursing into sh -c / eval); returns the new shell cwd for cd/pushd/popd/eval, else undefined. */
function emit(words: string[], redirects: string[], cwd: string | null, st: State, out: Segment[]): string | null | undefined {
  const raw = words.map((w) => (w === '' || /[\s'"\\$`&|;<>()]/.test(w) ? JSON.stringify(w) : w)).join(' ')
  const argv = stripWrappers(words)
  if (!argv.length) return undefined
  const name = commandName(argv)
  if (SHELLS.has(name) && st.depth < MAX_DEPTH) {
    const script = shellScript(argv)
    if (script !== null) {
      // A child shell: its cd stays inside it.
      build(lex(script, 0, false, st.home).toks, { cwd, depth: st.depth + 1, home: st.home }, out)
      return undefined
    }
  }
  if (name === 'eval' && st.depth < MAX_DEPTH) {
    const inner: State = { cwd, depth: st.depth + 1, home: st.home }
    build(lex(argv.slice(1).join(' '), 0, false, st.home).toks, inner, out)
    return inner.cwd === cwd ? undefined : inner.cwd // eval runs in this shell, so its cd sticks
  }
  const git = splitGit(argv)
  const segCwd = git ? git.dirs.reduce<string | null>((d, p) => resolvePath(d, p, st.home), cwd) : cwd
  out.push({ argv, cwd: segCwd, raw, redirects })
  if (name === 'cd') return cdTarget(argv.slice(1), cwd, st.home)
  if (name === 'pushd' || name === 'popd') return null
  return undefined
}

/** Where `cd <args>` lands: home with no arg, null for `cd -` or anything unresolvable. */
function cdTarget(args: string[], cwd: string | null, home: string): string | null {
  const rest = args.filter((a) => !/^-[LPe@]+$/.test(a) && a !== '--')
  if (!rest.length) return home
  return rest[0] === '-' ? null : resolvePath(cwd, rest[0], home)
}

/** Drops leading VAR=val words, shell keywords and wrapper commands (with their options) to reach the real command. */
function stripWrappers(words: string[]): string[] {
  let k = 0
  for (;;) {
    while (k < words.length && (ASSIGN_RE.test(words[k]) || KEYWORDS.has(words[k]))) k++
    const name = commandName(words.slice(k, k + 1))
    const spec = WRAPPERS.get(name)
    // `command -v x` only looks x up, so it stays as is.
    if (!spec || (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[k + 1] ?? ''))) return words.slice(k)
    k++
    for (; k < words.length && words[k].startsWith('-') && words[k] !== '-'; k++) if (spec.opts.includes(words[k])) k++
    k += spec.skip
  }
}

/** Script string of `sh -c <script>` style argv; null when the shell runs a file or stdin. */
function shellScript(argv: string[]): string | null {
  let hasC = false
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]
    if (a === '-o' || a === '+o') k++
    else if (/^[-+][a-zA-Z]+$/.test(a)) hasC ||= a.slice(1).includes('c')
    else if (!a.startsWith('--')) return hasC ? a : null
  }
  return null
}
