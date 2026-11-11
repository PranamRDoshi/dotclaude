/** Zone tests: option parsing, config building, path normalization and zone classification, all pure. */
import { describe, expect, test } from 'claude-code/testing'
import { configOf, normalizePath, parseOptions, topFolder, zoneOf } from '../src/zones'

const HOME = '/home/dev'
const ROOT = `${HOME}/code`
const PLUGIN = '/opt/claude-plugins/guardrails'
const cfg = configOf(
  parseOptions({ workspaceRoot: '~/code', readOnlyRepos: 'vendor-sdk', consentRepos: 'Ops, archive', branchLocks: 'ops=deploy, bad', protectedPaths: '~/dotfiles' }),
  HOME,
  PLUGIN,
)

describe('parseOptions', () => {
  test('defaults when nothing is set: no root, safe choices, neutral owner', () => {
    const o = parseOptions({})
    expect(o).toMatchObject({ workspaceRoot: '', worktreesDir: 'worktrees', protectedBranches: [], blockPrimaryCommits: true, blockEnvFiles: true, ownerName: 'the user' })
    expect(o.consentRepos).toEqual([])
  })

  test('lists are trimmed, folders lowercased, locks need folder=branch, only an exact allow turns a check off', () => {
    expect(cfg.consentRepos).toEqual(['ops', 'archive'])
    expect([...cfg.branchLocks]).toEqual([['ops', 'deploy']])
    expect(parseOptions({ envFiles: 'Allow', primaryCommits: 'allow' })).toMatchObject({ blockEnvFiles: true, blockPrimaryCommits: false })
    expect(parseOptions({ worktreesDir: '/WT/' }).worktreesDir).toBe('wt')
  })
})

describe('configOf', () => {
  test('root, built-in self roots and settings come from HOME and the plugin folder', () => {
    expect(cfg.root).toBe(ROOT)
    expect(cfg.selfRoots).toEqual([`${HOME}/.claude/plugins`, PLUGIN, `${HOME}/dotfiles`])
    expect(cfg.settingsFile).toBe(`${HOME}/.claude/settings.json`)
    expect(configOf(parseOptions({}), HOME, PLUGIN).root).toBeNull()
  })
})

describe('normalizePath', () => {
  test('expands ~, joins relative paths and folds . and ..', () => {
    expect(normalizePath('~', '/x', HOME)).toBe(HOME)
    expect(normalizePath('~/code/ops', '/x', HOME)).toBe(`${ROOT}/ops`)
    expect(normalizePath('../ops/./a', `${ROOT}/api`, HOME)).toBe(`${ROOT}/ops/a`)
    expect(normalizePath('/a//b/', '/x', HOME)).toBe('/a/b')
    expect(normalizePath('../../..', '/a', HOME)).toBe('/')
  })
})

describe('zoneOf', () => {
  test('read-only and gated repos and their contents', () => {
    expect(zoneOf(`${ROOT}/vendor-sdk`, cfg)).toBe('read-only')
    expect(zoneOf(`${ROOT}/vendor-sdk/go/x.go`, cfg)).toBe('read-only')
    expect(zoneOf(`${ROOT}/ops/`, cfg)).toBe('gated')
    expect(zoneOf(`${ROOT}/archive/old/a.py`, cfg)).toBe('gated')
    expect(topFolder(`${ROOT}/archive/old/a.py`, cfg)).toBe('archive')
  })

  test('case aliases still land in the zone', () => {
    expect(zoneOf(`${ROOT}/OPS/x`, cfg)).toBe('gated')
    expect(zoneOf(`${HOME}/CODE/Vendor-SDK`, cfg)).toBe('read-only')
  })

  test('prefix look-alikes are not the listed repo', () => {
    expect(zoneOf(`${ROOT}/ops-old`, cfg)).toBe('primary')
    expect(zoneOf(`${ROOT}/vendor-sdk2/x`, cfg)).toBe('primary')
  })

  test('primary checkouts, worktrees, the workspace .claude folder and outside paths', () => {
    expect(zoneOf(`${ROOT}/api`, cfg)).toBe('primary')
    expect(zoneOf(`${ROOT}/web/src`, cfg)).toBe('primary')
    expect(zoneOf(`${ROOT}/worktrees/api--x`, cfg)).toBe('worktree')
    expect(zoneOf(`${ROOT}/worktrees`, cfg)).toBe('worktree')
    expect(zoneOf(`${ROOT}/.claude/rules/x.md`, cfg)).toBe('other')
    expect(zoneOf(ROOT, cfg)).toBe('other')
    expect(zoneOf(`${HOME}/codex/api`, cfg)).toBe('other')
  })

  test('no workspace root: every repo path is other', () => {
    const bare = configOf(parseOptions({ readOnlyRepos: 'vendor-sdk' }), HOME, PLUGIN)
    expect(zoneOf(`${ROOT}/vendor-sdk/x`, bare)).toBe('other')
    expect(topFolder(`${ROOT}/vendor-sdk/x`, bare)).toBeNull()
  })

  test('self-protection and settings', () => {
    expect(zoneOf(`${PLUGIN}/src/zones.ts`, cfg)).toBe('self')
    expect(zoneOf(`${HOME}/.claude/plugins/installed_plugins.json`, cfg)).toBe('self')
    expect(zoneOf(`${HOME}/dotfiles/claude/settings.json`, cfg)).toBe('self')
    expect(zoneOf(`${HOME}/.claude/mods/other/x.ts`, cfg)).toBe('other')
    expect(zoneOf(`${HOME}/.claude/settings.json`, cfg)).toBe('settings')
    expect(zoneOf(`${HOME}/.claude/settings.local.json`, cfg)).toBe('other')
  })
})
