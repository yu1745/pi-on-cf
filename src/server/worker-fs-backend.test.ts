/**
 * Streaming-write primitive tests: WorkerBackend.openWrite via
 * MemoryWorkspace.openWrite. Verifies chunked append (including across
 * the 1 MiB segment-merge boundary) reconstructs the exact file body,
 * that stat size is correct, and that mixed openWrite + normal reads
 * interoperate on the same filesystem.
 */

import { describe, it, expect } from 'vitest'
import { MemoryWorkspace } from './memory-workspace'

const WORKSPACE = '/workspace'

describe('MemoryWorkspace.openWrite — streaming writes', () => {
  it('assembles a small file from several chunks', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    const w = ws.openWrite(`${WORKSPACE}/small.txt`, { mode: 0o644 })
    await w.append(new TextEncoder().encode('hel'))
    await w.append(new TextEncoder().encode('lo '))
    await w.append(new TextEncoder().encode('world\n'))
    await w.close()

    const content = await ws.readFile(`${WORKSPACE}/small.txt`)
    expect(content).toBe('hello world\n')
    const stat = await ws.stat(`${WORKSPACE}/small.txt`)
    expect(stat?.size).toBe(12)
    expect(stat?.type).toBe('file')
  })

  it('handles an empty file (zero appends)', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    const w = ws.openWrite(`${WORKSPACE}/empty.bin`)
    await w.close()
    const bytes = await ws.readFileBytes(`${WORKSPACE}/empty.bin`)
    expect(bytes).not.toBeNull()
    expect(bytes!.byteLength).toBe(0)
  })

  it('reconstructs a >1 MiB file across the merge boundary with no data loss', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    // ~2.5 MiB total, fed in 64 KiB chunks — crosses the 1 MiB freeze
    // boundary several times and exercises multi-segment concatenation.
    const totalLen = (1 << 20) * 2 + 12345
    const chunkLen = 1 << 16
    const w = ws.openWrite(`${WORKSPACE}/big.bin`)
    let off = 0
    let seq = 0
    while (off < totalLen) {
      const take = Math.min(chunkLen, totalLen - off)
      const chunk = new Uint8Array(take)
      for (let i = 0; i < take; i++) chunk[i] = (seq + i) % 251
      await w.append(chunk)
      off += take
      seq += take
    }
    await w.close()

    const bytes = await ws.readFileBytes(`${WORKSPACE}/big.bin`)
    expect(bytes!.byteLength).toBe(totalLen)
    // verify every byte against the same generation function, in one pass
    // (a per-byte `expect` over 2.5M elements is prohibitively slow).
    const expected = new Uint8Array(totalLen)
    for (let i = 0; i < totalLen; i++) expected[i] = i % 251
    // readFile decorates the returned Uint8Array with a custom toString,
    // which trips toEqual's deep equality; Buffer.equals compares only
    // the raw bytes (native, fast).
    expect(Buffer.from(bytes!).equals(Buffer.from(expected))).toBe(true)
    const stat = await ws.stat(`${WORKSPACE}/big.bin`)
    expect(stat?.size).toBe(totalLen)
  })

  it('creates parent directories implicitly', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    const w = ws.openWrite(`${WORKSPACE}/a/b/c/deep.txt`)
    await w.append(new TextEncoder().encode('down deep'))
    await w.close()
    expect(await ws.readFile(`${WORKSPACE}/a/b/c/deep.txt`)).toBe('down deep')
  })

  it('is visible to lightning-fs readdir/stat on the same instance', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    const w = ws.openWrite(`${WORKSPACE}/via-stream.txt`)
    await w.append(new TextEncoder().encode('stream\n'))
    await w.close()
    // readdir through the lightning-fs promises surface must see it.
    const names = await ws.fs.promises.readdir(WORKSPACE)
    expect(names).toContain('via-stream.txt')
    // and a normal writeFile file is visible alongside
    await ws.writeFile(`${WORKSPACE}/via-normal.txt`, 'normal\n')
    const names2 = await ws.fs.promises.readdir(WORKSPACE)
    expect(names2.sort()).toEqual(['via-normal.txt', 'via-stream.txt'])
  })

  it('persists mode bits through close', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    const w = ws.openWrite(`${WORKSPACE}/exec.sh`, { mode: 0o755 })
    await w.append(new TextEncoder().encode('#!/bin/sh\n'))
    await w.close()
    const stat = (await ws.fs.promises.stat(`${WORKSPACE}/exec.sh`)) as { mode: number }
    // lightning-fs returns mode as given (low 12 bits here, no type bits)
    expect((stat.mode & 0o777)).toBe(0o755)
  })

  it('throws when appending or closing twice', async () => {
    const ws = new MemoryWorkspace()
    await ws.ready()
    const w = ws.openWrite(`${WORKSPACE}/once.txt`)
    await w.append(new TextEncoder().encode('x'))
    await w.close()
    await expect(w.append(new Uint8Array([1]))).rejects.toThrow(/already closed/)
    await expect(w.close()).rejects.toThrow(/already closed/)
  })
})
