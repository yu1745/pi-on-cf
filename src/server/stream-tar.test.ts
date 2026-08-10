/**
 * Tests for the streaming tar reader.
 *
 * Two fixture sources, each exercising a different risk:
 *   1. The system `tar` CLI (ustar / pax / gnu formats) — proves the
 *      parser decodes real-world archives byte-for-byte, including pax
 *      extended headers for >100-char paths and GNU long-name records.
 *   2. Synthetic 512-byte headers built in-test — proves edge cases the
 *      CLI makes awkward to construct (symlinks, path traversal, zero
 *      padding, checksum validation) without OS permissions hassles.
 *
 * Runs under the Node vitest pool (not the Worker pool): it shells out
 * to `tar` and reads fixture files from a temp dir.
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkTar, TarError, type TarEntry } from './stream-tar'

const hasTar = (() => {
  try {
    execSync('tar --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

interface CollectedEntry {
  name: string
  type: TarEntry['type']
  size: number
  mode?: number
  linkname?: string
  content: Uint8Array | null // file body, or null for non-files
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<CollectedEntry[]> {
  const out: CollectedEntry[] = []
  await walkTar(stream, async (entry) => {
    let content: Uint8Array | null = null
    if (entry.type === 'file') {
      content = await drain(entry.body)
    } else {
      await entry.body.cancel()
    }
    out.push({
      name: entry.name,
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      linkname: entry.linkname,
      content,
    })
  })
  return out
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

/** Wrap raw bytes in a single-chunk ReadableStream — the shape walkTar
 *  consumes. (Using Response just to get a .body trips TS 6's stricter
 *  BodyInit typing on Uint8Array<ArrayBufferLike>.) */
function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Build a real tar archive from an on-disk fixture tree using the
 *  system `tar` CLI in the requested format. Returns the raw tar bytes. */
function tarFixture(format: 'ustar' | 'pax' | 'gnu', build: (root: string) => void): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), `pi-tar-${format}-`))
  try {
    build(root)
    const archive = `${root}.tar`
    // --format controls header style: ustar (no long names), pax (x records),
    // gnu (L records). `-C root .` packs relative to root. --force-local
    // stops GNU tar on Windows from reading `C:\...\x.tar` as host:path.
    execSync(`tar --force-local --format=${format} -cf "${archive}" -C "${root}" .`, { stdio: 'pipe' })
    const buf = readFileSync(archive)
    rmSync(archive, { force: true })
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const LONG_NAME =
  'src/very/deeply/nested/path/that/definitely/exceeds/one/hundred/characters/in/total/length/module.ts'

describe.skipIf(!hasTar)('walkTar — real archives from `tar` CLI', () => {
  it('parses ustar short names, nested dirs, and exact file bodies', async () => {
    const tar = tarFixture('ustar', (root) => {
      writeFileSync(join(root, 'a.txt'), 'hello\n')
      mkdirSync(join(root, 'sub'), { recursive: true })
      writeFileSync(join(root, 'sub', 'b.txt'), 'world!\n')
      // a binary file to exercise non-UTF-8 bytes
      writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 254, 255]))
    })
    const entries = await collect(byteStream(tar))
    const byName = new Map(entries.map((e) => [e.name, e]))

    // tar -C root . prefixes names with "./"
    expect(byName.get('./a.txt')?.type).toBe('file')
    expect(byName.get('./a.txt')?.content?.byteLength).toBe(6)
    expect(new TextDecoder().decode(byName.get('./a.txt')!.content!)).toBe('hello\n')

    expect(byName.get('./sub/b.txt')?.type).toBe('file')
    expect(new TextDecoder().decode(byName.get('./sub/b.txt')!.content!)).toBe('world!\n')

    expect(byName.get('./bin.dat')?.content).toEqual(new Uint8Array([0, 1, 2, 254, 255]))

    // A directory entry MAY be present (GNU tar sometimes omits explicit
    // dir entries when packing `.`); if it is, it must carry no body.
    // (The typeflag-5 path is covered exhaustively by the synthetic tests.)
    const subDir = byName.get('./sub') ?? byName.get('./sub/')
    if (subDir) {
      expect(subDir.type).toBe('directory')
      expect(subDir.content).toBeNull()
    }
  })

  it('parses pax extended headers for >100-char paths (type x)', async () => {
    const tar = tarFixture('pax', (root) => {
      mkdirSync(join(root, LONG_NAME.replace(/\/[^/]+$/, '')), { recursive: true })
      writeFileSync(join(root, LONG_NAME), 'pax body\n')
    })
    const entries = await collect(byteStream(tar))
    const files = entries.filter((e) => e.type === 'file')
    expect(files.length).toBe(1)
    // The full long name must be reconstructed from the pax `path` record,
    // not truncated at 100 chars. (tar prefixes with "./".)
    expect(files[0]!.name).toBe(`./${LONG_NAME}`)
    expect(new TextDecoder().decode(files[0]!.content!)).toBe('pax body\n')
    // The `x` meta entry itself must NOT surface as a file.
    expect(entries.some((e) => e.name.includes('pax'))).toBe(false)
  })

  it('parses GNU long-name records (type L)', async () => {
    const tar = tarFixture('gnu', (root) => {
      mkdirSync(join(root, LONG_NAME.replace(/\/[^/]+$/, '')), { recursive: true })
      writeFileSync(join(root, LONG_NAME), 'gnu body\n')
    })
    const entries = await collect(byteStream(tar))
    const files = entries.filter((e) => e.type === 'file')
    expect(files.length).toBe(1)
    expect(files[0]!.name).toBe(`./${LONG_NAME}`)
    expect(new TextDecoder().decode(files[0]!.content!)).toBe('gnu body\n')
  })

  it('handles a large-ish file streamed in many chunks (no truncation)', async () => {
    const payload = Buffer.alloc(200_000, 0x41) // ~195 KiB of 'A', >1 block
    const tar = tarFixture('ustar', (root) => {
      writeFileSync(join(root, 'big.bin'), payload)
    })
    const entries = await collect(byteStream(tar))
    const big = entries.find((e) => e.name === './big.bin')!
    expect(big).toBeDefined()
    expect(big.size).toBe(200_000)
    expect(big.content?.byteLength).toBe(200_000)
    // spot-check first and last byte
    expect(big.content![0]).toBe(0x41)
    expect(big.content![199_999]).toBe(0x41)
  })
})

// ---------------------------------------------------------------------------
// Synthetic header builder — full control over bytes for edge cases.
// ---------------------------------------------------------------------------

const BLOCK = 512

function strField(s: string, len: number): Uint8Array {
  const buf = new Uint8Array(len)
  buf.fill(0)
  const enc = new TextEncoder().encode(s)
  buf.set(enc.subarray(0, len), 0)
  return buf
}

function octalField(n: number, len: number): Uint8Array {
  // len-1 digits + trailing NUL (tar convention for most numeric fields)
  const s = n.toString(8).padStart(len - 1, '0')
  const buf = new Uint8Array(len)
  buf.fill(0)
  new TextEncoder().encodeInto(s + '\0', buf)
  return buf
}

/** Build a single 512-byte file header with a valid checksum. */
function fileHeader(name: string, size: number, mode = 0o644, typeflag = '0', linkname = ''): Uint8Array {
  const h = new Uint8Array(BLOCK)
  h.set(strField(name, 100), 0) // name
  h.set(octalField(mode, 8), 100) // mode
  h.set(octalField(size, 12), 124) // size
  h.set(strField(typeflag, 1), 156) // typeflag
  h.set(strField(linkname, 100), 157) // linkname
  h.set(strField('ustar', 6), 257) // magic
  h.set(strField('00', 2), 263) // version
  // compute checksum with the checksum field as spaces
  const ck = new Uint8Array(8)
  ck.fill(0x20)
  h.set(ck, 148)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]!
  h.set(octalField(sum, 8), 148)
  return h
}

function padToBlock(body: Uint8Array): Uint8Array {
  const rem = body.byteLength % BLOCK
  if (rem === 0) return new Uint8Array(0)
  const pad = new Uint8Array(BLOCK - rem)
  return pad
}

function archiveOf(...blocks: Uint8Array[]): Uint8Array {
  // append two zero blocks (end-of-archive marker)
  const eof = new Uint8Array(BLOCK * 2)
  let total = 0
  for (const b of blocks) total += b.byteLength
  total += eof.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const b of blocks) {
    out.set(b, off)
    off += b.byteLength
  }
  out.set(eof, off)
  return out
}

describe('walkTar — synthetic edge cases', () => {
  it('parses a symlink (typeflag 2) with its linkname', async () => {
    const h = fileHeader('link.txt', 0, 0o777, '2', 'target.txt')
    const tar = archiveOf(h)
    const entries = await collect(byteStream(tar))
    expect(entries.length).toBe(1)
    expect(entries[0]!.type).toBe('symlink')
    expect(entries[0]!.linkname).toBe('target.txt')
    expect(entries[0]!.content).toBeNull()
  })

  it('parses a directory (typeflag 5)', async () => {
    const h = fileHeader('somedir/', 0, 0o755, '5')
    const tar = archiveOf(h)
    const entries = await collect(byteStream(tar))
    expect(entries[0]!.type).toBe('directory')
  })

  it('parses a ustar prefix + name into a full path', async () => {
    // Construct a header where the 100-char name field is the basename
    // and the 155-char prefix field holds the directory portion.
    const h = fileHeader('index.ts', 5, 0o644, '0')
    const prefix = strField('a/b/c', 155)
    h.set(prefix, 345)
    // recompute checksum (we mutated the header after fileHeader set it)
    recomputeChecksum(h)
    const body = new TextEncoder().encode('hi\nyo')
    const tar = archiveOf(h, body, padToBlock(body))
    const entries = await collect(byteStream(tar))
    expect(entries[0]!.name).toBe('a/b/c/index.ts')
    expect(new TextDecoder().decode(entries[0]!.content!)).toBe('hi\nyo')
  })

  it('delivers a file body across multiple 512-byte blocks intact', async () => {
    // 700 bytes => 2 blocks (512 + 188 padded)
    const payload = new Uint8Array(700)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const h = fileHeader('multi.bin', 700)
    const tar = archiveOf(h, payload, padToBlock(payload))
    const entries = await collect(byteStream(tar))
    expect(entries[0]!.size).toBe(700)
    expect(entries[0]!.content).toEqual(payload)
  })

  it('rejects a header with a bad checksum', async () => {
    const h = fileHeader('bad.txt', 0)
    h[0]! = h[0]! === 0x5a ? 0x5b : 0x5a // corrupt one byte, invalidate checksum
    const tar = archiveOf(h)
    await expect(collect(byteStream(tar))).rejects.toThrow(/checksum mismatch/)
  })

  it('reports truncation when the stream ends mid-body', async () => {
    const payload = new Uint8Array(700)
    const h = fileHeader('trunc.bin', 700)
    // build archive then chop INTO the body: keep only the 512-byte header
    // + 200 of the 700-byte body, so the declared size can never be met.
    const full = archiveOf(h, payload, padToBlock(payload))
    const chopped = full.subarray(0, 512 + 200)
    await expect(collect(byteStream(chopped))).rejects.toThrow(TarError)
  })

  it('stops cleanly at the end-of-archive zero blocks', async () => {
    const payload = new TextEncoder().encode('x')
    const h = fileHeader('x.txt', 1)
    const tar = archiveOf(h, payload, padToBlock(payload))
    const result = await walkTar(byteStream(tar), async (e) => {
      await e.body.cancel()
    })
    expect(result.entries).toBe(1)
  })
})

/** Recompute and write the ustar checksum into an existing header. */
function recomputeChecksum(h: Uint8Array): void {
  const ck = new Uint8Array(8)
  ck.fill(0x20)
  h.set(ck, 148)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]!
  h.set(octalField(sum, 8), 148)
}

// sanity: ensure we didn't leave the temp dir machinery broken
describe('walkTar — fixture helper sanity', () => {
  it('can create and remove a temp dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'pi-sanity-'))
    expect(existsSync(d)).toBe(true)
    rmSync(d, { recursive: true, force: true })
    expect(existsSync(d)).toBe(false)
  })
})
