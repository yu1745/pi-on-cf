/**
 * Adapter that exposes pi-on-cf's MemoryWorkspace (lightning-fs) as a
 * just-bash `IFileSystem`.
 *
 * Why this exists: we want a single source of truth for files. The
 * workspace tools (read/write/edit), isomorphic-git, and the bash tool
 * must all see the same files. Lightning-fs is already the backend for
 * the first two (and is validated against isomorphic-git's full test
 * suite, which is why pi-on-cf chose it). Rather than introduce a
 * second in-memory FS, we adapt lightning-fs to just-bash's wider
 * `IFileSystem` contract.
 *
 * What just-bash needs (IFileSystem, ~27 methods) vs what lightning-fs
 * gives us (its `promises` surface, ~12 methods): the common file/directory
 * operations forward directly. Methods lightning-fs lacks — chmod, hard
 * links, realpath, appendFile, readdirWithFileTypes — are synthesized
 * from available primitives. Hard links and chmod are reported as
 * best-effort (chmod is a no-op since lightning-fs's Stat carries no
 * usable mode; hard link throws ENOSYS). This matches the practical
 * needs of a bash tool whose main job is text processing and search.
 *
 * Path model: paths are passed through AS-IS. Both just-bash (cwd
 * resolved to /workspace) and pi-on-cf use absolute /workspace/...
 * paths, so no translation is needed.
 */

import type { IFileSystem, FsStat, BufferEncoding, FileContent } from 'just-bash'

// just-bash does not re-export DirentEntry from its public entry; the
// shape is stable and trivial, so define it structurally here.
interface DirentEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

// lightning-fs's Stat shape (the bits we read). Mode is carried but not
// meaningfully enforced by the CacheFS backend.
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

export interface LightningFsLike {
  promises: {
    readFile(path: string, opts?: { encoding?: string } | string): Promise<Uint8Array | string>
    writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string } | string): Promise<void>
    readdir(path: string): Promise<string[]>
    stat(path: string): Promise<LightningStat>
    lstat(path: string): Promise<LightningStat>
    mkdir(path: string, opts?: { mode?: number; recursive?: boolean }): Promise<void>
    rmdir(path: string): Promise<void>
    unlink(path: string): Promise<void>
    rename(oldPath: string, newPath: string): Promise<void>
    symlink(target: string, path: string): Promise<void>
    readlink(path: string): Promise<string>
  }
}

export class LightningFsAdapter implements IFileSystem {
  constructor(private readonly fs: LightningFsLike) {}

  // ---------- reads ----------

  async readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding | null): Promise<string> {
    const encoding = typeof options === 'string' ? options : options?.encoding
    // just-bash's readFile is text-by-default; lightning-fs needs an
    // explicit encoding to return a string rather than a Buffer.
    const result = await this.fs.promises.readFile(path, encoding ?? 'utf8')
    return typeof result === 'string' ? result : new TextDecoder().decode(result)
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const result = await this.fs.promises.readFile(path)
    return result as Uint8Array
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fs.promises.stat(path)
      return true
    } catch {
      return false
    }
  }

  async stat(path: string): Promise<FsStat> {
    return this.toFsStat(await this.fs.promises.stat(path))
  }

  async lstat(path: string): Promise<FsStat> {
    return this.toFsStat(await this.fs.promises.lstat(path))
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs.promises.readdir(path)
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const names = await this.fs.promises.readdir(path)
    return Promise.all(
      names.map(async (name) => {
        const childStat = await this.fs.promises.lstat(`${path}/${name}`.replace(/\/+$/, '/'))
        return {
          name,
          isFile: childStat.isFile(),
          isDirectory: childStat.isDirectory(),
          isSymbolicLink: childStat.isSymbolicLink(),
        }
      }),
    )
  }

  async readlink(path: string): Promise<string> {
    return this.fs.promises.readlink(path)
  }

  // ---------- writes ----------

  async writeFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    await this.fs.promises.writeFile(path, content)
  }

  async appendFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    let existing: Uint8Array
    try {
      existing = (await this.fs.promises.readFile(path)) as Uint8Array
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
      existing = new Uint8Array(0)
    }
    const addition = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const out = new Uint8Array(existing.byteLength + addition.byteLength)
    out.set(existing, 0)
    out.set(addition, existing.byteLength)
    await this.fs.promises.writeFile(path, out)
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // lightning-fs.mkdir accepts { recursive }, but its recursive impl is
    // shallow; emulate POSIX -p by creating each ancestor.
    if (options?.recursive) {
      await this.mkdirP(path)
    } else {
      await this.fs.promises.mkdir(path)
    }
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    let stat: LightningStat
    try {
      stat = await this.fs.promises.stat(path)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        if (options?.force) return
        throw err
      }
      throw err
    }
    if (stat.isDirectory()) {
      if (options?.recursive) {
        const entries = await this.fs.promises.readdir(path)
        for (const entry of entries) {
          await this.rm(`${path}/${entry}`.replace(/\/+$/, '/'), { recursive: true, force: true })
        }
      }
      await this.fs.promises.rmdir(path)
    } else {
      await this.fs.promises.unlink(path)
    }
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // lightning-fs's CacheFS carries no enforced mode. No-op so scripts
    // that call chmod (e.g. tar extraction) don't blow up; permissions
    // are not enforced anywhere in this stack anyway.
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.fs.promises.symlink(target, linkPath)
  }

  // ---------- composites ----------

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const stat = await this.fs.promises.stat(src)
    if (stat.isDirectory()) {
      if (!options?.recursive) {
        const err = new Error(`cp: ${src} is a directory`) as Error & { code: string }
        err.code = 'EISDIR'
        throw err
      }
      await this.mkdirP(dest)
      const entries = await this.fs.promises.readdir(src)
      for (const entry of entries) {
        await this.cp(`${src}/${entry}`, `${dest}/${entry}`, options)
      }
      return
    }
    const bytes = (await this.fs.promises.readFile(src)) as Uint8Array
    await this.fs.promises.writeFile(dest, bytes)
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.fs.promises.rename(src, dest)
  }

  // ---------- path utilities ----------

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return this.normalize(path)
    return this.normalize(`${base}/${path}`)
  }

  getAllPaths(): string[] {
    // Best-effort: just-bash uses this only for glob matching against
    // in-memory roots. We return [] so it falls back to its glob walk.
    return []
  }

  // ---------- known gaps ----------

  async link(_existingPath: string, _newPath: string): Promise<void> {
    const err = new Error('hard links are not supported by lightning-fs') as Error & { code: string }
    err.code = 'ENOSYS'
    throw err
  }

  async realpath(path: string): Promise<string> {
    // lightning-fs.stat already follows symlinks, so the canonical path
    // is the input once symlinks are resolved component-by-component.
    // Stat first to surface ENOENT for missing entries.
    await this.fs.promises.stat(path)
    return this.normalize(await this.resolveSymlinks(path))
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    // lightning-fs has no utimes; no-op so scripts that touch utimes don't fail.
  }

  // ---------- helpers ----------

  private toFsStat(stat: LightningStat): FsStat {
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      mode: stat.mode,
      size: stat.size,
      mtime: new Date(stat.mtimeMs),
    }
  }

  private async mkdirP(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = `${current}/${part}`
      try {
        await this.fs.promises.mkdir(current)
      } catch {
        // already exists, continue
      }
    }
  }

  private normalize(path: string): string {
    const parts = path.split('/')
    const stack: string[] = []
    for (const part of parts) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        stack.pop()
        continue
      }
      stack.push(part)
    }
    return `/${stack.join('/')}`
  }

  private async resolveSymlinks(path: string): Promise<string> {
    const parts = path.split('/').filter(Boolean)
    let resolved = ''
    for (const part of parts) {
      resolved = `${resolved}/${part}`
      try {
        const target = await this.fs.promises.readlink(resolved)
        // Resolve the target relative to the parent of the symlink.
        const parent = resolved.slice(0, resolved.lastIndexOf('/')) || '/'
        resolved = target.startsWith('/') ? target : `${parent}/${target}`
        resolved = this.normalize(resolved)
      } catch {
        // not a symlink, keep the component
      }
    }
    return resolved
  }
}
