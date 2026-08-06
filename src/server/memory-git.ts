/**
 * Thin git facade over isomorphic-git, bound to a MemoryWorkspace's fs.
 *
 * Replaces @cloudflare/computer/git (which wraps isomorphic-git through
 * @platformatic/vfs → dofs). Here isomorphic-git reads/writes the
 * MemoryWorkspace directly via its `promises` adapter, so every git
 * object read or working-tree write stays in memory — zero storage IO.
 *
 * Only the subcommands pi-on-cf's git tool exposes are wired up:
 * clone, status, add, commit, push, pull, log.
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

export interface CommitResult {
  oid: string
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

  async add(opts: { dir: string; paths: string[] }): Promise<void> {
    await this.ensureDir(opts.dir)
    for (const rel of opts.paths) {
      await isogit.add({ fs: this.fs, dir: opts.dir, filepath: rel })
    }
  }

  async commit(opts: { dir: string; message: string }): Promise<CommitResult> {
    await this.ensureDir(opts.dir)
    const oid = await isogit.commit({
      fs: this.fs,
      dir: opts.dir,
      message: opts.message,
      author: { name: 'Pi', email: 'pi@cloudflare.invalid' },
    })
    return { oid }
  }

  async push(opts: {
    dir: string
    remote?: string
    ref?: string
    force?: boolean
    headers?: Record<string, string>
  }): Promise<isogit.PushResult> {
    await this.ensureDir(opts.dir)
    const http = (await import('isomorphic-git/http/web')).default
    return isogit.push({
      fs: this.fs,
      http,
      dir: opts.dir,
      remote: opts.remote ?? 'origin',
      ref: opts.ref,
      force: opts.force,
      headers: opts.headers,
    })
  }

  async pull(opts: {
    dir: string
    remote?: string
    ref?: string
    headers?: Record<string, string>
  }): Promise<void> {
    await this.ensureDir(opts.dir)
    const http = (await import('isomorphic-git/http/web')).default
    // pull = fetch + merge (fast-forward). For a memory workspace with a
    // single user, fast-forward is the only realistic outcome.
    await isogit.fetch({
      fs: this.fs,
      http,
      dir: opts.dir,
      remote: opts.remote ?? 'origin',
      ref: opts.ref,
      headers: opts.headers,
      depth: 1,
    })
    // Merge the fetched ref into HEAD (fast-forward only).
    const branch = opts.ref ?? (await this.currentBranch({ dir: opts.dir }))
    if (branch) {
      try {
        await isogit.merge({ fs: this.fs, dir: opts.dir, ours: branch, theirs: `${opts.remote ?? 'origin'}/${branch}`, fastForwardOnly: true })
        await isogit.checkout({ fs: this.fs, dir: opts.dir, ref: branch })
      } catch {
        // Non-fast-forward or no branch; leave HEAD as-is.
      }
    }
  }

  async log(opts: { dir: string; depth?: number }): Promise<isogit.ReadCommitResult[]> {
    await this.ensureDir(opts.dir)
    return isogit.log({ fs: this.fs, dir: opts.dir, depth: opts.depth ?? 50 })
  }

  async currentBranch(opts: { dir: string }): Promise<string | undefined> {
    await this.ensureDir(opts.dir)
    try {
      const branch = await isogit.currentBranch({ fs: this.fs, dir: opts.dir, fullname: false })
      return branch ?? undefined
    } catch {
      return undefined
    }
  }
}
