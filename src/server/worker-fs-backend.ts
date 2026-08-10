/**
 * Worker-safe in-memory backend for @isomorphic-git/lightning-fs.
 *
 * Why this exists: lightning-fs's DefaultBackend (used when you pass
 * `db:` instead of `backend:`) depends on IndexedDB or the Web Locks
 * API for its mutex. Neither exists in the Cloudflare Workers runtime,
 * so DefaultBackend throws on activate(). MemoryBackend alone is only
 * the storage layer (5 methods); it does not satisfy the full backend
 * interface that `options.backend` requires.
 *
 * This backend wires lightning-fs's CacheFS (the in-memory directory
 * tree) to an in-memory Map<inode, Uint8Array> for file bodies. No
 * IndexedDB, no mutex, no debounce, no persistence. Single-threaded DO
 * usage means no concurrent access — the mutex was solving a problem
 * we don't have.
 *
 * Data lifetime: everything lives in JS heap. When the DO is evicted,
 * all of it is gone. That is the intended "ephemeral session" design.
 *
 * Why no LRU / size cap: CacheFS holds directory stats only (tens of
 * bytes per node); file bodies live in the Map and are only removed by
 * explicit unlink. A 10k-file repo costs ~1MB of stat metadata plus
 * the raw file bytes — bounded by what git clone wrote, no hidden
 * eviction. The DO's 128MB soft ceiling is the only limit, and that
 * is enforced by the platform (OOM reset), not by us silently dropping
 * data.
 */

import CacheFS from '@isomorphic-git/lightning-fs/src/CacheFS.js'
import path from '@isomorphic-git/lightning-fs/src/path.js'
import { ENOENT } from '@isomorphic-git/lightning-fs/src/errors.js'

/**
 * Streaming write handle returned by WorkerBackend.openWrite().
 *
 * lightning-fs has no append() — writeFile replaces the whole file in
 * one shot, so it cannot absorb a file that arrives in many chunks
 * (e.g. a tar entry decoded incrementally from a gzip stream). This
 * handle lets a caller feed a file chunk-by-chunk and only materialise
 * the contiguous body once, at close().
 *
 * Buffering strategy: small inbound chunks accumulate in `cur`; once
 * `cur` reaches ~1 MiB it is frozen into a single owned segment. This
 * bounds the live "small chunk" list to ~1 MiB and keeps the per-append
 * cost O(chunk) instead of O(file-so-far) (which a naive "concat the
 * growing blob on every append" would be). At close(), the frozen
 * segments are concatenated once into the final contiguous body that
 * _files stores. The final body is an owned copy, so callers may pass
 * subarray views (e.g. from a stream reader) without aliasing.
 */
export interface FileWriter {
  /** Append a chunk. Zero-length chunks are ignored. Must be called on
   *  an open writer; throws after close(). */
  append(chunk: Uint8Array): Promise<void>
  /** Finalise the file: merge all segments, update the stat size, and
   *  store the body. The writer is unusable afterwards. */
  close(): Promise<void>
}

/** Threshold at which the current chunk accumulator is frozen into a
 *  single owned ~1 MiB segment. Tuned so a freeze never copies more
 *  than ~1 MiB + one inbound chunk, keeping incremental peak bounded. */
const SEGMENT_MERGE_THRESHOLD = 1 << 20 // 1 MiB

/** Concatenate an array of Uint8Arrays into one contiguous buffer of
 *  exactly totalLen bytes. Returns a fresh, owned array. */
function concatChunks(chunks: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

export class WorkerBackend {
  private _cache = new CacheFS()
  /** inode → file bytes. Source of truth between writes. */
  private _files = new Map<number, Uint8Array>()

  async init(_name: string): Promise<void> {
    // no-op
  }

  async activate(): Promise<void> {
    if (this._cache.activated) return
    // Always start fresh on the FIRST activation only. Subsequent
    // activate/deactivate cycles (PromisifiedFS auto-deactivates 500ms
    // after the last operation) must NOT wipe state — for an in-memory
    // backend the JS heap IS the storage, so clearing it on deactivate
    // would destroy everything between every pair of git operations.
    this._cache.activate()
  }

  async deactivate(): Promise<void> {
    // Intentionally a no-op: we keep _cache and _files resident in
    // memory. PromisifiedFS calls deactivate() 500ms after idle; if we
    // honoured it by clearing state, a clone's fetch (network-bound,
    // seconds-long) would always trigger a wipe mid-flight.
  }

  // ---------- reads ----------

  async readFile(filepath: string, opts: { encoding?: 'utf8' } | 'utf8' | undefined): Promise<Uint8Array | string> {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding
    if (encoding && encoding !== 'utf8') throw new Error(`unsupported encoding: ${String(encoding)}`)
    let stat: { ino: number }
    try {
      stat = this._cache.stat(filepath) as { ino: number }
    } catch {
      throw new ENOENT(filepath)
    }
    const data = this._files.get(stat.ino)
    if (!data) throw new ENOENT(filepath)
    if (encoding === 'utf8') return new TextDecoder().decode(data)
    const copy = data.slice()
    ;(copy as unknown as { toString: () => string }).toString = () => new TextDecoder().decode(data)
    return copy
  }

  readdir(filepath: string): string[] {
    return this._cache.readdir(filepath)
  }

  stat(filepath: string): unknown {
    return this._cache.stat(filepath)
  }

  lstat(filepath: string): unknown {
    return this._cache.lstat(filepath)
  }

  readlink(filepath: string): string {
    return this._cache.readlink(filepath)
  }

  // ---------- writes ----------

  /**
   * Open a streaming writer for `filepath`. Allocates the inode and a
   * zero-byte placeholder up front (so the file exists immediately),
   * then returns a FileWriter that absorbs chunks via append() and
   * finalises the body + stat size at close(). Parent directories are
   * created as needed (mirrors writeFile's ensureParents).
   *
   * Prefer this over writeFile when a file's contents arrive in many
   * pieces (streaming decode) — it avoids holding N copies while a
   * single large buffer is assembled by the caller.
   */
  openWrite(filepath: string, opts: { mode?: number } | undefined): FileWriter {
    const mode = opts?.mode ?? 0o666
    this.ensureParents(filepath)
    // Allocate the inode with a placeholder size of 0 so the file is
    // observable (stat/readdir) immediately. close() rewrites the size.
    const initial = this._cache.writeStat(filepath, 0, { mode }) as { ino: number }
    const ino = initial.ino
    this._files.set(ino, new Uint8Array(0))

    let segments: Uint8Array[] = [] // frozen ~1 MiB owned segments
    let cur: Uint8Array[] = [] // current accumulator of inbound chunks
    let curLen = 0 // byte length of `cur`
    let total = 0 // total bytes appended
    let closed = false

    const freeze = (): void => {
      if (cur.length === 0) return
      segments.push(cur.length === 1 ? cur[0]!.slice() : concatChunks(cur, curLen))
      cur = []
      curLen = 0
    }

    return {
      append: async (chunk: Uint8Array) => {
        if (closed) throw new Error(`FileWriter already closed: ${filepath}`)
        if (chunk.byteLength === 0) return
        cur.push(chunk)
        curLen += chunk.byteLength
        total += chunk.byteLength
        if (curLen >= SEGMENT_MERGE_THRESHOLD) freeze()
      },
      close: async () => {
        if (closed) throw new Error(`FileWriter already closed: ${filepath}`)
        closed = true
        freeze()
        const final =
          segments.length === 0
            ? new Uint8Array(0)
            : segments.length === 1
              ? segments[0]!
              : concatChunks(segments, total)
        // Rewrite the stat with the real size. writeStat reuses the
        // existing inode (oldStat path) so _files key stays stable.
        this._cache.writeStat(filepath, final.byteLength, { mode })
        this._files.set(ino, final)
        segments = []
        if (import.meta.env.DEV) this.logMem()
      },
    }
  }

  async writeFile(filepath: string, data: Uint8Array | string, opts: { mode?: number; encoding?: 'utf8' } | undefined): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const mode = opts?.mode ?? 0o666
    this.ensureParents(filepath)
    // CacheFS.writeStat owns inode allocation/reuse entirely. It returns
    // a stat object whose `.ino` is the canonical key for this file.
    // We must NOT second-guess it (a previous version allocated its own
    // inode and overwrote stat.ino, which desynced CacheFS's stat lookup
    // from the _files map and made files vanish after rewrites).
    const stat = this._cache.writeStat(filepath, bytes.byteLength, { mode }) as { ino: number; type: string }
    this._files.set(stat.ino, bytes)
    if (import.meta.env.DEV) this.logMem()
  }

  async unlink(filepath: string): Promise<void> {
    let stat
    try {
      stat = this._cache.lstat(filepath) as { ino: number; type: string }
    } catch {
      throw new ENOENT(filepath)
    }
    this._cache.unlink(filepath)
    if (stat.type !== 'symlink') this._files.delete(stat.ino)
  }

  mkdir(filepath: string, opts: { mode?: number } | undefined): void {
    this._cache.mkdir(filepath, { mode: opts?.mode ?? 0o777 })
  }

  rmdir(filepath: string): void {
    if (filepath === '/') {
      const err = new Error('ENOTEMPTY: /') as Error & { code: string }
      err.code = 'ENOTEMPTY'
      throw err
    }
    this._cache.rmdir(filepath)
  }

  rename(oldFilepath: string, newFilepath: string): void {
    this._cache.rename(oldFilepath, newFilepath)
  }

  symlink(target: string, filepath: string): void {
    this._cache.symlink(target, filepath)
  }

  du(filepath: string): number {
    return this._cache.du(filepath) as number
  }

  flush(): Promise<void> {
    // no-op — everything is already in memory, nothing to flush.
    return Promise.resolve()
  }

  /** Called by PromisifiedFS after every mutation. DefaultBackend uses
   *  this to debounce-persist the CacheFS root to IndexedDB; for us
   *  the CacheFS *is* the source of truth (in memory), so it's a no-op.
   *  Must exist so PromisifiedFS's `this._backend.saveSuperblock()`
   *  doesn't throw. */
  saveSuperblock(): void {
    // no-op
  }

  /** Dev-only memory accounting. Prints total file-content bytes held
   *  in the in-memory Map and, when available, the isolate's heap
   *  usage. Cheap enough for dev; gated on import.meta.env.DEV so it
   *  is stripped from production builds. */
  private logMem(): void {
    let contentBytes = 0
    for (const b of this._files.values()) contentBytes += b.byteLength
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`
    // Workers expose deviceMemory; heap limits come from performance.memory
    // where available. Numbers are approximate.
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory
    const heap = mem ? `heap used=${mb(mem.usedJSHeapSize ?? 0)} limit=${mb(mem.jsHeapSizeLimit ?? 0)}` : 'heap=n/a'
    console.log(`[fs:mem] files=${this._files.size} content=${mb(contentBytes)} | ${heap}`)
  }

  // ---------- helpers ----------

  private ensureParents(filepath: string): void {
    const dirparts = path.split(path.dirname(filepath))
    let dir = dirparts.shift() as string
    for (const dirpart of dirparts) {
      dir = path.join(dir, dirpart)
      try {
        this._cache.mkdir(dir, { mode: 0o777 })
      } catch {
        // exists
      }
    }
  }
}
