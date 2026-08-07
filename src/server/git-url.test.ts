import { describe, expect, it } from 'vitest'
import { normalizeGitUrl } from './git-url'

describe('normalizeGitUrl', () => {
  describe('HTTPS passthrough', () => {
    it('leaves https URLs unchanged', () => {
      expect(normalizeGitUrl('https://github.com/o/r')).toBe('https://github.com/o/r')
    })
    it('leaves https URLs with .git unchanged', () => {
      expect(normalizeGitUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git')
    })
    it('leaves http URLs unchanged', () => {
      expect(normalizeGitUrl('http://example.com/o/r')).toBe('http://example.com/o/r')
    })
    it('is case-insensitive on the scheme', () => {
      expect(normalizeGitUrl('HTTPS://github.com/o/r')).toBe('HTTPS://github.com/o/r')
    })
  })

  describe('SCP-like SSH (user@host:path)', () => {
    it('converts git@github.com:owner/repo.git', () => {
      expect(normalizeGitUrl('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo.git')
    })
    it('converts git@github.com:owner/repo (no .git)', () => {
      expect(normalizeGitUrl('git@github.com:owner/repo')).toBe('https://github.com/owner/repo')
    })
    it('drops the ssh user', () => {
      expect(normalizeGitUrl('deploy@gitea.local:org/proj.git')).toBe('https://gitea.local/org/proj.git')
    })
    it('converts host:path without a user', () => {
      expect(normalizeGitUrl('github.com:owner/repo')).toBe('https://github.com/owner/repo')
    })
    it('handles a user containing dots', () => {
      expect(normalizeGitUrl('first.last@gitlab.com:g/r.git')).toBe('https://gitlab.com/g/r.git')
    })
  })

  describe('ssh:// scheme', () => {
    it('converts ssh://git@github.com/owner/repo.git', () => {
      expect(normalizeGitUrl('ssh://git@github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git')
    })
    it('drops the ssh port', () => {
      expect(normalizeGitUrl('ssh://git@github.com:22/owner/repo.git')).toBe('https://github.com/owner/repo.git')
    })
    it('converts ssh:// without a user', () => {
      expect(normalizeGitUrl('ssh://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git')
    })
    it('drops user and port together', () => {
      expect(normalizeGitUrl('ssh://git@gitea.example:2222/o/r.git')).toBe('https://gitea.example/o/r.git')
    })
  })

  describe('bare shorthand', () => {
    it('adds the scheme to github.com/owner/repo', () => {
      expect(normalizeGitUrl('github.com/owner/repo')).toBe('https://github.com/owner/repo')
    })
    it('does not treat github.com/owner/repo as SCP-like', () => {
      expect(normalizeGitUrl('github.com/o/r')).toBe('https://github.com/o/r')
    })
  })

  describe('whitespace', () => {
    it('trims surrounding whitespace', () => {
      expect(normalizeGitUrl('  https://github.com/o/r  ')).toBe('https://github.com/o/r')
    })
    it('trims an ssh url with newlines', () => {
      expect(normalizeGitUrl('\ngit@github.com:o/r.git\n')).toBe('https://github.com/o/r.git')
    })
  })
})
