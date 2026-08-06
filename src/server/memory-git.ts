/**
 * Thin git facade over isomorphic-git, bound to a MemoryWorkspace's fs.
 *
 * Replaces @cloudflare/computer/git (which wraps isomorphic-git through
 * @platformatic/vfs → dofs). Here isomorphic-git reads/writes the
 * MemoryWorkspace directly via its `promises` adapter, so every git
 * object read or working-tree write stays in memory — zero storage IO.
 *
 * Only read-only subcommands are wired up: clone, status, log. Mutating
 * operations (add/commit/push/pull) are deliberately absent so the agent
 * can never affect a remote repository.
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
}
