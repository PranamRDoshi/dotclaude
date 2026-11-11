/** Git intent tests: reads vs writes, push targets, branch create/delete, checkout, ff-only and repoDir. */
import { describe, expect, test } from 'claude-code/testing'
import { parseBash } from '../src/bash'
import { gitIntent } from '../src/git'
import type { GitIntent } from '../src/types'

const HOME = '/home/dev'
const ROOT = `${HOME}/code`
const API = `${ROOT}/api`

/** Intent of the last git segment in `cmd`, run from `cwd`. */
const gi = (cmd: string, cwd = API): GitIntent | null => {
  const intents = parseBash(cmd, cwd, HOME).map(gitIntent).filter((x) => x !== null)
  return intents[intents.length - 1] ?? null
}
const kind = (cmd: string) => gi(cmd)?.kind
const targets = (cmd: string) => gi(cmd)?.targets

describe('not git', () => {
  test('non-git segments and quoted mentions return null', () => {
    expect(gi('ls -la')).toBeNull()
    expect(gi('echo "git push origin main"')).toBeNull()
  })
})

describe('reads', () => {
  test('read subcommands and read forms of mixed ones', () => {
    for (const c of ['git status', 'git log --oneline', 'git diff HEAD~1', 'git fetch origin', 'git branch', 'git branch -a',
      'git branch --show-current', 'git tag -l', 'git tag', 'git worktree list', 'git stash list', 'git remote -v',
      'git config --get user.name', 'git config user.name', 'git log --grep "push origin develop"', 'git --no-pager show']) {
      expect([c, kind(c)]).toEqual([c, 'read'])
    }
  })
})

describe('commit-creating', () => {
  test('commit, amend, merge, pull, rebase, cherry-pick, revert, am', () => {
    for (const c of ['git commit -m x', 'git commit --amend', 'git merge feature/x', 'git pull', 'git rebase develop',
      'git cherry-pick abc', 'git revert abc', 'git am p.patch']) {
      expect([c, kind(c)]).toEqual([c, 'commit'])
    }
    expect(gi('git commit -m x')?.sub).toBe('commit')
  })

  test('--ff-only is flagged, --abort is not a commit', () => {
    expect(gi('git merge --ff-only origin/develop')?.isFfOnly).toBe(true)
    expect(gi('git pull --ff-only')?.isFfOnly).toBe(true)
    expect(gi('git merge origin/develop')?.isFfOnly).toBe(false)
    expect(kind('git merge --abort')).toBe('other-write')
  })

  test('commit message with && stays one commit', () => {
    expect(gi(`git commit -m "fix: a && git push origin main"`)).toMatchObject({ kind: 'commit', repoDir: API })
  })
})

describe('other writes', () => {
  test('reset, stash, tag, rm, mv, clean, apply, restore, unknown alias', () => {
    for (const c of ['git reset --hard', 'git stash', 'git stash pop', 'git tag v1', 'git tag -d v1', 'git rm a', 'git mv a b',
      'git clean -fd', 'git apply x.patch', 'git restore a', 'git config user.name X', 'git co develop', 'git checkout -- a',
      'git checkout HEAD~1 a b', 'git worktree remove x', 'git branch -u origin/x']) {
      expect([c, kind(c)]).toEqual([c, 'other-write'])
    }
  })
})

describe('push', () => {
  test('targets from refspecs', () => {
    expect(targets('git push origin develop')).toEqual(['develop'])
    expect(targets('git push origin HEAD:develop')).toEqual(['develop'])
    expect(targets('git push origin HEAD:refs/heads/main')).toEqual(['main'])
    expect(targets('git push -u origin feature/x')).toEqual(['feature/x'])
    expect(targets('git push origin a b:c')).toEqual(['a', 'c'])
  })

  test('no refspec means the current branch, --all means every branch', () => {
    expect(targets('git push')).toEqual(['HEAD'])
    expect(targets('git push origin')).toEqual(['HEAD'])
    expect(targets('git push origin HEAD')).toEqual(['HEAD'])
    expect(targets('git push --all origin')).toEqual(['*'])
    expect(targets('git push --tags origin')).toEqual([])
  })

  test('deletes stay kind push with isDelete', () => {
    expect(gi('git push origin :develop')).toMatchObject({ kind: 'push', targets: ['develop'], isDelete: true })
    expect(gi('git push origin --delete main')).toMatchObject({ kind: 'push', targets: ['main'], isDelete: true })
    expect(gi('git push -d origin main')).toMatchObject({ targets: ['main'], isDelete: true })
  })

  test('force flags', () => {
    for (const c of ['git push --force origin develop', 'git push -f origin develop', 'git push --force-with-lease origin develop',
      'git push --force-with-lease=develop:abc origin develop', 'git push origin +develop', 'git push -uf origin develop']) {
      expect([c, gi(c)?.isForce, gi(c)?.targets]).toEqual([c, true, ['develop']])
    }
    expect(gi('git push origin feature/x')?.isForce).toBe(false)
  })

  test('push hidden in bash -c, $(...) and eval', () => {
    expect(gi(`bash -c "git push origin main"`)).toMatchObject({ kind: 'push', targets: ['main'] })
    expect(gi('echo $(git push origin main)')).toMatchObject({ kind: 'push', targets: ['main'] })
    expect(gi(`eval 'git push origin main'`)).toMatchObject({ kind: 'push', targets: ['main'] })
    expect(gi('xargs git push origin main')).toMatchObject({ kind: 'push', targets: ['main'] })
  })
})

describe('branch create, delete and checkout', () => {
  test('create forms', () => {
    expect(gi('git checkout -b x')).toMatchObject({ kind: 'branch-create', targets: ['x'] })
    expect(gi('git checkout -B x')).toMatchObject({ kind: 'branch-create', targets: ['x'], isForce: true })
    expect(gi('git switch -c x')).toMatchObject({ kind: 'branch-create', targets: ['x'] })
    expect(gi('git switch -C x')).toMatchObject({ kind: 'branch-create', targets: ['x'] })
    expect(gi('git branch x')).toMatchObject({ kind: 'branch-create', targets: ['x'] })
    expect(gi('git branch -t x origin/x')).toMatchObject({ kind: 'branch-create', targets: ['x'] })
    expect(gi('git worktree add -b feature/x ../wt develop')).toMatchObject({ kind: 'branch-create', targets: ['feature/x'] })
    expect(gi('git worktree add ../wt-name')).toMatchObject({ kind: 'branch-create', targets: ['wt-name'] })
  })

  test('checkout or switch to an existing branch', () => {
    expect(gi('git checkout deploy')).toMatchObject({ kind: 'checkout', targets: ['deploy'] })
    expect(gi('git switch develop')).toMatchObject({ kind: 'checkout', targets: ['develop'] })
    expect(gi('git worktree add ../wt develop')).toMatchObject({ kind: 'checkout', targets: ['develop'] })
    expect(gi('git checkout -')).toMatchObject({ kind: 'checkout', targets: ['-'] })
  })

  test('local deletes', () => {
    expect(gi('git branch -D develop')).toMatchObject({ kind: 'branch-delete', targets: ['develop'], isForce: true })
    expect(gi('git branch -d main')).toMatchObject({ kind: 'branch-delete', targets: ['main'], isForce: false })
    expect(gi('git branch --delete release/1.2')).toMatchObject({ kind: 'branch-delete', targets: ['release/1.2'] })
    expect(gi('git branch -d feature/x')).toMatchObject({ kind: 'branch-delete', targets: ['feature/x'] })
    expect(gi('git branch -m main old')).toMatchObject({ kind: 'branch-delete', targets: ['main'] })
    expect(gi('git branch -m new-name')).toMatchObject({ kind: 'branch-delete', targets: ['HEAD'] })
  })
})

describe('repoDir', () => {
  test('cwd, cd, -C, unknown cwd and --git-dir', () => {
    expect(gi('cd ~/code/ops; git commit -m x')?.repoDir).toBe(`${ROOT}/ops`)
    expect(gi('git -C ~/code/vendor-sdk commit -m x')?.repoDir).toBe(`${ROOT}/vendor-sdk`)
    expect(gi('cd "$X" && git commit')?.repoDir).toBeNull()
    expect(gi('git --git-dir=/x/.git commit')?.repoDir).toBeNull()
    expect(gi('git --work-tree /x commit')).toMatchObject({ kind: 'commit', repoDir: null })
    expect(gi('git -c user.name=x commit')).toMatchObject({ kind: 'commit', repoDir: API })
  })
})
