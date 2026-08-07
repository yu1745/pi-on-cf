/**
 * Thin git facade over isomorphic-git, bound to a MemoryWorkspace's fs.
 *
 * Replaces @cloudflare/computer/git (which wraps isomorphic-git through
 * @platformatic/vfs → dofs). Here isomorphic-git reads/writes the
 * MemoryWorkspace directly via its `promises` adapter, so every git
 * object read or working-tree write stays in memory — zero storage IO.
 *
 * SURFACE (intentionally minimal):
 *   - clone:  shallow fetch of a repository into the in-memory workspace.
 *   - lsRemote: list refs on a remote (git ls-remote) WITHOUT cloning.
 *
 * Everything else (status / log / diff / branch / remote / tag / checkout
 * / add / commit / push / pull / ...) is deliberately absent. Mutating
 * operations can never run; and with no local-only subcommands left,
 * there is no way to inspect or alter a working tree's git state either.
 *
 * Both methods are network read operations. Neither writes to a remote.
 *
 * .git RECLAMATION:
 * clone() removes the .git directory after checking out the working
 * tree. With no local git subcommands left, the object database is dead
 * weight (on a depth-1 clone of a repo like ic2-fabric it is ~17MB /
 * 13% of the 128MB DO ceiling). The in-memory FS has no persistence, so
 * .git has zero future use — keeping it would just burn memory.
 */

import * as isogit from 'isomorphic-git'
import type { MemoryWorkspace } from './memory-workspace'

export interface GitAuth {
  /** Value of the Authorization header, e.g. `Bearer <token>` or `Basic <b64>`. */
  header?: string
  /** Username/password for HTTP Basic, when the server challenges for auth. */
  username?: string
  password?: string
}

export interface CloneOptions {
  /** HTTPS repository URL (already normalized — SSH forms must be
   *  rewritten to HTTPS before reaching here, since isomorphic-git
   *  runs over fetch and auth comes from headers, not the git@ user). */
  url: string
  /** Absolute workspace path to clone into. Must already be normalised
   *  by the caller (mirrors `git clone <url> <dir>`). */
  dir: string
  /** Optional branch/tag/commit ref to clone. */
  ref?: string
  /** Optional extra HTTP headers (e.g. Authorization for private repos). */
  headers?: Record<string, string>
}

/** A single remote ref, matching isomorphic-git's ServerRef shape. */
export interface RemoteRef {
  /** Ref name, e.g. `HEAD`, `refs/heads/main`, `refs/tags/v1.0`. */
  ref: string
  /** The SHA-1 object id the ref points to. */
  oid: string
  /** For a symref (HEAD), the ref it points to. Only present with symrefs. */
  target?: string
  /** For an annotated tag, the SHA-1 of the underlying commit it points to. */
  peeled?: string
}

export interface LsRemoteOptions {
  /** HTTPS repository URL (already normalized). */
  url: string
  /** Optional extra HTTP headers (e.g. Authorization for private repos). */
  headers?: Record<string, string>
  /** Limit to refs under this prefix, e.g. `refs/heads/` for --heads. */
  prefix?: string
  /** Resolve symrefs (HEAD → the branch it points at). */
  symrefs?: boolean
  /** Peel annotated tags to the underlying commit. */
  peelTags?: boolean
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

  /**
   * Shallow clone a repository into the workspace, then drop `.git`.
   *
   * Uses depth-1 / single-branch / no-tags to keep the fetch small (the
   * working tree is what the agent reads; history is not needed since
   * no local git subcommand can read it). After checkout, `.git` is
   * removed because no remaining surface (clone / ls-remote) consumes
   * a local object database.
   */
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
    // Reclaim .git: see file header. Best-effort; a missing .git is not a
    // clone failure (the working tree is already checked out).
    try {
      await this.ws.rm(`${opts.dir}/.git`, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  /**
   * `git ls-remote` — list refs on a remote without cloning.
   *
   * Returns refs in the server's order (HEAD first, then heads, pull,
   * tags on GitHub). Format the result as `<oid>\t<ref>` to match real
   * `git ls-remote` output byte-for-byte; the caller (the bash git
   * command) is responsible for flag-driven filtering and formatting.
   */
  async lsRemote(opts: LsRemoteOptions): Promise<RemoteRef[]> {
    const http = (await import('isomorphic-git/http/web')).default
    const refs = await isogit.listServerRefs({
      http,
      url: opts.url,
      headers: opts.headers,
      prefix: opts.prefix,
      symrefs: opts.symrefs,
      peelTags: opts.peelTags,
    })
    return refs.map((r) => ({
      ref: r.ref,
      oid: r.oid,
      target: r.target,
      peeled: r.peeled,
    }))
  }
}
