/**
 * Verification: just-bash must see the same files as the workspace tools
 * and isomorphic-git. This is the foundation for deleting the grep/find
 * tools — once bash can search the same FS, they are redundant.
 *
 * What this proves end-to-end:
 *   1. The LightningFsAdapter satisfies just-bash's IFileSystem contract.
 *   2. A file written via the workspace (lightning-fs) is readable in bash.
 *   3. A file written in bash is readable via the workspace.
 *   4. Pipes work (`grep foo | wc -l`) — the capability grep/find tools lack.
 *   5. The same MemoryWorkspace instance backs both — single source of truth.
 */

import { describe, expect, it } from 'vitest'
import { Bash } from 'just-bash'
import { MemoryWorkspace } from './memory-workspace'
import { LightningFsAdapter } from './just-bash-fs-adapter'

const WORKSPACE = '/workspace'

async function freshWorkspace(): Promise<MemoryWorkspace> {
  const ws = new MemoryWorkspace()
  await ws.ready()
  // Seed a few files so searches have something to find.
  await ws.writeFile(`${WORKSPACE}/a.ts`, 'export const foo = 1\nexport const bar = 2\n')
  await ws.writeFile(`${WORKSPACE}/b.ts`, 'export const baz = 3\n// foo mention\n')
  await ws.writeFile(`${WORKSPACE}/readme.md`, '# Project\nUses foo and bar.\n')
  return ws
}

function bashOn(ws: MemoryWorkspace): Bash {
  // Both sides share the SAME lightning-fs instance via the adapter.
  // cwd = /workspace so bash commands operate where the files live.
  return new Bash({
    fs: new LightningFsAdapter(ws.fs as unknown as ConstructorParameters<typeof LightningFsAdapter>[0]) as unknown as ConstructorParameters<typeof Bash>[0] extends { fs?: infer F } ? F : never,
    cwd: WORKSPACE,
    executionLimits: { maxExecutionTimeMs: 10_000 },
    // defenseInDepth hooks node:module.registerHooks, which workerd does
    // not implement; and in tests it false-positives on setTimeout.
    // The Worker isolate IS the security boundary (matches Computer's
    // ShellWorker config).
    defenseInDepth: { enabled: false } as unknown as ConstructorParameters<typeof Bash>[0] extends { defenseInDepth?: infer D } ? D : never,
  })
}

describe('just-bash over lightning-fs (single source of truth)', () => {
  it('bash reads files written by the workspace tools', async () => {
    const ws = await freshWorkspace()
    const bash = bashOn(ws)

    const result = await bash.exec('cat a.ts')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('export const foo = 1')
  })

  it('workspace reads files written in bash', async () => {
    const ws = await freshWorkspace()
    const bash = bashOn(ws)

    await bash.exec("echo 'bash-written content' > from-bash.txt")

    const content = await ws.readFile(`${WORKSPACE}/from-bash.txt`)
    expect(content).toBe('bash-written content\n')
  })

  it('pipes work — the capability grep/find tools lack', async () => {
    const ws = await freshWorkspace()
    const bash = bashOn(ws)

    // grep across files, pipe to wc — impossible with the current
    // `grep` tool (which returns structured matches, not lines, and
    // does not compose).
    const result = await bash.exec('grep -rn foo *.ts | wc -l')
    expect(result.exitCode).toBe(0)
    // 'foo' appears in a.ts (1 line) and b.ts (comment line) = 2 matches.
    expect(result.stdout.trim()).toBe('2')
  })

  it('bash edits are visible to subsequent workspace reads and bash reads', async () => {
    const ws = await freshWorkspace()
    const bash = bashOn(ws)

    await bash.exec("sed -i 's/foo/FOO/' a.ts")

    // bash sees its own change
    const bashView = await bash.exec('cat a.ts')
    expect(bashView.stdout).toContain('export const FOO = 1')

    // workspace tools see the same change — proving no data duplication
    const wsView = await ws.readFile(`${WORKSPACE}/a.ts`)
    expect(wsView).toContain('export const FOO = 1')
  })

  it('ls and find see workspace-written files', async () => {
    const ws = await freshWorkspace()
    const bash = bashOn(ws)

    const ls = await bash.exec('ls /workspace')
    expect(ls.exitCode).toBe(0)
    expect(ls.stdout).toContain('a.ts')
    expect(ls.stdout).toContain('readme.md')

    const find = await bash.exec('find /workspace -name "*.ts" | sort')
    expect(find.stdout).toContain('/workspace/a.ts')
    expect(find.stdout).toContain('/workspace/b.ts')
  })

  it('jq works over lightning-fs (data processing pipes)', async () => {
    const ws = await freshWorkspace()
    const bash = bashOn(ws)
    await ws.writeFile(
      `${WORKSPACE}/data.json`,
      JSON.stringify({ users: [{ name: 'Alice' }, { name: 'Bob' }] }),
    )

    const result = await bash.exec("jq -r '.users[].name' data.json | sort")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('Alice\nBob\n')
  })
})

describe('bash curl (fetch-backed)', () => {
  it('curl fetches a URL and the body reaches stdout', async () => {
    const ws = await freshWorkspace()
    // curl needs a `fetch` option to be registered. We build a Bash with
    // a stub SecureFetch so the test does not hit the network.
    const fetched: string[] = []
    const stubFetch = async (url: string) => {
      fetched.push(url)
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
        body: new TextEncoder().encode('hello from the stub\n'),
        url,
      }
    }
    const bash = new Bash({
      fs: new LightningFsAdapter(ws.fs as never) as never,
      cwd: WORKSPACE,
      defenseInDepth: { enabled: false } as never,
      executionLimits: { maxExecutionTimeMs: 5_000 },
      fetch: stubFetch as never,
    })
    const r = await bash.exec('curl -s https://example.test/ | tr a-z A-Z')
    expect(r.exitCode).toBe(0)
    expect(fetched).toContain('https://example.test/')
    expect(r.stdout).toContain('HELLO FROM THE STUB')
  })
})
