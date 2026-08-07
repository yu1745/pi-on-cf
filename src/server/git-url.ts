/**
 * Git remote URL normalization for pi-on-cf.
 *
 * pi-on-cf speaks HTTPS only: isomorphic-git runs over `fetch`, and auth is
 * injected as HTTP Basic headers (see createWorkspaceTools). SSH-form clone
 * URLs therefore cannot be used directly — they are rewritten to their HTTPS
 * equivalent transparently before `git.clone`. The SSH user and port are
 * discarded, since HTTPS auth comes from the configured git token, not the
 * `git@` user or the SSH port.
 *
 * Supported forms:
 *   https://host/o/repo[.git]              -> unchanged
 *   http://...                             -> unchanged
 *   ssh://[user@]host[:port]/o/repo[.git]  -> https://host/o/repo[.git]
 *   [user@]host:o/repo[.git]  (SCP-like)   -> https://host/o/repo[.git]
 *   host/o/repo  (bare shorthand)          -> https://host/o/repo
 */

export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  // ssh://[user@]host[:port]/path  -> drop the optional user@ and the SSH
  // :port (the SSH port has no HTTPS meaning), keep host + path.
  if (/^ssh:\/\//i.test(trimmed)) {
    const rest = trimmed.slice('ssh://'.length) // [user@]host[:port]/path
    const noUser = rest.includes('@') ? rest.slice(rest.indexOf('@') + 1) : rest
    const slash = noUser.indexOf('/')
    const hostPort = slash === -1 ? noUser : noUser.slice(0, slash)
    const path = slash === -1 ? '' : noUser.slice(slash)
    const host = hostPort.includes(':') ? hostPort.slice(0, hostPort.indexOf(':')) : hostPort
    return `https://${host}${path}`
  }

  // SCP-like: [user@]host:path  (no scheme; the first colon separates the
  // host from the path). The path may or may not start with '/'.
  const scp = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/)
  if (scp) return `https://${scp[1]}/${scp[2].replace(/^\/+/, '')}`

  // Bare host/path shorthand (e.g. "github.com/owner/repo").
  return `https://${trimmed}`
}
