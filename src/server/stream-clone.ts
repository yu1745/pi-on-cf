/**
 * Streaming `git clone` via GitHub codeload tarballs.
 *
 * isomorphic-git's clone collects the entire packfile into memory, then
 * builds .git, then checks out the working tree — all three resident at
 * once, which overflows a 128 MB Durable Object on modest repos. This
 * path bypasses isomorphic-git entirely for GitHub: it fetches the
 * codeload `tar.gz` archive and streams it through a gzip decompressor
 * and a streaming tar decoder straight into the in-memory workspace,
 * file by file. No packfile, no .git, no whole-archive buffer.
 *
 * Memory profile during the clone ≈ gzip internal buffer (~1 MiB) +
 * a few in-flight body chunks + the already-written files. The 128 MB
 * ceiling's "final judge" is the post-filter working-tree total; the
 * optional include/exclude filter is the lever to cut that down.
 *
 * Non-GitHub hosts are NOT handled here — streamClone throws
 * UnsupportedHostError and the caller (MemoryGitClient) falls back to
 * the isomorphic-git path. The archiveUrlFor seam is the extension
 * point for GitLab/Bitbucket/Gitea in a later pass.
 */

import path from 'node:path/posix'
import { walkTar, TarError, type TarEntry } from './stream-tar'
import type { MemoryWorkspace } from './memory-workspace'

/** Inclusion/exclusion globs applied to each entry's repo-relative path
 *  (the codeload top-level dir is stripped first). `*` matches within a
 *  path segment, `**` spans segments, `?` matches one non-slash char. */
export interface CloneFilter {
  /** Keep only entries matching at least one include glob. Omit/empty
   *  to keep everything (subject to exclude). */
  include?: string[]
  /** Drop any entry matching an exclude glob. Takes precedence over
   *  include when both match. */
  exclude?: string[]
}

export interface StreamCloneOptions {
  ws: MemoryWorkspace
  /** Normalized HTTPS URL (https://github.com/owner/repo[.git]). */
  url: string
  /** Absolute destination dir (e.g. /workspace/<name>). */
  dir: string
  /** Branch / tag / commit SHA. Required — resolve the default branch
   *  BEFORE calling this (the caller has the lsRemote surface). */
  ref: string
  /** Optional auth headers for private repos. */
  headers?: Record<string, string>
  /** Optional include/exclude filter. */
  filter?: CloneFilter
  /** Abort a single file larger than this many bytes. Default 64 MiB. */
  maxFileSize?: number
}

export interface StreamCloneResult {
  entries: number
  bytes: number
  ref: string
}

/** Thrown for any condition where the streaming path should defer to
 *  the isomorphic-git fallback: unsupported host, non-2xx fetch,
 *  non-gzip content, empty body, missing DecompressionStream. Always
 *  raised BEFORE any file is written, so the fallback starts clean. */
export class UnsupportedHostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedHostError'
  }
}

const DEFAULT_MAX_FILE_SIZE = 64 * 1024 * 1024 // 64 MiB

/**
 * Stream-clone a GitHub repository into the workspace. See module docs
 * for the memory rationale and the host/filter contract.
 */
export async function streamClone(opts: StreamCloneOptions): Promise<StreamCloneResult> {
  const { ws, url, dir, ref, headers, filter } = opts
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE

  const archiveUrl = archiveUrlFor(url, ref)
  if (archiveUrl === null) {
    throw new UnsupportedHostError(`streaming clone only supports github.com, got: ${url}`)
  }

  // DecompressionStream is global in Workers and Node ≥ 18. If the host
  // runtime lacks it, fall back rather than crash.
  const DecompressionCtor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream
  if (!DecompressionCtor) {
    throw new UnsupportedHostError('runtime has no DecompressionStream')
  }

  const response = await fetch(archiveUrl, { headers, redirect: 'follow' })
  if (!response.ok) {
    throw new UnsupportedHostError(`codeload ${response.status} ${response.statusText} for ${archiveUrl}`)
  }
  if (!response.body) {
    throw new UnsupportedHostError(`codeload response has no body for ${archiveUrl}`)
  }
  // codeload serves application/gzip (and occasionally x-gzip / octet-stream).
  // Require a gzip-ish content type so we don't try to gunzip plain bytes.
  const ctype = response.headers.get('content-type') ?? ''
  if (!/gzip/i.test(ctype) && !/octet-stream/i.test(ctype)) {
    throw new UnsupportedHostError(`codeload returned unexpected content-type "${ctype}"`)
  }

  const matchers = filter ? compileFilter(filter) : undefined
  let entries = 0
  let bytes = 0

  const decompressed = response.body.pipeThrough(new DecompressionCtor('gzip'))

  await walkTar(decompressed, async (entry: TarEntry) => {
    // Strip the codeload top-level dir (e.g. "repo-abc123/...").
    const rel = stripTopDir(entry.name)
    if (rel === null) return // the root dir entry itself — nothing to write
    const safe = sanitizeRelativePath(rel)
    if (safe === null) {
      // Path traversal / absolute / NUL — refuse to materialise this
      // entry but keep going (a single hostile entry shouldn't abort
      // an otherwise-valid archive from a trusted host).
      console.warn(`[stream-clone] rejecting unsafe entry path: ${entry.name}`)
      return
    }

    // Filter decision is made BEFORE consuming the body so skipped
    // entries cost only header bytes, not their full body.
    if (matchers && !matchers.keep(safe)) {
      await entry.body.cancel()
      return
    }

    const dest = path.join(dir, safe)

    if (entry.type === 'file') {
      if (entry.size > maxFileSize) {
        throw new TarError(`file exceeds maxFileSize (${maxFileSize}): ${entry.name} is ${entry.size} bytes`)
      }
      await ws.mkdir(path.dirname(dest), { recursive: true })
      const writer = ws.openWrite(dest, { mode: entry.mode })
      const reader = entry.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        await writer.append(value)
      }
      await writer.close()
      bytes += entry.size
    } else if (entry.type === 'directory') {
      await ws.mkdir(dest, { recursive: true })
    } else if (entry.type === 'symlink') {
      await ws.mkdir(path.dirname(dest), { recursive: true })
      try {
        await ws.fs.promises.symlink(entry.linkname ?? '', dest)
      } catch {
        // already exists or target invalid — best effort
      }
    } else if (entry.type === 'hardlink') {
      // tar hardlinks reference another archived path; copy its current
      // bytes (forward references are skipped best-effort).
      const target = entry.linkname ? path.join(dir, stripTopDir(entry.linkname) ?? entry.linkname) : ''
      const data = target ? await ws.readFileBytes(target) : null
      if (data) {
        await ws.mkdir(path.dirname(dest), { recursive: true })
        await ws.fs.promises.writeFile(dest, data)
        bytes += data.byteLength
      }
    }
    // 'other' (char/block/fifo devices) — ignored in a userspace FS.
    entries += 1
  })

  return { entries, bytes, ref }
}

/**
 * Build a codeload tarball URL for a GitHub repo, or null if the host
 * is not github.com (the only host with a stable codeload endpoint we
 * support today). This is the extension point for other forges.
 */
export function archiveUrlFor(normalizedUrl: string, ref: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(normalizedUrl)
  } catch {
    return null
  }
  if (parsed.hostname !== 'github.com') return null
  const segments = parsed.pathname.replace(/\.git$/, '').replace(/\/$/, '').split('/').filter(Boolean)
  if (segments.length < 2) return null
  const [owner, repo] = segments
  // ref may contain slashes (e.g. tags/v1.0); codeload accepts it raw.
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`
}

/** Drop the first path segment (the codeload top-level dir). Returns
 *  null if there is no slash (the entry IS the top-level dir). */
function stripTopDir(name: string): string | null {
  const slash = name.indexOf('/')
  if (slash === -1) return null
  return name.slice(slash + 1)
}

/** Validate a repo-relative path: reject absolute, backslash, NUL,
 *  Windows drive letters, and any `..` segment. Returns the path if
 *  safe, null otherwise. */
function sanitizeRelativePath(rel: string): string | null {
  if (!rel) return null
  if (rel[0] === '/' || rel[0] === '\\') return null
  if (rel.includes('\0') || rel.includes('\\')) return null
  if (/^[a-zA-Z]:/.test(rel)) return null
  for (const part of rel.split('/')) {
    if (part === '..') return null
  }
  return rel
}

interface CompiledFilter {
  keep(rel: string): boolean
}

/** Compile include/exclude globs into a single keep()/drop() decision.
 *  exclude wins over include. */
function compileFilter(filter: CloneFilter): CompiledFilter {
  const include = filter.include?.filter(Boolean).map(compileGlobPattern) ?? []
  const exclude = filter.exclude?.filter(Boolean).map(compileGlobPattern) ?? []
  return {
    keep(rel: string): boolean {
      if (exclude.some((m) => m(rel))) return false
      if (include.length > 0 && !include.some((m) => m(rel))) return false
      return true
    },
  }
}

/** Glob → RegExp. Supports `**` (spans `/`), `*` (within a segment),
 *  and `?` (one non-slash char). Anchored to the whole string. */
function compileGlobPattern(pattern: string): (candidate: string) => boolean {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2
        // consume a trailing slash so "a/**/b" matches "a/b" too
        if (pattern[i] === '/') i++
        re += '.*'
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  const regexp = new RegExp(`^(?:${re})$`)
  return (candidate: string): boolean => regexp.test(candidate)
}
