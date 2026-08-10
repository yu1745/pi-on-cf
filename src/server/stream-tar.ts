/**
 * Streaming tar (ustar / POSIX pax / GNU) reader.
 *
 * Zero dependencies. Consumes a ReadableStream<Uint8Array> of raw
 * (already decompressed) tar bytes and emits one entry per file/dir/
 * symlink/hardlink, handing the caller a pull-based body stream for
 * each regular file so it can be written incrementally without ever
 * buffering the whole archive (or the whole file) in memory.
 *
 * Why hand-rolled: isomorphic-git's _fetch collects the entire packfile
 * into memory before indexing — fine for small clones, fatal for a
 * 128 MB DO. A codeload tarball has no packfile and no .git, so decoding
 * it directly lets a clone peak at roughly (gzip internal buffer ~1 MiB)
 * + (already-written files) instead of packfile + .git + working tree.
 *
 * Coverage: ustar name+prefix, POSIX pax extended headers (`x`) with
 * path/linkpath/size overrides, pax global headers (`g`), GNU long-name
 * (`L`) and long-linkname (`K`) records, symlinks, hardlinks, dirs.
 * Two consecutive zero blocks mark end-of-archive. Checksum is verified.
 */

/** Logical entry type, collapsed from tar typeflags. */
export type TarType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other'

export interface TarEntry {
  /** Fully-resolved entry path: ustar name (+prefix), or a pax/GNU long
   *  name override. NEVER trust this for disk writes without the path
   *  sanitisation the caller is expected to apply (see walkTar docs). */
  name: string
  /** Body size in bytes (pax `size` overrides the ustar field). */
  size: number
  type: TarType
  /** Permission bits, if present in the header. */
  mode?: number
  /** Symlink/hardlink target, for type symlink/hardlink. */
  linkname?: string
  /** Body stream for regular files. Pull-based: bytes are read from the
   *  underlying stream only as the caller reads. EMPTY for non-files.
   *  The caller MUST drain this to completion (or cancel it) before the
   *  walkTar callback resolves — otherwise walkTar drains the leftover
   *  itself, but mid-archive desync is avoided by the pull contract. */
  body: ReadableStream<Uint8Array>
}

export interface WalkTarResult {
  /** Number of entries passed to onEntry (files/dirs/symlinks/...). */
  entries: number
  /** Total body bytes delivered across all file entries. */
  bytes: number
}

export class TarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarError'
  }
}

/** Chunk size pulled from the underlying stream per body read. Keeps the
 *  live "in-flight" body slice small (~64 KiB) for steady backpressure. */
const BODY_CHUNK = 1 << 16 // 64 KiB

/**
 * Walk a raw tar byte stream, invoking onEntry for each file/dir/symlink/
 * hardlink/other entry. pax `x`/`g` and GNU `L`/`K` meta records are
 * consumed internally and never reach onEntry.
 *
 * Contract for onEntry:
 *   - For file entries, drain `entry.body` to completion before resolving
 *     (read until done), or call `entry.body.cancel()` to skip it.
 *   - walkTar defensively drains any unconsumed body bytes + 512-byte
 *     padding after onEntry resolves, so a partial read won't desync the
 *     next header — but callers SHOULD drain fully to avoid wasted IO.
 *   - Returning is fire-and-forget; the decision to write is the caller's
 *     (walkTar never writes anything).
 *
 * Throws TarError on truncation, bad checksum, or a malformed header.
 */
export async function walkTar(
  stream: ReadableStream<Uint8Array>,
  onEntry: (entry: TarEntry) => Promise<void>,
): Promise<WalkTarResult> {
  const reader = new ByteReader(stream)
  // pax overrides pending for the NEXT entry (from an `x` header).
  let pending: PaxRecord = {}
  // pax globals applying to ALL subsequent entries (from a `g` header).
  let globals: PaxRecord = {}
  let entries = 0
  let bytes = 0

  for (;;) {
    const header = await reader.readExactly(512)
    if (header === null) break // clean EOF
    if (isZeroBlock(header)) {
      // End-of-archive: GNU/ustar terminate with two zero blocks. We stop
      // at the first (every conformant writer emits at least one), which
      // matches the behaviour of libarchive / gnu tar readers.
      break
    }
    verifyChecksum(header)
    const raw = parseHeader(header)

    // ---- meta records: consume body, update state, no onEntry ----
    if (raw.typeflag === 'x' || raw.typeflag === 'g') {
      const rec = await readPaxBody(reader, raw.size)
      if (raw.typeflag === 'g') globals = { ...globals, ...rec }
      else pending = { ...pending, ...rec }
      await reader.skipExactly(paddingFor(raw.size))
      continue
    }
    if (raw.typeflag === 'L') {
      // GNU long name: body is the next entry's full name (NUL-terminated).
      pending.path = (await readStringBody(reader, raw.size)).replace(/\0.*$/, '')
      await reader.skipExactly(paddingFor(raw.size))
      continue
    }
    if (raw.typeflag === 'K') {
      pending.linkpath = (await readStringBody(reader, raw.size)).replace(/\0.*$/, '')
      await reader.skipExactly(paddingFor(raw.size))
      continue
    }

    // ---- concrete entry: resolve name/linkname/size with pax+globals ----
    const name = resolveName(globals.path ?? pending.path, raw)
    const linkname = globals.linkpath ?? pending.linkpath ?? raw.linkname
    const size = resolveSize(globals.size ?? pending.size, raw.size)
    const type = typeflagToType(raw.typeflag)
    // pax/GNU overrides apply to exactly one entry; clear pending.
    pending = {}

    if (type === 'file') {
      const consumed = { n: 0 }
      const body = makeBodyStream(reader, size, consumed)
      await onEntry({
        name,
        size,
        type,
        mode: raw.mode,
        linkname,
        body,
      })
      // Drain whatever onEntry left unread + trailing padding.
      const leftover = size - consumed.n
      if (leftover > 0) await reader.skipExactly(leftover)
      await reader.skipExactly(paddingFor(size))
      bytes += consumed.n
    } else {
      // dir / symlink / hardlink / other: no body in the archive.
      await onEntry({
        name,
        size,
        type,
        mode: raw.mode,
        linkname,
        body: new ReadableStream({ start(c) { c.close() } }),
      })
      // These types carry zero body bytes (size is normally 0), but pad
      // anyway in case a writer stuffed data into a non-file entry.
      await reader.skipExactly(paddingFor(size))
    }
    entries += 1
  }

  return { entries, bytes }
}

// ---------------------------------------------------------------------------
// ByteReader: block-oriented reader over a ReadableStream<Uint8Array>.
// ---------------------------------------------------------------------------

class ByteReader {
  private buf: Uint8Array = new Uint8Array(0)
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private eof = false

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  /** Pull from the source until at least `need` bytes are buffered (or
   *  the stream ends). Returns true if `need` bytes are available. */
  private async ensure(need: number): Promise<boolean> {
    while (this.buf.byteLength < need && !this.eof) {
      const { value, done } = await this.reader.read()
      if (done) {
        this.eof = true
        break
      }
      if (value && value.byteLength > 0) {
        this.buf = this.buf.byteLength ? concatTwo(this.buf, value) : value
      }
    }
    return this.buf.byteLength >= need
  }

  /** Read exactly `n` bytes. Returns null on a clean EOF at a block
   *  boundary (nothing buffered, nothing more coming). Throws TarError
   *  if some but not enough bytes remain (truncation). Returned array
   *  is an owned copy, safe to retain. */
  async readExactly(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0)
    const ok = await this.ensure(n)
    if (!ok) {
      if (this.buf.byteLength === 0) return null
      throw new TarError(`truncated header: wanted ${n} bytes, have ${this.buf.byteLength}`)
    }
    const out = this.buf.subarray(0, n).slice()
    this.buf = this.buf.subarray(n)
    return out
  }

  /** Discard exactly `n` bytes without materialising them. Used for file
   *  bodies the caller chose to skip and for trailing block padding. */
  async skipExactly(n: number): Promise<void> {
    let remaining = n
    while (remaining > 0) {
      // Only buffer up to a cap per round so `buf` never holds a whole
      // skipped file — keep it bounded to a small scratch window.
      const want = Math.min(remaining, BODY_CHUNK)
      const ok = await this.ensure(want)
      if (!ok) throw new TarError(`truncated body: wanted ${n} bytes, ${remaining} unread`)
      const take = Math.min(remaining, this.buf.byteLength)
      this.buf = this.buf.subarray(take)
      remaining -= take
    }
  }

  /** Read up to `maxLen` bytes of a file body (pull-based). Returns null
   *  at clean EOF. Returned array is an owned copy. */
  async readBodyChunk(maxLen: number): Promise<Uint8Array | null> {
    if (this.buf.byteLength === 0) {
      const ok = await this.ensure(1)
      if (!ok) return null
    }
    const take = Math.min(maxLen, this.buf.byteLength)
    const out = this.buf.subarray(0, take).slice()
    this.buf = this.buf.subarray(take)
    return out
  }
}

function concatTwo(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

// ---------------------------------------------------------------------------
// Header parsing.
// ---------------------------------------------------------------------------

interface RawHeader {
  name: string
  linkname: string
  prefix: string
  size: number
  mode?: number
  typeflag: string
}

const HEADER_SIZE = 512

function parseHeader(h: Uint8Array): RawHeader {
  const name = readString(h, 0, 100)
  const modeRaw = readString(h, 100, 8)
  const typeflag = readString(h, 156, 1)
  const linkname = readString(h, 157, 100)
  const prefix = readString(h, 345, 155)
  const mode = modeRaw.trim() ? parseInt(modeRaw.trim(), 8) : undefined
  return {
    name,
    linkname,
    prefix,
    size: parseOctalField(h.subarray(124, 136)),
    mode: Number.isNaN(mode) ? undefined : mode,
    typeflag: typeflag || '0', // empty typeflag ≡ regular file
  }
}

/** Parse an octal ASCII size field (124..136). Tolerates leading spaces /
 *  zeros and a trailing space or NUL. Falls back to base-256 (GNU) if the
 *  high bit is set, supporting files larger than 8 GiB. */
function parseOctalField(field: Uint8Array): number {
  // GNU base-256: high bit of first byte set => big-endian, lower 7 bits
  // of each subsequent byte. Rare (codeload uses octal) but cheap to handle.
  if (field.length > 0 && (field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!
    return value
  }
  const text = readString(field, 0, field.length).trim()
  if (text === '') return 0
  const n = parseInt(text, 8)
  if (Number.isNaN(n)) throw new TarError(`invalid tar size field: "${text}"`)
  return n
}

function readString(buf: Uint8Array, offset: number, len: number): string {
  let end = offset + len
  for (let i = offset; i < end; i++) {
    if (buf[i] === 0) {
      end = i
      break
    }
  }
  return new TextDecoder('utf8', { fatal: false }).decode(buf.subarray(offset, end))
}

function isZeroBlock(h: Uint8Array): boolean {
  for (let i = 0; i < HEADER_SIZE; i++) if (h[i] !== 0) return false
  return true
}

/** Verify the ustar checksum. Sum of all 512 bytes with the 8 checksum
 *  bytes treated as ASCII spaces, compared to the stored octal value. */
function verifyChecksum(h: Uint8Array): void {
  let sum = 0
  for (let i = 0; i < HEADER_SIZE; i++) {
    // bytes 148..155 are the checksum field itself; counted as spaces.
    sum += i >= 148 && i < 156 ? 0x20 : h[i]!
  }
  const stored = parseOctalField(h.subarray(148, 156))
  if (sum !== stored) {
    throw new TarError(`tar header checksum mismatch: stored=${stored} computed=${sum} name="${readString(h, 0, 100)}"`)
  }
}

function typeflagToType(flag: string): TarType {
  switch (flag) {
    case '0':
    case '':
    case '7': // contiguous file — treat as regular
      return 'file'
    case '1':
      return 'hardlink'
    case '2':
      return 'symlink'
    case '5':
      return 'directory'
    default:
      return 'other'
  }
}

/** Resolve the entry name: pax/GNU override wins; else ustar prefix+name. */
function resolveName(override: string | undefined, raw: RawHeader): string {
  if (override) return override
  const { prefix, name } = raw
  return prefix ? `${prefix}/${name}` : name
}

/** Resolve the entry size: a pax `size` record overrides the ustar field. */
function resolveSize(override: number | undefined, rawSize: number): number {
  return override ?? rawSize
}

/** Bytes of zero padding following a body of `size` bytes (tar rounds
 *  every entry up to a 512-byte block boundary). */
function paddingFor(size: number): number {
  return size % HEADER_SIZE === 0 ? 0 : HEADER_SIZE - (size % HEADER_SIZE)
}

// ---------------------------------------------------------------------------
// pax extended header parsing.
// ---------------------------------------------------------------------------

type PaxRecord = Partial<{ path: string; linkpath: string; size: number }>

/** Read exactly `size` bytes of a pax/x or g record body and parse the
 *  "len key=value\n" records it contains. */
async function readPaxBody(reader: ByteReader, size: number): Promise<PaxRecord> {
  const body = await reader.readExactly(size)
  if (body === null || body.byteLength < size) {
    throw new TarError('truncated pax extended header body')
  }
  return parsePaxRecords(body)
}

function parsePaxRecords(body: Uint8Array): PaxRecord {
  const text = new TextDecoder('utf8', { fatal: false }).decode(body)
  const rec: PaxRecord = {}
  let i = 0
  while (i < text.length) {
    // Each record: "<len> <key>=<value>\n" where len is the decimal
    // length of the WHOLE record including the len field and the space.
    const space = text.indexOf(' ', i)
    if (space === -1) break
    const len = parseInt(text.slice(i, space), 10)
    if (!Number.isFinite(len) || len <= 0 || i + len > text.length) break
    const record = text.slice(i, i + len)
    const eq = record.indexOf('=')
    const nl = record.lastIndexOf('\n')
    if (eq !== -1 && nl !== -1) {
      const key = record.slice(space - i + 1, eq)
      const value = record.slice(eq + 1, nl)
      if (key === 'path') rec.path = value
      else if (key === 'linkpath') rec.linkpath = value
      else if (key === 'size') rec.size = parseInt(value, 10)
    }
    i += len
  }
  return rec
}

/** Read exactly `size` bytes and decode as UTF-8 (for GNU L/K name bodies). */
async function readStringBody(reader: ByteReader, size: number): Promise<string> {
  const body = await reader.readExactly(size)
  if (body === null) throw new TarError('truncated GNU long-name body')
  return new TextDecoder('utf8', { fatal: false }).decode(body)
}

// ---------------------------------------------------------------------------
// Body stream factory.
// ---------------------------------------------------------------------------

/** Build a pull-based ReadableStream over `size` bytes of the underlying
 *  tar stream. `consumed` is mutated as bytes are pulled so walkTar can
 *  drain any leftover after onEntry returns. */
function makeBodyStream(reader: ByteReader, size: number, consumed: { n: number }): ReadableStream<Uint8Array> {
  let remaining = size
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        controller.close()
        return
      }
      if (remaining <= 0) {
        controller.close()
        return
      }
      const want = Math.min(BODY_CHUNK, remaining)
      const chunk = await reader.readBodyChunk(want)
      if (chunk === null || chunk.byteLength === 0) {
        // Stream ended before the declared body size was delivered. This
        // is a truncated archive, not a clean EOF — surface it so the
        // caller doesn't silently receive a short file.
        controller.error(new TarError(`truncated file body: got ${size - remaining} of ${size} bytes`))
        return
      }
      remaining -= chunk.byteLength
      consumed.n += chunk.byteLength
      controller.enqueue(chunk)
      if (remaining <= 0) controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
}
