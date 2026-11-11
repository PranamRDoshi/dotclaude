/** Rule tests: every rule's allow and deny through the tool.call hook, driven by userConfig options, plus bypass attempts and the no-options defaults. */
import { describe, type Engine, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/dev'
const ROOT = `${HOME}/code`
const API = `${ROOT}/api`
const SDK = `${ROOT}/vendor-sdk`
const OPS = `${ROOT}/ops`
const ARCHIVE = `${ROOT}/archive`
const WT = `${ROOT}/worktrees/api--x`
const PRESENTATION = { isFullscreen: false, columns: 80 }
// The shape of the setup this plugin was first written for: one read-only repo, consent-gated repos, a branch lock, a blocked CLI.
const PARITY = {
  workspaceRoot: '~/code',
  readOnlyRepos: 'vendor-sdk',
  consentRepos: 'ops,docs-site,archive',
  branchLocks: 'ops=deploy',
  blockedCommands: 'kubectl',
  protectedBranches: 'main,master,develop',
}
const P = { options: PARITY }

type World = { cwd: string; branch: string | null; prBase: string | null; ran: string[][]; stats: string[]; home: string | null; settings: string; envFiles: string[]; envDirs: string[] }

/** Stands in for the engine: HOME, cwd, a file system where every path but /missing and unlisted env names exists, git and gh lookups. */
function stubEngine(on: On, world: Partial<World> = {}): World {
  const w: World = { cwd: API, branch: 'feature/x', prBase: 'feature/base', ran: [], stats: [], home: HOME, settings: '{"enabledPlugins":{"guardrails@dotclaude":true}}', envFiles: [], envDirs: [], ...world }
  mock.env(on, w.home === null ? {} : { HOME: w.home })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('fs.stat', ($, e) => {
    w.stats.push(e.path)
    // Env-file tests list which env-named paths exist, and as what; every other path is a directory.
    const isEnvName = /\.env/i.test(e.path.split('/').pop() ?? '')
    const isEnvFile = w.envFiles.includes(e.path)
    if (e.path.includes('/missing') || (isEnvName && !isEnvFile && !w.envDirs.includes(e.path))) throw new Error('ENOENT')
    return { value: { kind: isEnvFile ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.read', () => ({ value: w.settings }))
  on('process.run', ($, e) => {
    w.ran.push([...e.argv])
    const out = e.argv[0] === 'gh' ? w.prBase : w.branch
    return { value: { exitCode: out === null ? 1 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ran' as never }))
  return w
}

/** Grants one gate as if the person typed /consent at the prompt. */
async function grant($: Engine, gate: string): Promise<void> {
  await $.command.run({ command: 'consent', args: gate, origin: { kind: 'composer' }, presentation: PRESENTATION })
}

/** Starts the session and grants each gate. */
async function start($: Engine, gates: string[] = []): Promise<void> {
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  for (const g of gates) await grant($, g)
}

/** Runs a tool call through the hook; the deny text, or null when it reached the stub. */
async function call($: Engine, tool: string, input: Record<string, unknown>): Promise<string | null> {
  // The test's $ is the engine's, so a hook's deny comes back as { deny } (a session shows it as an errored result).
  const r = await $.tool.call({ tool, ...input } as never)
  return r.deny ?? (r.isError === true ? String(r.text) : null)
}
const bash = ($: Engine, command: string) => call($, 'Bash', { command })

describe('defaults: no options set', () => {
  test('an emptied protectedBranches list turns the branch rules off, failed lookups included', { options: { protectedBranches: '' } }, async ($, on) => {
    stubEngine(on, { cwd: WT, branch: 'main', prBase: null })
    await start($)
    expect(await bash($, 'git push origin main')).toBe(null)
    expect(await bash($, 'git push --all')).toBe(null)
    expect(await bash($, 'git commit -m x')).toBe(null)
    expect(await bash($, 'git branch -D main')).toBe(null)
    expect(await bash($, 'gh pr merge 7')).toBe(null)
  })

  test('an unset HOME fails closed on every tool', async ($, on) => {
    stubEngine(on, { home: null })
    await start($)
    expect(await bash($, 'ls')).toContain('guardrails: could not check this call')
    expect(await call($, 'Agent', { description: 'x', prompt: 'y' })).toContain('could not check this call')
  })

  test('protected branches, env files, self-protection and unknown cwd still deny', async ($, on) => {
    stubEngine(on, { cwd: WT, branch: 'main' })
    await start($)
    expect(await bash($, 'git push origin develop')).toContain('direct pushes to main, master or develop')
    expect(await bash($, 'git commit -m x')).toContain('local history writes on main, master or develop')
    expect(await bash($, 'git branch -D master')).toContain('deleting or renaming main, master or develop')
    expect(await bash($, 'cat .env')).toContain('.env is a .env file')
    expect(await call($, 'Write', { file_path: `${HOME}/.claude/plugins/cache/x.json`, content: '{}' })).toContain('/consent self-edit')
    expect(await bash($, 'claude plugin disable guardrails@dotclaude')).toContain('self-edit')
    expect(await bash($, 'cd "$X" && rm -rf y')).toContain('could not tell which directory')
    expect(await bash($, 'cd "$X" && ls')).toBeNull()
  })

  test('zone rules are off: any repo reads, writes, commits and searches; no command is blocked; the owner is "the user"', async ($, on) => {
    stubEngine(on, { cwd: API })
    await start($)
    expect(await bash($, 'git commit -m x')).toBeNull()
    expect(await call($, 'Edit', { file_path: `${SDK}/x.go`, old_string: 'a', new_string: 'b' })).toBeNull()
    expect(await call($, 'Read', { file_path: `${OPS}/a.yaml` })).toBeNull()
    expect(await bash($, `grep -rn foo ${HOME}`)).toBeNull()
    expect(await bash($, 'kubectl get pods')).toBeNull()
    expect(await bash($, 'cat .env')).toContain('Ask the user for the value')
  })
})

describe('readOnlyRepos', () => {
  test('file tool writes are denied, reads pass', P, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await call($, 'Edit', { file_path: `${SDK}/go/x.go`, old_string: 'a', new_string: 'b' })).toContain('vendor-sdk is read-only')
    expect(await call($, 'Write', { file_path: `${SDK}/new/file.ts`, content: 'x' })).toContain('read-only')
    expect(await call($, 'NotebookEdit', { notebook_path: `${SDK}/n.ipynb`, new_source: 'x' })).toContain('read-only')
    expect(await call($, 'Read', { file_path: `${SDK}/README.md` })).toBeNull()
  })

  test('Bash writes are denied, reads pass', P, async ($, on) => {
    stubEngine(on, { cwd: SDK })
    await start($)
    for (const c of ['sed -i s/a/b/ x.go', 'gofmt -w .', 'rm x.go', `mv a b`, 'echo x > file', 'git commit -m x', 'git checkout -b y',
      'git stash', 'git tag v1', `cd ${API} && cp x ${SDK}/y`]) {
      expect([c, await bash($, c)]).toEqual([c, expect.stringContaining('read-only')])
    }
    for (const c of ['cat go.mod', 'grep -n foo x.go', 'git log --oneline', 'go test ./...', 'go vet ./...', 'git status', 'go test ./... 2>&1 | tail -5']) {
      expect([c, await bash($, c)]).toEqual([c, null])
    }
  })
})

describe('consentRepos: read gates', () => {
  test('locked gates deny every file tool and Bash read, consent unlocks', P, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await call($, 'Read', { file_path: `${OPS}/a.yaml` })).toContain('/consent ops')
    expect(await call($, 'Grep', { pattern: 'x', path: `${ROOT}/docs-site` })).toContain('/consent docs-site')
    expect(await call($, 'Glob', { pattern: '**/*.py', path: `${ARCHIVE}/old` })).toContain('archive is consent-gated')
    expect(await call($, 'Glob', { pattern: '../ops/*.yaml' })).toContain('/consent ops')
    expect(await bash($, `cat ${OPS}/README.md`)).toContain('/consent ops')
    expect(await bash($, 'cat ../ops/README.md')).toContain('/consent ops')
    expect(await bash($, `cat ${OPS}/*.yaml`)).toContain('/consent ops')
  })

  test('MCP tools are not path-checked', P, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await call($, 'mcp__index__explore', { query: 'Foo', projectPath: OPS })).toBeNull()
  })

  test('with consent the reads pass', P, async ($, on) => {
    stubEngine(on)
    await start($, ['ops', 'archive'])
    expect(await call($, 'Read', { file_path: `${OPS}/a.yaml` })).toBeNull()
    expect(await bash($, `cat ${ARCHIVE}/old/x.py`)).toBeNull()
    expect(await call($, 'Read', { file_path: `${ROOT}/docs-site/x` })).toContain('/consent docs-site')
  })

  test('commits and pushes need the -write gate, for every consent-gated repo', P, async ($, on) => {
    stubEngine(on, { cwd: `${ROOT}/docs-site` })
    await start($, ['docs-site', 'archive'])
    expect(await bash($, 'git commit -m x')).toContain('/consent docs-site-write')
    expect(await bash($, `git -C ${ARCHIVE} commit -m x`)).toContain('/consent archive-write')
    await grant($, 'docs-site-write')
    expect(await bash($, 'git commit -m x')).toBeNull()
  })
})

describe('branchLocks', () => {
  test('the locked repo stays on its branch; its writes still need consent', P, async ($, on) => {
    stubEngine(on, { cwd: OPS, branch: 'deploy' })
    await start($, ['ops'])
    for (const c of ['git checkout -b x', 'git switch -c x', 'git branch x', 'git worktree add ../y', 'git checkout main']) {
      expect([c, await bash($, c)]).toEqual([c, expect.stringContaining('ops is locked to the deploy branch')])
    }
    expect(await bash($, 'git checkout deploy')).toBeNull()
    expect(await bash($, 'git pull --ff-only origin deploy')).toBeNull()
    expect(await bash($, 'git commit -m x')).toContain('/consent ops-write')
    expect(await bash($, 'git push origin deploy')).toContain('/consent ops-write')
  })

  test('a lock on a repo that is not consent-gated', { options: { workspaceRoot: '~/code', branchLocks: 'web=stable' } }, async ($, on) => {
    stubEngine(on, { cwd: `${ROOT}/web` })
    await start($)
    expect(await bash($, 'git switch other')).toContain('web is locked to the stable branch')
    expect(await bash($, 'git switch stable')).toBeNull()
    expect(await bash($, 'cd ../api && git switch other')).toBeNull()
  })
})

describe('protectedBranches: push', () => {
  test('protected targets, deletes, force and --all are denied; feature pushes pass', P, async ($, on) => {
    stubEngine(on, { cwd: WT })
    await start($)
    for (const c of ['git push origin develop', 'git push origin HEAD:develop', 'git push origin :develop', 'git push origin --delete main',
      'git push --force origin develop', 'git push --all origin', 'git push origin +feature/x:main', 'git push origin master']) {
      expect([c, await bash($, c)]).toEqual([c, expect.stringContaining('direct pushes to main, master or develop')])
    }
    expect(await bash($, 'git push -u origin feature/x')).toBeNull()
    expect(await bash($, 'git push --force-with-lease origin feature/x')).toBeNull()
    expect(await bash($, 'git push')).toBeNull()
  })

  test('bare push resolves the current branch, and fails closed when it cannot', P, async ($, on) => {
    const w = stubEngine(on, { cwd: WT, branch: 'develop' })
    await start($)
    expect(await bash($, 'git push')).toContain('direct pushes')
    expect(w.ran.at(-1)).toEqual(['git', '-C', WT, 'rev-parse', '--abbrev-ref', 'HEAD'])
    w.branch = null
    expect(await bash($, 'git push origin HEAD')).toContain('could not tell which branch')
  })
})

describe('protectedBranches: gh pr merge', () => {
  test('a protected base is denied, other bases pass, a lookup failure is denied', P, async ($, on) => {
    const w = stubEngine(on, { prBase: 'main' })
    await start($)
    expect(await bash($, 'gh pr merge 12 --squash')).toContain('merging a PR into main')
    expect(w.ran.at(-1)).toEqual(['gh', 'pr', 'view', '12', '--json', 'baseRefName', '-q', '.baseRefName'])
    w.prBase = 'develop'
    expect(await bash($, 'gh pr merge --squash')).toContain('into develop')
    w.prBase = 'feature/stack-base'
    expect(await bash($, 'gh pr merge 13 --repo org/r')).toBeNull()
    expect(w.ran.at(-1)).toContain('--repo')
    w.prBase = null
    expect(await bash($, 'gh pr merge 14')).toContain("could not look up this PR's base")
  })
})

describe('protectedBranches: history writes', () => {
  test('commit, rebase, reset and non-ff pull denied on every protected branch, primary and worktree alike', P, async ($, on) => {
    const w = stubEngine(on, { branch: 'develop' })
    await start($, ['primary-commit'])
    for (const branch of ['develop', 'main', 'master']) {
      w.branch = branch
      for (const c of ['git commit -m x', 'git commit --amend', 'git rebase origin/develop', 'git reset --hard HEAD~1', 'git pull',
        `git -C ${WT} commit -m x`, `git -C ${WT} cherry-pick abc`]) {
        expect([branch, c, await bash($, c)]).toEqual([branch, c, expect.stringContaining('local history writes on main, master or develop')])
      }
    }
  })

  test('ff-only pull passes; forced branch create onto a protected branch is denied', P, async ($, on) => {
    stubEngine(on, { branch: 'develop' })
    await start($)
    expect(await bash($, 'git pull --ff-only origin develop')).toBeNull()
    expect(await bash($, `git -C ${WT} branch -f develop abc`)).toContain('local history writes')
    expect(await bash($, `git -C ${WT} checkout -B main`)).toContain('local history writes')
  })

  test('other branches and detached HEAD pass; a failed lookup denies', P, async ($, on) => {
    const w = stubEngine(on, { cwd: WT })
    await start($)
    for (const branch of ['feature/x', 'fix/y', 'release/1.2', 'HEAD']) {
      w.branch = branch
      expect([branch, await bash($, 'git commit -m x')]).toEqual([branch, null])
    }
    w.branch = null
    expect(await bash($, 'git commit -m x')).toContain('could not tell the current branch')
  })
})

describe('protectedBranches: local delete and rename', () => {
  test('delete or rename of a protected branch is denied; others pass', P, async ($, on) => {
    stubEngine(on, { branch: 'develop' })
    await start($)
    for (const c of ['git branch -D develop', 'git branch -d main', 'git branch --delete master', 'git branch -m develop old', 'git branch -m renamed']) {
      expect([c, await bash($, c)]).toEqual([c, expect.stringContaining('deleting or renaming main, master or develop')])
    }
    expect(await bash($, 'git branch -d feature/x')).toBeNull()
  })

  test('a custom list replaces the default in all four rules', { options: { protectedBranches: 'trunk' } }, async ($, on) => {
    const w = stubEngine(on, { cwd: WT, branch: 'trunk', prBase: 'trunk' })
    await start($)
    expect(await bash($, 'git push origin trunk')).toContain('direct pushes to trunk')
    expect(await bash($, 'gh pr merge 1')).toContain('merging a PR into trunk')
    expect(await bash($, 'git commit -m x')).toContain('local history writes on trunk')
    expect(await bash($, 'git branch -D trunk')).toContain('deleting or renaming trunk')
    w.branch = 'main'
    w.prBase = 'main'
    expect(await bash($, 'git push origin main')).toBeNull()
    expect(await bash($, 'gh pr merge 1')).toBeNull()
    expect(await bash($, 'git commit -m x')).toBeNull()
  })
})

describe('primaryCommits and worktreesDir', () => {
  test('primary commit denied, worktree, ff-only and consented commits pass', P, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await bash($, 'git commit -m x')).toContain(`commits in a primary checkout are blocked. Create a worktree under ${ROOT}/worktrees first`)
    expect(await bash($, 'git merge feature/x')).toContain('primary checkout')
    expect(await bash($, `git -C ${WT} commit -m x`)).toBeNull()
    expect(await bash($, 'git pull --ff-only origin develop')).toBeNull()
    expect(await bash($, 'git merge --ff-only origin/develop')).toBeNull()
    expect(await bash($, 'git status && git add -A')).toBeNull()
    await grant($, 'primary-commit')
    expect(await bash($, 'git commit -m x')).toBeNull()
  })

  test('a plugin-origin consent unlocks nothing', P, async ($, on) => {
    stubEngine(on)
    await start($)
    await $.command.run({ command: 'consent', args: 'primary-commit', origin: { kind: 'plugin', name: 'x' } as never, presentation: PRESENTATION })
    expect(await bash($, 'git commit -m x')).toContain('primary checkout')
  })

  test('primaryCommits allow turns the check off', { options: { ...PARITY, primaryCommits: 'allow' } }, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await bash($, 'git commit -m x')).toBeNull()
  })

  test('worktreesDir names the folder where commits are allowed', { options: { workspaceRoot: '~/code', worktreesDir: 'wt' } }, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await bash($, `git -C ${ROOT}/wt/api--x commit -m x`)).toBeNull()
    expect(await bash($, `git -C ${WT} commit -m x`)).toContain(`Create a worktree under ${ROOT}/wt first`)
  })
})

describe('blockedCommands', () => {
  test('every spelling is denied', P, async ($, on) => {
    stubEngine(on)
    await start($)
    for (const c of ['kubectl get pods', 'cd /tmp && kubectl get ns', 'FOO=1 kubectl logs x', 'sh -c "kubectl get pods"',
      'echo x | xargs kubectl delete pod', '/usr/local/bin/KUBECTL get pods']) {
      expect([c, await bash($, c)]).toEqual([c, expect.stringContaining('on the blocked command list')])
    }
    expect(await bash($, 'which kubectl')).toBeNull()
  })

  test('a custom list blocks exactly its programs', { options: { blockedCommands: 'terraform, aws' } }, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await bash($, 'aws s3 ls')).toContain('aws is on the blocked command list')
    expect(await bash($, 'sudo terraform apply')).toContain('terraform is on the blocked command list')
    expect(await bash($, 'kubectl get pods')).toBeNull()
  })
})

describe('self-protection', () => {
  test('plugins dir, protected paths and disable commands need self-edit', { options: { ...PARITY, protectedPaths: '~/.claude/mods/guardrails' } }, async ($, on) => {
    stubEngine(on, { cwd: HOME })
    await start($)
    const mod = `${HOME}/.claude/mods/guardrails`
    expect(await call($, 'Edit', { file_path: `${mod}/src/rules.ts`, old_string: 'a', new_string: 'b' })).toContain('/consent self-edit')
    expect(await bash($, `rm -rf ${HOME}/.claude/plugins/cache`)).toContain('self-edit')
    expect(await bash($, 'cd .claude/mods && rm -rf guardrails')).toContain('self-edit')
    expect(await bash($, 'claude plugin disable guardrails@dotclaude')).toContain('self-edit')
    expect(await bash($, 'claude plugin uninstall guardrails')).toContain('self-edit')
    expect(await call($, 'Read', { file_path: `${mod}/src/rules.ts` })).toBeNull()
    expect(await bash($, `cd ${mod} && claude plugin test .`)).toBeNull()
    expect(await bash($, `cd ${HOME}/.claude/mods && git add guardrails && git commit -m x`)).toBeNull()
    expect(await bash($, 'claude plugin disable other@dotclaude')).toBeNull()
  })

  test("this plugin's own folder needs self-edit with no option set", async ($, on) => {
    const w = stubEngine(on, { cwd: HOME })
    await start($)
    expect(await call($, 'Read', { file_path: `${HOME}/x` })).toBeNull()
    // The test's $ has no plugin noun, so read the plugin folder off the one path the hook stats outside HOME.
    const root = w.stats.find(p => !p.startsWith(HOME)) ?? ''
    expect(root).toContain('guardrails')
    expect(await call($, 'Edit', { file_path: `${root}/src/rules.ts`, old_string: 'a', new_string: 'b' })).toContain('/consent self-edit')
    expect(await call($, 'Read', { file_path: `${root}/src/rules.ts` })).toBeNull()
  })

  test('settings.json edits are gated only when enabledPlugins changes', P, async ($, on) => {
    stubEngine(on, { cwd: HOME })
    await start($)
    const file_path = `${HOME}/.claude/settings.json`
    expect(await call($, 'Edit', { file_path, old_string: 'true', new_string: 'false' })).toContain('self-edit')
    expect(await call($, 'Write', { file_path, content: '{"enabledPlugins":{}}' })).toContain('self-edit')
    expect(await call($, 'Edit', { file_path, old_string: '{"enabledPlugins"', new_string: '{"model":"opus","enabledPlugins"' })).toBeNull()
    expect(await bash($, `sed -i '' s/true/false/ ${file_path}`)).toContain('self-edit')
    expect(await bash($, `cat ${file_path}`)).toBeNull()
  })

  test('self-edit consent unlocks it', { options: { protectedPaths: '~/dotfiles' } }, async ($, on) => {
    stubEngine(on, { cwd: HOME })
    await start($)
    expect(await call($, 'Write', { file_path: `${HOME}/dotfiles/x`, content: 'y' })).toContain('self-edit')
    await grant($, 'self-edit')
    expect(await call($, 'Write', { file_path: `${HOME}/dotfiles/x`, content: 'y' })).toBeNull()
  })
})

describe('recursive search rooted at the workspace root', () => {
  test('denied while any consent gate is locked', P, async ($, on) => {
    stubEngine(on, { cwd: ROOT })
    await start($, ['ops', 'docs-site'])
    expect(await call($, 'Grep', { pattern: 'x' })).toContain('Narrow the path to one repo folder')
    expect(await call($, 'Grep', { pattern: 'x', path: ROOT })).toContain('recursive searches')
    expect(await call($, 'Glob', { pattern: '**/CLAUDE.md' })).toContain('recursive searches')
    expect(await bash($, 'rg foo')).toContain('recursive searches')
    expect(await bash($, `grep -rn foo ${ROOT}`)).toContain('recursive searches')
    expect(await bash($, 'find . -name "*.md"')).toContain('recursive searches')
    expect(await bash($, `find ${HOME} -name x`)).toContain('recursive searches')
    expect(await call($, 'Grep', { pattern: 'x', path: API })).toBeNull()
    expect(await call($, 'Glob', { pattern: 'api/**/*.go' })).toBeNull()
    expect(await bash($, 'rg foo api')).toBeNull()
  })

  test('allowed once every consent gate is held', P, async ($, on) => {
    stubEngine(on, { cwd: ROOT })
    await start($, ['ops', 'docs-site', 'archive'])
    expect(await call($, 'Grep', { pattern: 'x' })).toBeNull()
    expect(await bash($, 'rg foo')).toBeNull()
  })
})

describe('parser bypasses', () => {
  test('cd chains, git -C, sh -c, $(...) and unknown cwd', P, async ($, on) => {
    stubEngine(on, { cwd: ROOT })
    await start($, ['ops'])
    expect(await bash($, `cd ${OPS}; git commit -m x`)).toContain('/consent ops-write')
    expect(await bash($, `git -C ${SDK} commit -m x`)).toContain('read-only')
    expect(await bash($, 'cd api && bash -c "git push origin main"')).toContain('direct pushes')
    expect(await bash($, 'cd api && echo $(git push origin main)')).toContain('direct pushes')
    expect(await bash($, 'cd "$X" && git commit -m x')).toContain('could not tell which directory')
    expect(await bash($, 'cd /missing/dir && rm -rf x')).toContain('could not tell which directory')
    expect(await bash($, 'cd "$X" && ls')).toBeNull()
  })

  test('a quoted && in a commit message stays one segment', P, async ($, on) => {
    stubEngine(on, { cwd: WT })
    await start($)
    expect(await bash($, 'git commit -m "fix a && git push origin main"')).toBeNull()
  })
})

describe('false positives that must stay allowed', () => {
  test('everyday reads and worktree work', P, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await bash($, `git -C ${SDK} log --oneline -5`)).toBeNull()
    expect(await call($, 'Read', { file_path: `${ROOT}/CLAUDE.md` })).toBeNull()
    expect(await bash($, 'git status')).toBeNull()
    expect(await bash($, 'git pull --ff-only')).toBeNull()
    expect(await bash($, `cd ${WT} && git add -A && git commit -m "feat: x" && git push -u origin feature/x`)).toBeNull()
    expect(await call($, 'Edit', { file_path: `${WT}/a.go`, old_string: 'a', new_string: 'b' })).toBeNull()
    expect(await call($, 'Agent', { description: 'x', prompt: 'y' })).toBeNull()
  })

  test('denials land in the /guardrails log', P, async ($, on) => {
    stubEngine(on)
    await start($)
    await bash($, 'kubectl get pods')
    const report = await $.command.run({ command: 'guardrails', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(report.text).toContain('Bash blocked-command: kubectl get pods')
  })
})

describe('ownerName', () => {
  test('deny messages name the owner', { options: { ...PARITY, ownerName: 'Sam' } }, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await call($, 'Read', { file_path: `${OPS}/a` })).toContain('Ask Sam to run /consent ops, then retry. Do not retry with another spelling or path.')
    expect(await bash($, 'kubectl get pods')).toContain('Ask Sam to run the command')
  })
})

describe('envFiles', () => {
  test('every tool and spelling that names one is denied, whatever consent is held', P, async ($, on) => {
    stubEngine(on, { envFiles: [`${API}/deploy_prod.env`] })
    await start($, ['self-edit', 'primary-commit'])
    expect(await call($, 'Read', { file_path: `${API}/.env` })).toContain('.env is a .env file')
    expect(await call($, 'Read', { file_path: `${API}/backend/.env.prod-readonly` })).toContain('no override')
    expect(await call($, 'Read', { file_path: `${API}/deploy_prod.env` })).toContain('deploy_prod.env')
    expect(await call($, 'Write', { file_path: `${API}/.env`, content: 'X=1' })).toContain('.env file')
    expect(await call($, 'Grep', { pattern: 'KEY', path: API, glob: '*.env' })).toContain('.env file')
    for (const c of ['cat .env', 'head -3 ~/code/api/.env.local', 'source .env && go run .', 'docker run --env-file=.env x',
      'git show HEAD:.env', `python3 -c "print(open('.env').read())"`, 'cat config/*.env', 'cat deploy_prod.env', 'echo X=1 >> .env',
      'cat .ENV', 'rg -g ".env*" KEY .']) {
      expect([c, await bash($, c)]).toEqual([c, expect.stringContaining('.env file')])
    }
  })

  test('templates, code mentions, missing *.env names and env dirs pass', P, async ($, on) => {
    stubEngine(on, { envDirs: [`${API}/.env`] })
    await start($)
    expect(await call($, 'Read', { file_path: `${API}/.env.example` })).toBeNull()
    expect(await call($, 'Grep', { pattern: '.env', path: API })).toBeNull()
    for (const c of ['cat .env.example .env.sample .env.template', 'rg process.env src', 'rg "process\\.env\\.[A-Z]+" src',
      'grep -rn import.meta.env dashboard/src', 'cat .envrc.md x.environment.ts', 'ls .env', '.env/bin/python -V', 'printenv HOME']) {
      expect([c, await bash($, c)]).toEqual([c, null])
    }
  })

  test('envFiles allow turns the check off', { options: { envFiles: 'allow' } }, async ($, on) => {
    stubEngine(on)
    await start($)
    expect(await bash($, 'cat .env')).toBeNull()
    expect(await call($, 'Read', { file_path: `${API}/.env` })).toBeNull()
  })
})
