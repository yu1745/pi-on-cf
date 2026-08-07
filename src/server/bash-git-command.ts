/**
 * `git` custom command for just-bash — the ONLY git surface exposed to
 * the agent. Two subcommands, both network read operations:
 *
 *   git clone   <url> [<dir>] [-b <ref>]   — shallow fetch, then drop .git
 *   git ls-remote <url> [--heads] [--tags] [--symref] [--refs]
 *                  [-q|--quiet] [--exit-code] [<patterns>...]
 *
 * Everything else exits 1 with a "not supported" message. This is the
 * hard read-only boundary: there is no add/commit/push/pull/checkout,
 * and no local-only subcommands (status/log/diff) either — the agent
 * cannot inspect or alter a working tree's git state.
 *
 * URL normalisation: SSH forms (git@host:o/r, ssh://...) and bare
 * shorthand (host/o/r) are rewritten to HTTPS by normalizeGitUrl, since
 * isomorphic-git runs over fetch and auth comes from headers, not the
 * git@ user or SSH port.
 *
 * Output contract:
 *   - clone:    human progress line (no machine-parseable output).
 *   - ls-remote: `<oid>\t<ref>` per line, byte-for-byte matching real
 *                `git ls-remote` (verified against real git on
 *                yu1745/ic2-fabric — see bash-git-command.alignment.test.ts).
 */

import { defineCommand } from 'just-bash'
import type { MemoryGitClient } from './memory-git'
import { normalizeGitUrl } from './git-url'

export interface BashGitCommandOptions {
  /** The git client bound to the workspace fs. */
  git: MemoryGitClient
  /** Workspace root, used to resolve relative clone targets. */
  workspaceRoot: string
  /** Extra HTTP headers for private-repo auth (e.g. Authorization). */
  authHeaders?: Record<string, string>
}

/** Derive a clean directory name from a git URL: last path segment
 *  minus a trailing .git. Mirrors memory-workspace's helper; duplicated
 *  here to keep the command self-contained. */
function repoNameFromUrl(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url
  }
  const segments = pathname.replace(/\.git$/, '').replace(/\/$/, '').split('/').filter(Boolean)
  const name = segments[segments.length - 1]
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return 'repo'
  return name
}

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Resolve a possibly-relative clone target dir against the workspace root. */
function resolveDir(dir: string, workspaceRoot: string): string {
  if (dir.startsWith('/')) return dir
  return `${workspaceRoot.replace(/\/$/, '')}/${dir}`
}

export function defineBashGitCommand(options: BashGitCommandOptions) {
  const { git, workspaceRoot, authHeaders } = options

  return defineCommand('git', async (args) => {
    const sub = args[0]

    // ---------------- clone ----------------
    if (sub === 'clone') {
      // argv shape: clone [flags] <url> [<dir>]
      // Recognised flags: -b/--branch <ref>. Other git clone flags
      // (--depth/--single-branch/--no-tags) are force-coded in the
      // client and silently ignored here.
      let ref: string | undefined
      const positional: string[] = []
      for (let i = 1; i < args.length; i++) {
        const a = args[i]
        if (a === '-b' || a === '--branch') {
          ref = args[++i]
        } else if (a.startsWith('-b') && a.length > 2) {
          // -b<ref> glued form
          ref = a.slice(2)
        } else if (a.startsWith('--branch=')) {
          ref = a.slice('--branch='.length)
        } else if (a?.startsWith('-')) {
          // ignore unknown flags (--depth, --single-branch, etc.)
          if (a === '--depth' || a === '--branch' || a === '-b') i++ // skip their value too
        } else if (a !== undefined) {
          positional.push(a)
        }
      }

      const rawUrl = positional[0]
      if (!rawUrl) {
        return { stdout: '', stderr: 'usage: git clone <url> [<dir>]\n', exitCode: 1 }
      }
      const url = normalizeGitUrl(rawUrl)
      const dir = positional[1]
        ? resolveDir(positional[1], workspaceRoot)
        : `${workspaceRoot.replace(/\/$/, '')}/${repoNameFromUrl(url)}`

      try {
        await git.clone({ url, dir, ref, headers: authHeaders })
        return {
          stdout: `Cloning into '${dir}'...\nCloned ${url}${ref ? ` (ref ${ref})` : ''} into ${dir}\n`,
          stderr: '',
          exitCode: 0,
        }
      } catch (e) {
        // Preserve the full stack so the operator can see the real failure
        // site in `wrangler tail` / server logs. The agent only sees the
        // message line below; the stack goes to the server console.
        console.error('[git clone]', e instanceof Error ? e.stack : String(e))
        return { stdout: '', stderr: `git clone failed: ${errorMsg(e)}\n`, exitCode: 1 }
      }
    }

    // ---------------- ls-remote ----------------
    if (sub === 'ls-remote') {
      // argv shape: ls-remote [flags] <url> [<patterns>...]
      let heads = false
      let tags = false
      let symref = false
      let showPeeled = true // default: show peeled tags (real git default on servers that return them)
      let quiet = false
      let exitCode = false
      let url: string | undefined
      const patterns: string[] = []

      for (let i = 1; i < args.length; i++) {
        const a = args[i]
        if (a === '-h' || a === '--heads') heads = true
        else if (a === '-t' || a === '--tags') tags = true
        else if (a === '--symref') symref = true
        else if (a === '--refs') showPeeled = false
        else if (a === '-q' || a === '--quiet') quiet = true
        else if (a === '--exit-code') exitCode = true
        else if (a === undefined || a.startsWith('-')) {
          // ignore unknown flags (--sort, --get-url, etc.)
        } else if (!url) {
          url = a
        } else {
          patterns.push(a)
        }
      }

      if (!url) {
        return { stdout: '', stderr: 'usage: git ls-remote <url> [<patterns>...]\n', exitCode: 1 }
      }

      // Build a prefix filter. --heads and --tags each add their prefix;
      // both together OR them (matches real git). When neither is set,
      // isomorphic-git's listServerRefs already returns HEAD + all refs.
      let prefix: string | undefined
      if (heads && tags) {
        // No single prefix covers both; fetch all and filter locally.
        prefix = undefined
      } else if (heads) {
        prefix = 'refs/heads/'
      } else if (tags) {
        prefix = 'refs/tags/'
      }

      try {
        const refs = await git.lsRemote({
          url: normalizeGitUrl(url),
          headers: authHeaders,
          prefix,
          symrefs: symref,
          peelTags: showPeeled,
        })

        // Local filtering pass for: --heads+--tags combo, --refs (drop peeled),
        // symref formatting, and <patterns> glob matching.
        let out = refs
        if (heads && tags) {
          out = out.filter((r) => r.ref === 'HEAD' || r.ref.startsWith('refs/heads/') || r.ref.startsWith('refs/tags/'))
        }
        if (!showPeeled) {
          out = out.filter((r) => !r.ref.endsWith('^{}'))
        }
        if (patterns.length > 0) {
          out = out.filter((r) => patterns.some((p) => matchPattern(r.ref, p)))
        }

        // Format: <oid>\t<ref>, matching real `git ls-remote` byte-for-byte.
        // Two extra cases real git handles:
        //   1. symrefs (only with --symref): HEAD prints as
        //      `ref: <target>\tHEAD` on its own line, BEFORE the oid line.
        //   2. annotated tags: when the server returns a peeled oid, real
        //      git prints a SECOND line `<peeled>\t<ref>^{}` immediately
        //      after the tag's own line. Lightweight tags have no peeled
        //      oid and thus no `^{}` line. --refs suppresses these.
        const lines: string[] = []
        for (const r of out) {
          if (symref && r.target && r.ref === 'HEAD') {
            lines.push(`ref: ${r.target}\t${r.ref}`)
          }
          lines.push(`${r.oid}\t${r.ref}`)
          if (showPeeled && r.peeled) {
            lines.push(`${r.peeled}\t${r.ref}^{}`)
          }
        }

        const stdout = lines.length ? lines.join('\n') + '\n' : ''
        if (exitCode && lines.length === 0) {
          return { stdout: quiet ? '' : stdout, stderr: '', exitCode: 2 }
        }
        return { stdout: quiet ? '' : stdout, stderr: '', exitCode: 0 }
      } catch (e) {
        console.error('[git ls-remote]', e instanceof Error ? e.stack : String(e))
        return { stdout: '', stderr: `git ls-remote failed: ${errorMsg(e)}\n`, exitCode: 1 }
      }
    }

    // ---------------- unsupported ----------------
    return {
      stdout: '',
      stderr: `git: '${sub}' is not supported. Only 'clone' and 'ls-remote' are available.\n`,
      exitCode: 1,
    }
  })
}

/** Glob-style pattern match for ls-remote <patterns>, matching real git's
 *  fnmatch-style behaviour: '*' matches within a path segment. */
function matchPattern(ref: string, pattern: string): boolean {
  // git uses fnmatch without FNM_PATHNAME semantics for ls-remote patterns;
  // a pattern with no wildcard must equal the ref, '*' matches anything
  // except '/'.
  const regexSrc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${regexSrc}$`).test(ref)
}
