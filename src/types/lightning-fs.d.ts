/**
 * Ambient declarations for @isomorphic-git/lightning-fs subpath imports
 * that ship without .d.ts files. CacheFS / path / errors are used by
 * our WorkerBackend; only the shape we touch is declared here.
 */

declare module '@isomorphic-git/lightning-fs/src/CacheFS.js' {
  export default class CacheFS {
    constructor()
    get activated(): boolean
    activate(superblock?: unknown): void
    deactivate(): void
    autoinc(): number
    mkdir(filepath: string, opts: { mode: number }): void
    rmdir(filepath: string): void
    readdir(filepath: string): string[]
    writeStat(filepath: string, size: number, opts: { mode: number }): unknown
    unlink(filepath: string): void
    rename(oldFilepath: string, newFilepath: string): void
    stat(filepath: string): unknown
    lstat(filepath: string): unknown
    readlink(filepath: string): string
    symlink(target: string, filepath: string): unknown
    du(filepath: string): unknown
  }
}

declare module '@isomorphic-git/lightning-fs/src/path.js' {
  export function split(p: string): string[]
  export function join(...parts: string[]): string
  export function dirname(p: string): string
  export function basename(p: string): string
  export function normalize(p: string): string
  export function resolve(...parts: string[]): string
}

declare module '@isomorphic-git/lightning-fs/src/errors.js' {
  export class ENOENT extends Error {
    code: string
    constructor(filepath: string)
  }
  export class ENOTEMPTY extends Error {
    code: string
  }
  export class EEXIST extends Error {
    code: string
  }
}
