/** Bash parser tests: splitting, quoting, wrappers, nested shells, cwd tracking and the PR-merge and recursive-search argv helpers. */
import { describe, expect, test } from 'claude-code/testing'
import { commandName, ghPrMerge, parseBash, resolvePath, searchRoots } from '../src/bash'

const HOME = '/home/dev'
const ROOT = `${HOME}/code`
const API = `${ROOT}/api`

/** argv lists of every segment, for compact assertions. */
const argvs = (cmd: string, cwd = API): string[][] => parseBash(cmd, cwd, HOME).map((s) => s.argv)
/** Effective cwd of every segment. */
const cwds = (cmd: string, cwd = API): (string | null)[] => parseBash(cmd, cwd, HOME).map((s) => s.cwd)

describe('splitting and quoting', () => {
  test('splits on && || ; | & and newlines', () => {
    expect(argvs('a && b || c; d | e & f\ng')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']])
  })

  test('&& and ; inside a quoted commit message do not split', () => {
    expect(argvs(`git commit -m "a && b; c" && git push`)).toEqual([['git', 'commit', '-m', 'a && b; c'], ['git', 'push']])
    expect(argvs(`git commit -m 'x || y'`)).toEqual([['git', 'commit', '-m', 'x || y']])
  })

  test('backslash escapes and line continuations', () => {
    expect(argvs('echo a\\;b \\\n c')).toEqual([['echo', 'a;b', 'c']])
  })

  test('heredoc commit message is not parsed as commands', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfix: don't push origin main && terraform apply\n)\nEOF\n)" && git status`
    expect(argvs(cmd).map((a) => a[0] === 'git' ? a.slice(0, 2) : a)).toEqual([['cat'], ['git', 'commit'], ['git', 'status']])
  })

  test('comments are dropped', () => {
    expect(argvs('ls # && terraform apply')).toEqual([['ls']])
  })

  test('redirect targets go to redirects, fd dups are ignored', () => {
    const [seg] = parseBash(`echo hi > ~/code/vendor-sdk/x 2>&1`, API, HOME)
    expect(seg.argv).toEqual(['echo', 'hi'])
    expect(seg.redirects).toEqual([`${ROOT}/vendor-sdk/x`])
    expect(parseBash('cat <<< "terraform" >> out.txt', API, HOME)[0].redirects).toEqual(['out.txt'])
  })
})

describe('false-positive guards', () => {
  test('quoted text that mentions git push stays an argument', () => {
    expect(argvs('echo "git push origin main"')).toEqual([['echo', 'git push origin main']])
    expect(argvs(`git log --grep "push origin develop"`)).toEqual([['git', 'log', '--grep', 'push origin develop']])
  })

  test('command -v terraform is a lookup, not a run', () => {
    expect(argvs('command -v terraform')).toEqual([['command', '-v', 'terraform']])
  })
})

describe('wrappers and env assignments (blocked-command cases)', () => {
  test('plain, after cd, after env assignments', () => {
    expect(argvs('terraform apply x')).toEqual([['terraform', 'apply', 'x']])
    expect(argvs('cd x && terraform apply x')[1]).toEqual(['terraform', 'apply', 'x'])
    expect(argvs('FOO=1 BAR="a b" terraform apply x')).toEqual([['terraform', 'apply', 'x']])
  })

  test('env, sudo, nohup, time, timeout, xargs, command', () => {
    expect(argvs('env -i FOO=1 terraform apply x')).toEqual([['terraform', 'apply', 'x']])
    expect(argvs('sudo -u root nohup time terraform apply x')).toEqual([['terraform', 'apply', 'x']])
    expect(argvs('timeout -s KILL 5 terraform apply x')).toEqual([['terraform', 'apply', 'x']])
    expect(argvs('echo x | xargs -n 1 terraform apply')[1]).toEqual(['terraform', 'apply'])
    expect(argvs('command terraform apply x')).toEqual([['terraform', 'apply', 'x']])
    expect(commandName(['/usr/local/bin/terraform'])).toBe('terraform')
  })

  test('sh -c, bash -lc, zsh -c and eval recurse into the string', () => {
    expect(argvs(`sh -c "terraform apply x"`)).toEqual([['terraform', 'apply', 'x']])
    expect(argvs(`bash -lc 'git push origin main'`)).toEqual([['git', 'push', 'origin', 'main']])
    expect(argvs(`zsh -o pipefail -c "a && terraform x"`)).toEqual([['a'], ['terraform', 'x']])
    expect(argvs(`eval "git push origin main"`)).toEqual([['git', 'push', 'origin', 'main']])
    expect(argvs(`bash -c "bash -c 'terraform apply x'"`)).toEqual([['terraform', 'apply', 'x']])
    expect(argvs('bash script.sh')).toEqual([['bash', 'script.sh']])
  })

  test('$(...) and backtick bodies become extra segments', () => {
    expect(argvs('echo $(git push origin main)')).toEqual([['git', 'push', 'origin', 'main'], ['echo', '$(git push origin main)']])
    expect(argvs('echo "`terraform apply x`"')[0]).toEqual(['terraform', 'apply', 'x'])
    expect(argvs('x=$(cd /tmp && git push origin main)')).toEqual([['cd', '/tmp'], ['git', 'push', 'origin', 'main']])
  })
})

describe('effective cwd', () => {
  test('cd absolute, relative, ~ and $HOME update later segments', () => {
    expect(cwds('cd ~/code/ops; git commit')).toEqual([API, `${ROOT}/ops`])
    expect(cwds('cd ../web && ls')).toEqual([API, `${ROOT}/web`])
    expect(cwds('cd /tmp && cd sub && ls')[2]).toBe('/tmp/sub')
    expect(cwds('cd "$HOME/code/archive" && ls')[1]).toBe(`${ROOT}/archive`)
    expect(cwds('cd && ls')[1]).toBe(HOME)
  })

  test('the home passed in is what ~ and $HOME expand to', () => {
    expect(parseBash('cd ~/x && cd ${HOME}/y', '/', '/Users/other').map((s) => s.cwd)).toEqual(['/', '/Users/other/x'])
  })

  test('unknown cwd: cd "$X", cd -, pushd, ~user', () => {
    expect(cwds('cd "$X" && git commit')[1]).toBeNull()
    expect(cwds('cd "$X" && ls')[1]).toBeNull()
    expect(cwds('cd - && ls')[1]).toBeNull()
    expect(cwds('pushd /tmp && ls')[1]).toBeNull()
    expect(cwds('cd ~bob && ls')[1]).toBeNull()
  })

  test('git -C overrides cwd for that segment only, and stacks', () => {
    expect(cwds('git -C ~/code/vendor-sdk commit -m x; git status')).toEqual([`${ROOT}/vendor-sdk`, API])
    expect(cwds('git -C ~/code -C ops push')).toEqual([`${ROOT}/ops`])
    expect(cwds('git -C "$D" commit')).toEqual([null])
    expect(cwds('cd "$X"; git -C /abs/repo commit')[1]).toBe('/abs/repo')
  })

  test('subshells, pipes and background jobs do not move the shell', () => {
    expect(cwds('(cd ~/code/worktrees/x && git commit); git commit')).toEqual([API, `${ROOT}/worktrees/x`, API])
    expect(cwds('cd /tmp | cat; git commit')[2]).toBe(API)
    expect(cwds('cd /tmp & git commit')[1]).toBe(API)
  })

  test('a conditional cd makes the cwd unknown after its list ends', () => {
    expect(cwds('false && cd ~/code/worktrees/x; git commit')[2]).toBeNull()
    expect(cwds('make && cd /tmp && git commit')[2]).toBe('/tmp')
    expect(cwds('cd /nope || git commit')[1]).toBeNull()
    expect(cwds('cd /tmp || exit 1; git commit')[2]).toBe('/tmp')
  })
})

describe('resolvePath', () => {
  test('lexical resolution and the null cases', () => {
    expect(resolvePath(API, '../ops/./x', HOME)).toBe(`${ROOT}/ops/x`)
    expect(resolvePath(null, '/abs', HOME)).toBe('/abs')
    expect(resolvePath(null, '~/x', HOME)).toBe(`${HOME}/x`)
    expect(resolvePath(null, 'rel', HOME)).toBeNull()
    expect(resolvePath(API, '$X/y', HOME)).toBeNull()
    expect(resolvePath(API, '*.go', HOME)).toBeNull()
  })
})

describe('searchRoots', () => {
  const roots = (cmd: string, cwd = ROOT) => searchRoots(parseBash(cmd, cwd, HOME)[0], HOME)
  test('grep -r / -R / --recursive with and without paths', () => {
    expect(roots('grep -rn foo')).toEqual([ROOT])
    expect(roots('grep -R -e foo ~/code ~/code/api')).toEqual([ROOT, API])
    expect(roots('grep --recursive -A 3 foo api')).toEqual([API])
    expect(roots('grep foo file.txt')).toBeNull()
  })

  test('rg and find', () => {
    expect(roots('rg -g "*.go" foo')).toEqual([ROOT])
    expect(roots('rg --files ~/code')).toEqual([ROOT])
    expect(roots('rg foo api/backend', HOME)).toEqual([`${HOME}/api/backend`])
    expect(roots('find . -name "*.md"')).toEqual([ROOT])
    expect(roots('find -L ~/code api -type f')).toEqual([ROOT, API])
    expect(roots('find -name x', API)).toEqual([API])
  })

  test('not a search', () => {
    expect(roots('ls -R')).toBeNull()
  })
})

describe('ghPrMerge', () => {
  const pr = (cmd: string) => ghPrMerge(parseBash(cmd, API, HOME)[0])
  test('selector and repo', () => {
    expect(pr('gh pr merge 123 --squash')).toEqual({ pr: '123', repo: null })
    expect(pr('gh pr merge --squash -R org/api -t "subj" 45')).toEqual({ pr: '45', repo: 'org/api' })
    expect(pr('gh pr merge')).toEqual({ pr: null, repo: null })
    expect(pr('gh pr view 123')).toBeNull()
  })
})
