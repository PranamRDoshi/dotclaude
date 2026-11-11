/** Options, config and zone classification for the guardrails rules; pure (the $.fs.stat resolver lives in hooks/guardrails.ts). */
import type { PluginOptions } from 'claude-code'

/** Where a path sits: a read-only or consent-gated repo, a primary checkout, a worktree, guardrails' own files, settings.json, or elsewhere. */
export type Zone = 'read-only' | 'gated' | 'primary' | 'worktree' | 'self' | 'settings' | 'other'

/** The userConfig options as the rules read them: lists split, folder and command names lowercased, choices as booleans. */
export type Options = {
  workspaceRoot: string
  worktreesDir: string
  protectedBranches: string[]
  blockPrimaryCommits: boolean
  readOnlyRepos: string[]
  consentRepos: string[]
  /** Folder (lowercased) to the one branch it may be on. A Map, so a folder named like an Object key is never a lock. */
  branchLocks: Map<string, string>
  blockedCommands: string[]
  blockEnvFiles: boolean
  protectedPaths: string[]
  ownerName: string
}

/** Options plus this machine's paths: root is null when workspaceRoot is empty, which turns every zone rule off. */
export type Config = Options & { home: string; root: string | null; selfRoots: string[]; settingsFile: string }

/** Splits a comma-separated option into trimmed, non-empty entries. */
function listOf(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean)
}

/** Reads the userConfig values into Options; a choice other than exactly "allow" blocks, so a typo fails safe. */
export function parseOptions(options: PluginOptions): Options {
  const text = (key: string) => String(options[key] ?? '').trim()
  const lower = (key: string) => listOf(text(key)).map(s => s.toLowerCase())
  // `folder=branch`: the folder matches case-insensitively like every zone, the branch exactly as git spells it.
  const locks = listOf(text('branchLocks')).flatMap(pair => {
    const at = pair.indexOf('=')
    return at > 0 ? [[pair.slice(0, at).trim().toLowerCase(), pair.slice(at + 1).trim()] as [string, string]] : []
  })
  return {
    workspaceRoot: text('workspaceRoot'),
    worktreesDir: (text('worktreesDir') || 'worktrees').toLowerCase().replace(/^\/+|\/+$/g, ''),
    protectedBranches: listOf(text('protectedBranches')),
    blockPrimaryCommits: text('primaryCommits') !== 'allow',
    readOnlyRepos: lower('readOnlyRepos'),
    consentRepos: lower('consentRepos'),
    branchLocks: new Map(locks),
    blockedCommands: lower('blockedCommands'),
    blockEnvFiles: text('envFiles') !== 'allow',
    protectedPaths: listOf(text('protectedPaths')),
    ownerName: text('ownerName') || 'the user',
  }
}

/** Joins Options with HOME and this plugin's folder into a lexical Config; the hook then makes its paths real like any target. */
export function configOf(o: Options, home: string, pluginRoot: string): Config {
  const abs = (p: string) => normalizePath(p, home, home)
  return {
    ...o,
    home,
    root: o.workspaceRoot === '' ? null : abs(o.workspaceRoot),
    // Built in: installed plugin copies and this plugin's own folder. Disabling it there works as surely as editing it.
    selfRoots: [`${home}/.claude/plugins`, pluginRoot, ...o.protectedPaths].map(abs),
    settingsFile: `${home}/.claude/settings.json`,
  }
}

/** True when path is root itself or lies under it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/** The top-level folder under the workspace root that holds absPath, lowercased; null with no root, outside it, or for the root itself. */
export function topFolder(absPath: string, cfg: Config): string | null {
  if (cfg.root === null) return null
  // macOS volumes are case-insensitive and realPath keeps a case alias's spelling, so compare lowercased.
  const path = absPath.toLowerCase().replace(/\/+$/, '')
  const root = cfg.root.toLowerCase().replace(/\/+$/, '')
  if (!path.startsWith(`${root}/`)) return null
  return path.slice(root.length + 1).split('/')[0] ?? null
}

/** Maps an absolute, normalized path to its zone; pure, no file system access. */
export function zoneOf(absPath: string, cfg: Config): Zone {
  const path = absPath.toLowerCase().replace(/\/+$/, '')
  if (cfg.selfRoots.some(root => isUnder(path, root.toLowerCase()))) return 'self'
  if (path === cfg.settingsFile.toLowerCase()) return 'settings'
  const top = topFolder(path, cfg)
  if (top === null) return 'other'
  // Read-only wins over gated: a folder in both lists is never written, and readDeny still gates its reads by name.
  if (cfg.readOnlyRepos.includes(top)) return 'read-only'
  if (cfg.consentRepos.includes(top)) return 'gated'
  if (top === cfg.worktreesDir) return 'worktree'
  // The workspace's own .claude folder holds agent settings, not a repo.
  if (top === '.claude') return 'other'
  // ponytail: a loose file straight under the root (a CLAUDE.md) reads as primary; no rule acts on that for files.
  return 'primary'
}

/** Makes a path absolute against cwd, expands a leading ~ to home, and folds . and .. lexically. */
export function normalizePath(path: string, cwd: string, home: string): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? home + path.slice(1) : path
  const abs = expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`
  const parts: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
