/**
 * Thin git facade over isomorphic-git, bound to a MemoryWorkspace's fs.
 *
 * Replaces @cloudflare/computer/git (which wraps isomorphic-git through
 * @platformatic/vfs → dofs). Here isomorphic-git reads/writes the
 * MemoryWorkspace directly via its `promises` adapter, so every git
 * object read or working-tree write stays in memory — zero storage IO.
 *
 * SECURITY / READ-ONLY MODEL:
 * Only *read-only* subcommands are wired up: clone, status, log, diff,
 * show, branch, remote, tag. Mutating operations (add / commit / push /
 * pull, branch/tag/remote *creation*, reset, merge, rebase, stash,
 * checkout, updateIndex) are deliberately absent, so the agent can
 * never modify a repository and — critically — can never push to or
 * otherwise alter a remote.
 *
 * Of the methods below the only network operation is `clone`, which is a
 * read-only fetch of a repository into the ephemeral in-memory workspace.
 * Everything else reads local git objects or the local working tree.
 */

import * as isogit from 'isomorphic-git'
import type { MemoryWorkspace } from './memory-workspace'

export interface GitAuth {
  username: string
  password: string
}

export interface CloneOptions {
  url: string
  dir: string
  ref?: string
  headers?: Record<string, string>
}

export interface DiffOptions {
  dir: string
  /** Commit/tag/ref to diff against; defaults to HEAD. */
  ref?: string
  /** Restrict the diff to these repository-relative paths. */
  paths?: string[]
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted'

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  additions: number
  deletions: number
  lines: Array<{ type: '+' | '-' | ' '; text: string }>
}

export interface FileDiff {
  path: string
  status: DiffFileStatus
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

export interface DiffResult {
  changes: FileDiff[]
  summary: string
}

export class MemoryGitClient {
  constructor(private ws: MemoryWorkspace) {}

  private get fs() {
    return this.ws.promises
  }

  /** isomorphic-git assumes the working-tree `dir` already exists (it
   *  writes `.git/` beneath it, then checks out files). Our in-memory
   *  filesystem starts empty, so every git operation ensures the dir
   *  (and its parents) exists first. Cheap: pure Map/Set updates. */
  private async ensureDir(dir: string): Promise<void> {
    await this.ws.mkdir(dir, { recursive: true })
  }

  async clone(opts: CloneOptions): Promise<void> {
    await this.ensureDir(opts.dir)
    // isomorphic-git needs an http transport; the browser build works in
    // Workers. Import lazily so the base bundle isn't penalised.
    const http = (await import('isomorphic-git/http/web')).default
    await isogit.clone({
      fs: this.fs,
      http,
      dir: opts.dir,
      url: opts.url,
      ref: opts.ref,
      headers: opts.headers,
      depth: 1,
      singleBranch: true,
      noTags: true,
    })
  }

  async status(opts: { dir: string }): Promise<isogit.StatusRow[]> {
    await this.ensureDir(opts.dir)
    return isogit.statusMatrix({ fs: this.fs, dir: opts.dir })
  }

  async log(opts: { dir: string; depth?: number }): Promise<isogit.ReadCommitResult[]> {
    await this.ensureDir(opts.dir)
    return isogit.log({ fs: this.fs, dir: opts.dir, depth: opts.depth ?? 50 })
  }

  /** List local branch names (read-only). */
  async branches(dir: string): Promise<string[]> {
    await this.ensureDir(dir)
    return isogit.listBranches({ fs: this.fs, dir })
  }

  /** List configured remotes (read-only). */
  async remotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
    await this.ensureDir(dir)
    return isogit.listRemotes({ fs: this.fs, dir })
  }

  /** List repository tags (read-only). */
  async tags(dir: string): Promise<string[]> {
    await this.ensureDir(dir)
    return isogit.listTags({ fs: this.fs, dir })
  }

  /** Resolve HEAD to its commit oid (read-only); null when no commits. */
  async headOid(dir: string): Promise<string | null> {
    await this.ensureDir(dir)
    return isogit.resolveRef({ fs: this.fs, dir, ref: 'HEAD' }).catch(() => null)
  }

  /**
   * Working-tree vs HEAD diff (read-only, never touches a remote).
   *
   * Uses statusMatrix to find changed files, then compares the HEAD blob
   * (from the git object store via readBlob) against the live working-tree
   * file (from the in-memory fs). Returns per-file line hunks plus a
   * `--stat`-style summary.
   */
  async diff(opts: DiffOptions): Promise<DiffResult> {
    await this.ensureDir(opts.dir)
    const ref = opts.ref ?? 'HEAD'
    const headOid = await this.headOid(opts.dir)
    if (!headOid) {
      return { changes: [], summary: 'HEAD is unborn — no changes to diff against.' }
    }

    const rows = await isogit.statusMatrix({ fs: this.fs, dir: opts.dir })
    const changedFiles: Array<{ path: string; status: DiffFileStatus }> = []
    for (const row of rows) {
      const [filepath, headState, , workState] = row
      const rel = filepath.startsWith('/') ? filepath : `/${filepath}`
      if (opts.paths && !opts.paths.some((p) => matchesPath(rel, p))) continue
      const headExists = headState !== 0
      const workExists = workState !== 0
      if (headExists && workExists) {
        if (headState !== workState) changedFiles.push({ path: rel, status: 'modified' })
      } else if (headExists && !workExists) {
        changedFiles.push({ path: rel, status: 'deleted' })
      }
      // statusMatrix never reports untracked files, so those are intentionally excluded.
    }

    if (changedFiles.length === 0) {
      return { changes: [], summary: `No changes against ${ref}.` }
    }
    const changes: FileDiff[] = []
    let totalAdd = 0
    let totalDel = 0
    for (const c of changedFiles) {
      const patch = await this.buildPatch(opts.dir, c.path, c.status, headOid)
      totalAdd += patch.additions
      totalDel += patch.deletions
      changes.push(patch)
    }
    const summary =
      changes.length === 0
        ? `No changes against ${ref}.`
        : `${changes.length} file(s) changed, ${totalAdd} insertion(s), ${totalDel} deletion(s)`
    return { changes, summary }
  }

  private async buildPatch(
    dir: string,
    relPath: string,
    status: DiffFileStatus,
    headCommitOid: string,
  ): Promise<FileDiff> {
    const abs = relPath.startsWith('/') ? relPath : `/${relPath}`
    let headText: string | null = null
    let workText: string | null = null

    try {
      const headBlob = await readPathBlob(this.fs, dir, headCommitOid, relPath)
      headText = headBlob === null ? null : decodeUtf8(headBlob)
    } catch {
      headText = null
    }
    if (status !== 'deleted') {
      workText = await this.ws.readFile(abs)
    }

    const hunks = lineDiff(headText, workText)
    const additions = hunks.reduce((n, h) => n + h.additions, 0)
    const deletions = hunks.reduce((n, h) => n + h.deletions, 0)
    return { path: relPath, status, hunks, additions, deletions }
  }
}

/** Read the content (as bytes) of a file tracked at a given commit oid,
 *  following its tree path. Returns null if the path isn't in the tree. */
async function readPathBlob(
  fs: any,
  dir: string,
  commitOid: string,
  relPath: string,
): Promise<Uint8Array | null> {
  const commit = await isogit.readCommit({ fs, dir, oid: commitOid })
  const treeOid = commit.commit.tree
  const parts = relPath.replace(/^\/+/, '').split('/').filter(Boolean)
  let currentOid = treeOid
  for (let i = 0; i < parts.length; i++) {
    const tree = await isogit.readTree({ fs, dir, oid: currentOid })
    const entry = tree.tree.find((e) => e.path === parts[i])
    if (!entry) return null
    if (i === parts.length - 1) {
      const blob = await isogit.readBlob({ fs, dir, oid: entry.oid }).catch(() => null)
      return blob ? blob.blob as Uint8Array : null
    }
    currentOid = entry.oid
  }
  return null
}

// ---------- helpers ----------

function matchesPath(abs: string, wanted: string): boolean {
  const w = wanted.startsWith('/') ? wanted : `/${wanted}`
  // absolute-in-workspace, or a repo-relative subpath match
  return abs === w || abs.startsWith(`${w}/`)
}

function decodeUtf8(buf: Uint8Array): string {
  return new TextDecoder().decode(buf)
}

/** Line-based diff (LCS) rendering per-file hunks. Kept small for the
 *  Worker CPU budget; pathologically large inputs fall back to showing
 *  the whole old/new block instead of an expensive DP table. */
function lineDiff(oldText: string | null, newText: string | null): DiffHunk[] {
  // Normalise line endings first: git blobs are LF while Windows
  // worktrees are often CRLF. Comparing raw would mark every line of a
  // whole file as changed, drowning out real edits.
  const oldLines = (oldText ?? '').replace(/\r\n/g, '\n').split('\n')
  const newLines = (newText ?? '').replace(/\r\n/g, '\n').split('\n')
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop()
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop()

  if (oldLines.length === 0 && newLines.length === 0) return []
  if (oldLines.length === 0) {
    const lines = newLines.map((text) => ({ type: '+' as const, text }))
    return [hunk(0, lines, lines.length, 0)]
  }
  if (newLines.length === 0) {
    const lines = oldLines.map((text) => ({ type: '-' as const, text }))
    return [hunk(0, lines, 0, lines.length)]
  }

  const ops = diffLCS(oldLines, newLines)
  const lines: DiffHunk['lines'] = []
  let oldStart = 1
  let newStart = 1
  for (const op of ops) {
    if (op.type === '=') {
      lines.push({ type: ' ', text: op.eq })
      oldStart++
      newStart++
    } else if (op.type === '-') {
      lines.push({ type: '-', text: op.de })
      oldStart++
    } else {
      lines.push({ type: '+', text: op.ad })
      newStart++
    }
  }
  const additions = ops.filter((o) => o.type === '+').length
  const deletions = ops.filter((o) => o.type === '-').length
  return [hunk(oldStart, lines, additions, deletions)]
}

function hunk(
  oldStart: number,
  lines: DiffHunk['lines'],
  additions: number,
  deletions: number,
): DiffHunk {
  const context = lines.filter((l) => l.type === ' ').length
  return {
    oldStart,
    oldLines: deletions + context,
    newStart: oldStart,
    newLines: additions + context,
    additions,
    deletions,
    lines,
  }
}

type Op = { type: '-'; de: string } | { type: '+'; ad: string } | { type: '='; eq: string }

/** LCS over lines. Guards against pathologically large inputs by falling
 *  back to "whole file replaced" when the DP table would be too big. */
function diffLCS(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    const out: Op[] = a.map((de): Op => ({ type: '-', de }))
    for (const ad of b) out.push({ type: '+', ad })
    return out
  }
  const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[j * (n + 1) + i] = dp[(j + 1) * (n + 1) + (i + 1)] + 1
      else dp[j * (n + 1) + i] = Math.max(dp[(j + 1) * (n + 1) + i], dp[j * (n + 1) + (i + 1)])
    }
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: '=', eq: a[i] })
      i++
      j++
    } else if (dp[(j + 1) * (n + 1) + i] >= dp[j * (n + 1) + (i + 1)]) {
      out.push({ type: '+', ad: b[j] })
      j++
    } else {
      out.push({ type: '-', de: a[i] })
      i++
    }
  }
  while (i < n) out.push({ type: '-', de: a[i++] })
  while (j < m) out.push({ type: '+', ad: b[j++] })
  return out
}
