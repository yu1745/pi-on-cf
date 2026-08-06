/**
 * Pure in-memory workspace backed by @isomorphic-git/lightning-fs's
 * MemoryBackend. No persistence, no SQL, no storage IO.
 *
 * Design context: pi-on-cf sessions are ephemeral ("web chat"-style).
 * The DO disables hibernation, so while a user is connected the DO —
 * and this filesystem — live entirely in memory. When the user closes
 * the window the DO is eventually evicted and everything is discarded,
 * which is the intended behaviour. Conversation history is stored in
 * DO storage separately and persists; only the filesystem is ephemeral.
 *
 * Why lightning-fs instead of hand-rolling: isomorphic-git exercises a
 * lot of fs edge cases (relative paths like ".", symlink semantics,
 * mkdirp chains, ENOENT/EEXIST code propagation). lightning-fs is
 * written by the isomorphic-git author and passes its full test suite.
 * Its MemoryBackend is five Map operations — zero persistence, exactly
 * the "ephemeral session" semantics we want.
 *
 * This replaces @cloudflare/computer's Workspace+dofs stack, which
 * persisted every FS op to SQLite and (inside write transactions)
 * resolved paths with a per-component SQL loop, producing >1.5M SELECTs
 * for a single git clone. Here every read/write is a Map lookup.
 *
 * Surface implemented (the subset pi-on-cf consumes):
 *   readFile, readFileBytes, writeFile, readDir, glob, stat, rm, mkdir,
 *   grep, plus an isomorphic-git-compatible `promises` client and a
 *   `git` holder.
 *
 * Path model: paths are used AS-IS (no prefix stripping). Callers pass
 * absolute paths like "/workspace/foo"; lightning-fs normalises them.
 */

import FS from '@isomorphic-git/lightning-fs'
import path from 'node:path/posix'
import { WorkerBackend } from './worker-fs-backend'

export interface ThinkFileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  mimeType: string
  size: number
  createdAt: number
  updatedAt: number
}

const WORKSPACE_PREFIX = '/workspace'

function mimeFor(name: string): string {
  if (name.endsWith('.md')) return 'text/markdown'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'text/typescript'
  if (name.endsWith('.js') || name.endsWith('.jsx')) return 'text/javascript'
  if (name.endsWith('.html')) return 'text/html'
  if (name.endsWith('.css')) return 'text/css'
  return 'application/octet-stream'
}

export class MemoryWorkspace {
  /** lightning-fs instance; its `.promises` is what isomorphic-git consumes. */
  readonly fs: FS
  private _git: unknown = null

  constructor() {
    // Use our WorkerBackend (not DefaultBackend) to avoid IndexedDB /
    // Web Locks dependencies that don't exist in the Workers runtime.
    // WorkerBackend holds everything in JS heap — zero persistence,
    // zero IO, matching the ephemeral-session design.
    this.fs = new FS('pi-mem', { backend: new WorkerBackend() } as unknown as ConstructorParameters<typeof FS>[1])
  }

  // ---------- lifecycle ----------

  async ready(): Promise<void> {
    // Ensure the workspace root exists as a directory.
    try {
      await this.fs.promises.mkdir(WORKSPACE_PREFIX)
    } catch {
      // already exists
    }
  }

  get promises(): FS['promises'] {
    return this.fs.promises
  }

  get git(): unknown {
    return this._git
  }
  setGit(client: unknown): void {
    this._git = client
  }

  // ---------- ThinkWorkspaceCompatibility surface ----------

  async readFile(p: string): Promise<string | null> {
    try {
      return await this.fs.promises.readFile(p, 'utf8')
    } catch {
      return null
    }
  }

  async readFileBytes(p: string): Promise<Uint8Array | null> {
    try {
      const buf = await this.fs.promises.readFile(p)
      return buf as Uint8Array
    } catch {
      return null
    }
  }

  async writeFile(p: string, content: string | Uint8Array): Promise<void> {
    const data = typeof content === 'string' ? content : content
    // lightning-fs's mkdirp runs on its own; ensure parent dir exists first.
    await this.ensureParent(p)
    await this.fs.promises.writeFile(p, data, 'utf8')
  }

  async readDir(p: string, opts?: { limit?: number; offset?: number }): Promise<ThinkFileInfo[]> {
    let names: string[]
    try {
      names = await this.fs.promises.readdir(p)
    } catch {
      return []
    }
    names.sort()
    const offset = opts?.offset ?? 0
    const limit = opts?.limit
    const slice = limit !== undefined ? names.slice(offset, offset + limit) : names.slice(offset)
    const infos = await Promise.all(
      slice.map(async (name) => {
        const childPath = path.join(p, name)
        const stat = (await this.fs.promises.stat(childPath)) as LightningStat
        return this.toInfo(childPath, stat)
      }),
    )
    return infos
  }

  async glob(pattern: string): Promise<ThinkFileInfo[]> {
    const matcher = compileGlob(pattern)
    const results: ThinkFileInfo[] = []
    await this.walk(WORKSPACE_PREFIX, async (current, stat) => {
      if (matcher(current)) results.push(this.toInfo(current, stat))
    })
    return results.sort((a, b) => a.path.localeCompare(b.path))
  }

  async stat(p: string): Promise<ThinkFileInfo | null> {
    try {
      const stat = (await this.fs.promises.stat(p)) as LightningStat
      return this.toInfo(p, stat)
    } catch {
      return null
    }
  }

  async rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    try {
      const stat = (await this.fs.promises.stat(p)) as LightningStat
      if (stat.isDirectory()) {
        if (opts?.recursive) {
          const names = await this.fs.promises.readdir(p)
          for (const name of names) {
            await this.rm(path.join(p, name), { recursive: true, force: true })
          }
        }
        await this.fs.promises.rmdir(p)
      } else {
        await this.fs.promises.unlink(p)
      }
    } catch {
      if (!opts?.force) throw new Error(`ENOENT: ${p}`)
    }
  }

  async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
    if (opts?.recursive) await this.ensureParent(p)
    try {
      await this.fs.promises.mkdir(p)
    } catch {
      // exists, ignore
    }
  }

  /** fs.grep shim — search a file's contents. */
  async grep(query: string, p: string): Promise<Array<{ path: string; line: number; text: string }>> {
    let content: string
    try {
      content = await this.fs.promises.readFile(p, 'utf8')
    } catch {
      return []
    }
    let re: RegExp
    try {
      re = new RegExp(query, 'i')
    } catch {
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const matches: Array<{ path: string; line: number; text: string }> = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) matches.push({ path: p, line: i + 1, text: lines[i]! })
    }
    return matches
  }

  // ---------- helpers ----------

  private async ensureParent(p: string): Promise<void> {
    const dir = path.dirname(p)
    if (dir === '/' || dir === '.') return
    try {
      await this.fs.promises.mkdir(dir)
    } catch {
      // exists
    }
  }

  private toInfo(p: string, stat: LightningStat): ThinkFileInfo {
    const isDir = stat.isDirectory()
    return {
      path: p,
      name: path.basename(p) || p,
      type: isDir ? 'directory' : 'file',
      mimeType: isDir ? 'inode/directory' : mimeFor(path.basename(p)),
      size: stat.size,
      createdAt: stat.ctimeMs ?? stat.mtimeMs,
      updatedAt: stat.mtimeMs,
    }
  }

  private async walk(dir: string, visit: (p: string, stat: LightningStat) => Promise<void>): Promise<void> {
    let names: string[]
    try {
      names = await this.fs.promises.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const child = path.join(dir, name)
      const stat = (await this.fs.promises.stat(child)) as LightningStat
      await visit(child, stat)
      if (stat.isDirectory()) await this.walk(child, visit)
    }
  }
}

// ---------- types ----------

interface LightningStat {
  type: string
  mode: number
  size: number
  ino: number
  mtimeMs: number
  ctimeMs?: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

// ---------- helpers (module-private) ----------

function compileGlob(pattern: string): (candidate: string) => boolean {
  let p = pattern
  if (p.startsWith(WORKSPACE_PREFIX)) p = p.slice(WORKSPACE_PREFIX.length)
  if (p.startsWith('/')) p = p.slice(1)
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const withDoubleStar = escaped.replace(/\*\*\/?/g, '.*')
  const withStar = withDoubleStar.replace(/\*/g, '[^/]*')
  const final = withStar.replace(/\?/g, '[^/]')
  const re = new RegExp(`(^|/)${final}$`)
  return (candidate: string): boolean => {
    let c = candidate
    if (c.startsWith(WORKSPACE_PREFIX)) c = c.slice(WORKSPACE_PREFIX.length)
    if (c.startsWith('/')) c = c.slice(1)
    return re.test(c)
  }
}
