/**
 * Integration tests for streamClone: fetch a real gzip+tar codeload-style
 * archive (mocked fetch), stream it through gzip+tar into a workspace,
 * and assert the files land correctly. Also covers archiveUrlFor host
 * routing, the include/exclude filter, the maxFileSize guard, and the
 * non-GitHub fallback error.
 *
 * Runs under the Node vitest pool (not the Worker pool): it shells out
 * to `tar` to build a realistic archive and mocks globalThis.fetch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamClone, archiveUrlFor, UnsupportedHostError } from './stream-clone'
import { MemoryWorkspace } from './memory-workspace'

const hasTar = (() => {
  try {
    execSync('tar --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const WORKSPACE = '/workspace'

interface Fixture {
  /** Raw tar.gz bytes, mimicking a codeload archive (top-level `repo-x/`). */
  archive: Uint8Array
  /** The top-level dir name embedded in the archive. */
  top: string
}

/** Build a gzip+tar archive whose entries are `<top>/...`, just like a
 *  codeload tarball. Returns the raw .tar.gz bytes. */
function buildFixture(top = 'repo-x'): Fixture {
  const parent = mkdtempSync(join(tmpdir(), 'pi-clone-'))
  try {
    mkdirSync(join(parent, top, 'src'), { recursive: true })
    writeFileSync(join(parent, top, 'a.txt'), 'alpha\n')
    writeFileSync(join(parent, top, 'README.md'), '# Repo X\n')
    writeFileSync(join(parent, top, 'src', 'b.ts'), 'export const b = 1\n')
    writeFileSync(join(parent, top, 'src', 'c.ts'), 'export const c = 2\n')
    writeFileSync(join(parent, top, 'big.bin'), Buffer.alloc(100_000, 0x42))
    const archive = `${parent}.tar.gz`
    execSync(`tar --force-local -czf "${archive}" -C "${parent}" ${top}`, { stdio: 'pipe' })
    const buf = readFileSync(archive)
    rmSync(archive, { force: true })
    return {
      archive: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      top,
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

/** Mock globalThis.fetch to return `bytes` as a gzip body. */
function mockFetch(bytes: Uint8Array, contentType = 'application/gzip') {
  const original = globalThis.fetch
  // TS 6's stricter BodyInit typing rejects Uint8Array<ArrayBufferLike>
  // directly; the runtime accepts it fine, so cast through BodyInit.
  const body = bytes as unknown as BodyInit
  globalThis.fetch = (async () =>
    new Response(body, { headers: { 'content-type': contentType } })) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

describe('archiveUrlFor — host routing', () => {
  it('builds a codeload URL for github.com', () => {
    expect(archiveUrlFor('https://github.com/owner/repo', 'main')).toBe(
      'https://codeload.github.com/owner/repo/tar.gz/main',
    )
  })

  it('strips a trailing .git', () => {
    expect(archiveUrlFor('https://github.com/owner/repo.git', 'v1.0')).toBe(
      'https://codeload.github.com/owner/repo/tar.gz/v1.0',
    )
  })

  it('accepts refs containing slashes (tags/foo)', () => {
    expect(archiveUrlFor('https://github.com/o/r', 'tags/v1.0')).toBe(
      'https://codeload.github.com/o/r/tar.gz/tags/v1.0',
    )
  })

  it('returns null for non-github hosts (fallback trigger)', () => {
    expect(archiveUrlFor('https://gitlab.com/o/r', 'main')).toBeNull()
    expect(archiveUrlFor('https://bitbucket.org/o/r', 'main')).toBeNull()
  })

  it('returns null for malformed URLs', () => {
    expect(archiveUrlFor('not a url', 'main')).toBeNull()
  })
})

describe.skipIf(!hasTar)('streamClone — end to end', () => {
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    restoreFetch = undefined
  })
  afterEach(() => {
    restoreFetch?.()
  })

  it('streams a full archive into the workspace with correct contents', async () => {
    const fx = buildFixture()
    restoreFetch = mockFetch(fx.archive)
    const ws = new MemoryWorkspace()
    await ws.ready()

    const result = await streamClone({
      ws,
      url: 'https://github.com/owner/repo',
      dir: `${WORKSPACE}/myrepo`,
      ref: 'main',
    })
    expect(result.ref).toBe('main')
    expect(result.entries).toBeGreaterThan(0)

    // top-level dir is stripped; files land under the destination dir
    expect(await ws.readFile(`${WORKSPACE}/myrepo/a.txt`)).toBe('alpha\n')
    expect(await ws.readFile(`${WORKSPACE}/myrepo/README.md`)).toBe('# Repo X\n')
    expect(await ws.readFile(`${WORKSPACE}/myrepo/src/b.ts`)).toBe('export const b = 1\n')
    // binary file body intact
    const big = await ws.readFileBytes(`${WORKSPACE}/myrepo/big.bin`)
    expect(big!.byteLength).toBe(100_000)
    expect(big![0]).toBe(0x42)
    expect(big![99_999]).toBe(0x42)
    // no .git directory from the streaming path
    expect(await ws.stat(`${WORKSPACE}/myrepo/.git`)).toBeNull()
  })

  it('keeps only --include matches and drops --exclude matches', async () => {
    const fx = buildFixture()
    restoreFetch = mockFetch(fx.archive)
    const ws = new MemoryWorkspace()
    await ws.ready()

    await streamClone({
      ws,
      url: 'https://github.com/owner/repo',
      dir: `${WORKSPACE}/filtered`,
      ref: 'main',
      filter: { include: ['src/**/*.ts'], exclude: ['**/c.ts'] },
    })

    // b.ts matches include and not exclude → present
    expect(await ws.readFile(`${WORKSPACE}/filtered/src/b.ts`)).toBe('export const b = 1\n')
    // c.ts matches include but ALSO exclude (exclude wins) → absent
    expect(await ws.readFile(`${WORKSPACE}/filtered/src/c.ts`)).toBeNull()
    // a.ts doesn't match include → absent
    expect(await ws.readFile(`${WORKSPACE}/filtered/a.txt`)).toBeNull()
    expect(await ws.readFile(`${WORKSPACE}/filtered/README.md`)).toBeNull()
  })

  it('throws UnsupportedHostError for non-github hosts (fallback trigger)', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    await expect(
      streamClone({
        ws,
        url: 'https://gitlab.com/owner/repo',
        dir: `${WORKSPACE}/gl`,
        ref: 'main',
      }),
    ).rejects.toBeInstanceOf(UnsupportedHostError)
  })

  it('throws UnsupportedHostError on a non-2xx fetch', async () => {
    restoreFetch = () => {}
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch
    try {
      const ws = new MemoryWorkspace()
      await ws.ready()
      await expect(
        streamClone({
          ws,
          url: 'https://github.com/owner/repo',
          dir: `${WORKSPACE}/miss`,
          ref: 'main',
        }),
      ).rejects.toBeInstanceOf(UnsupportedHostError)
    } finally {
      globalThis.fetch = original
    }
  })

  it('aborts when a single file exceeds maxFileSize', async () => {
    const fx = buildFixture()
    restoreFetch = mockFetch(fx.archive)
    const ws = new MemoryWorkspace()
    await ws.ready()
    await expect(
      streamClone({
        ws,
        url: 'https://github.com/owner/repo',
        dir: `${WORKSPACE}/capped`,
        ref: 'main',
        maxFileSize: 1000, // big.bin is 100_000 → must trip the guard
      }),
    ).rejects.toThrow(/maxFileSize/)
  })
})
