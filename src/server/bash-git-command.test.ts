/**
 * Real-git alignment tests for the bash `git` command.
 *
 * The strategy: shell out to real `git ls-remote` on the same repo, then
 * run our bash git command, and compare byte-for-byte. This catches any
 * drift in ref ordering, oid format, or flag filtering.
 *
 * Skipped automatically when `git` is not on PATH (CI environments
 * without git, or the Worker runtime itself — these tests run under
 * Node/vitest, never inside the Worker).
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { defineBashGitCommand } from './bash-git-command'
import { MemoryGitClient } from './memory-git'
import { MemoryWorkspace } from './memory-workspace'

// A small, stable, public repo with a manageable ref count.
const REPO_URL = 'https://github.com/yu1745/ic2-fabric'
const WORKSPACE_ROOT = '/workspace'

const hasGit = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Build a fresh MemoryGitClient over a fresh in-memory workspace. */
function freshGit(): MemoryGitClient {
  const ws = new MemoryWorkspace()
  // ready() is async; MemoryGitClient methods call ensureDir themselves,
  // so we don't strictly need it here. Construct directly.
  return new MemoryGitClient(ws)
}

/** Invoke the bash git custom command with argv, return its stdout/stderr/exitCode. */
async function runGit(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = defineBashGitCommand({
    git: freshGit(),
    workspaceRoot: WORKSPACE_ROOT,
  })
  // The custom-command executor shape: defineCommand returns a Command
  // whose execute runs with (args, ctx). We call the underlying handler
  // directly to avoid spinning up a full Bash instance for these tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (cmd as any).execute ?? (cmd as any).run ?? cmd
  if (typeof handler === 'function') {
    // some just-bash versions expose the executor on .execute
    return handler(argv, { cwd: WORKSPACE_ROOT, fs: undefined, env: new Map(), stdin: '', limits: {}, exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) })
  }
  throw new Error('could not resolve custom command executor')
}

describe.skipIf(!hasGit)('bash git ls-remote — byte-for-byte alignment with real git', () => {
  it('default output matches real `git ls-remote` line-by-line', async () => {
    const real = execSync(`git ls-remote ${REPO_URL}`, { encoding: 'utf8' }).replace(/\r\n/g, '\n')

    const result = await runGit(['ls-remote', REPO_URL])
    expect(result.exitCode).toBe(0)

    // Real git appends a trailing newline; our command does too. Compare
    // the full string (not just set equality) so ordering regressions
    // also surface.
    expect(result.stdout).toBe(real)
  }, 30_000)

  it('--heads matches real git --heads (as a sorted set)', async () => {
    // We compare as sorted sets here because prefix-filtered ls-remote
    // order is server-determined and identical in practice, but sorting
    // makes the test robust to incidental reordering.
    const real = execSync(`git ls-remote --heads ${REPO_URL}`, { encoding: 'utf8' })
      .replace(/\r\n/g, '\n').trim().split('\n').filter(Boolean).sort()

    const result = await runGit(['ls-remote', '--heads', REPO_URL])
    expect(result.exitCode).toBe(0)
    const ours = result.stdout.trim().split('\n').filter(Boolean).sort()
    expect(ours).toEqual(real)
  }, 30_000)

  it('--tags matches real git --tags (as a sorted set)', async () => {
    const real = execSync(`git ls-remote --tags ${REPO_URL}`, { encoding: 'utf8' })
      .replace(/\r\n/g, '\n').trim().split('\n').filter(Boolean).sort()

    const result = await runGit(['ls-remote', '--tags', REPO_URL])
    expect(result.exitCode).toBe(0)
    const ours = result.stdout.trim().split('\n').filter(Boolean).sort()
    expect(ours).toEqual(real)
  }, 30_000)
})

describe('bash git command — surface and error handling', () => {
  it('rejects unsupported subcommands', async () => {
    for (const sub of ['status', 'log', 'diff', 'branch', 'remote', 'tag', 'checkout', 'add', 'commit', 'push', 'pull']) {
      const result = await runGit([sub])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/not supported/i)
    }
  })

  it('clone with no url prints usage and exits 1', async () => {
    const result = await runGit(['clone'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/usage: git clone/)
  })

  it('ls-remote with no url prints usage and exits 1', async () => {
    const result = await runGit(['ls-remote'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/usage: git ls-remote/)
  })
})
