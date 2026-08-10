/**
 * Heap-peak benchmark for the streaming clone path — against a REAL repo.
 *
 * Default target: https://github.com/Creators-of-Create/Create
 *   (public, default branch `mc1.21.1/dev`, ~31.7 MiB working tree)
 *
 * WHY THIS EXISTS
 *   workerd does NOT implement `performance.memory` (the `[fs:mem] heap=n/a`
 *   in logs proves it), so there is no in-Worker way to read JS heap usage,
 *   let alone a peak. This benchmark measures the clone's heap peak under
 *   Node's V8 instead — the SAME engine workerd uses. Absolute MiB won't
 *   match workerd exactly (different embedder/limit), but the STRUCTURE
 *   is valid.
 *
 * METHODOLOGY (read this or the numbers will mislead you)
 *   Each tick (after a forced major GC) we sample BOTH:
 *     heapUsed            — the live JS heap
 *     workspace content   — bytes currently in _files (the working tree)
 *   and decompose:
 *     total heap   = content + transient overhead
 *   `transient` is everything live that ISN'T the files we're writing
 *   (Node runtime, modules, gzip/tar decoder, in-flight buffers). The
 *   headline number is `peak(transient) − baseline(transient)`: the clone's
 *   OWN live cost, with the workspace content cleanly excluded.
 *
 *   Why not just `peak heap − baseline heap`? Two traps:
 *     1. The working tree lives IN the heap, so peak heap includes it.
 *     2. If the baseline isn't GC'd, ls-remote's lazy garbage inflates it,
 *        and the subtraction cancels the content — a falsely tiny number.
 *   Sampling content per-tick and subtracting it avoids both.
 *
 *   --expose-gc is required: without it V8's lazy GC leaves transient
 *   garbage uncollected and inflates heapUsed ~4×. We force a major GC
 *   each tick so we read the LIVE set.
 *
 * HOW TO RUN
 *   NODE_OPTIONS=--expose-gc MEMBENCH=1 \
 *     npx vitest run src/server/stream-clone.membench.test.ts
 *   MEMBENCH_REPO=https://github.com/o/other ...   # override the target
 */

import { describe, it, expect } from 'vitest'
import { streamClone } from './stream-clone'
import { MemoryGitClient } from './memory-git'
import { MemoryWorkspace } from './memory-workspace'

const WORKSPACE = '/workspace'
const REPO = process.env.MEMBENCH_REPO ?? 'https://github.com/Creators-of-Create/Create'

const mb = (n: number) => (n / 1024 / 1024).toFixed(1)

interface SamplerResult {
  peakTotal: number // highest heapUsed seen (INCLUDES content)
  peakTransient: number // highest (heapUsed − content) seen (EXCLUDES content)
  peakContent: number // highest resident _files seen
  samples: number
  gcForced: boolean
}

/** Sample process.memoryUsage AND the workspace's resident content each tick,
 *  forcing a major GC first when --expose-gc is available. */
function startSampler(getContent: () => number): { stop: () => SamplerResult } {
  const gc = (globalThis as { gc?: () => void }).gc
  let peakTotal = 0
  let peakTransient = 0
  let peakContent = 0
  let samples = 0
  const timer = setInterval(() => {
    samples++
    if (gc) gc()
    const heap = process.memoryUsage().heapUsed
    const content = getContent()
    if (heap > peakTotal) peakTotal = heap
    if (heap - content > peakTransient) peakTransient = heap - content
    if (content > peakContent) peakContent = content
  }, 50)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop: (): SamplerResult => {
      clearInterval(timer)
      return { peakTotal, peakTransient, peakContent, samples, gcForced: !!gc }
    },
  }
}

/** Sum the byte length of every file body currently in the workspace's
 *  in-memory backend (the resident working tree). */
function workspaceContent(ws: MemoryWorkspace): number {
  let total = 0
  for (const b of (ws.backend as unknown as { _files: Map<number, Uint8Array> })._files.values()) {
    total += b.byteLength
  }
  return total
}

describe.skipIf(!process.env.MEMBENCH)('streamClone heap-peak benchmark (real repo)', () => {
  it('measures the clone transient live overhead (workspace content excluded)', async () => {
    const log = (s: string) => process.stderr.write(s + '\n')

    const ws = new MemoryWorkspace()
    await ws.ready()
    const git = new MemoryGitClient(ws)

    // 1. Resolve the default branch via ls-remote.
    log(`\n[membench] resolving default branch for ${REPO} ...`)
    const refs = await git.lsRemote({ url: REPO, symrefs: true })
    const head = refs.find((r) => r.ref === 'HEAD' && r.target)
    if (!head?.target) throw new Error('could not resolve HEAD symref')
    const ref = head.target.replace(/^refs\/heads\//, '')
    log(`[membench] default branch = ${ref}`)

    // Baseline transient (empty workspace): GC first, then heap − 0 content.
    const gc = (globalThis as { gc?: () => void }).gc
    if (gc) gc()
    const baselineTransient = process.memoryUsage().heapUsed - workspaceContent(ws)

    // 2. Stream-clone directly (bypasses the isogit fallback).
    const sampler = startSampler(() => workspaceContent(ws))
    const t0 = Date.now()
    const result = await streamClone({ ws, url: REPO, dir: `${WORKSPACE}/repo`, ref })
    const elapsed = Date.now() - t0
    const { peakTotal, peakTransient, peakContent, samples, gcForced } = sampler.stop()

    // Final resident content + file count.
    let contentBytes = 0
    let fileCount = 0
    for (const b of (ws.backend as unknown as { _files: Map<number, Uint8Array> })._files.values()) {
      contentBytes += b.byteLength
      fileCount++
    }

    // THE headline: clone's own live cost, content excluded.
    const cloneOverhead = peakTransient - baselineTransient

    log('')
    log('========= streamClone heap-peak (real repo) =========')
    log(`repo:                   ${REPO}`)
    log(`ref:                    ${ref}`)
    log(`clone took:             ${elapsed} ms  (${samples} samples${gcForced ? ', GC forced each tick' : ', NO gc — run with --expose-gc'})`)
    log(`entries written:        ${result.entries}  (${fileCount} files)`)
    log(`bytes streamed:         ${mb(result.bytes)} MiB`)
    log(`---`)
    log(`empty-ws transient:     ${mb(baselineTransient)} MiB   (live heap − 0 content, before clone; Node/vitest/modules)`)
    log(`PEAK total heapUsed:    ${mb(peakTotal)} MiB       (highest live-set sample — INCLUDES content; the 128 MB budget number)`)
    log(`PEAK transient:         ${mb(peakTransient)} MiB       (highest heapUsed − content sample — EXCLUDES the files)`)
    log(`PEAK content (sampled): ${mb(peakContent)} MiB       (highest resident _files seen during clone)`)
    log(`final content:          ${mb(contentBytes)} MiB       (resident _files after clone)`)
    log(`---`)
    log(`clone overhead:         ${mb(cloneOverhead)} MiB        (peak transient − empty-ws transient) ← THE headline: streaming machinery cost, content EXCLUDED`)
    log(`overhead < content?     ${cloneOverhead < contentBytes ? 'YES' : 'NO'}          (${mb(cloneOverhead)} vs ${mb(contentBytes)} MiB — YES = no whole-archive buffering)`)
    log('=====================================================\n')

    expect(result.entries).toBeGreaterThan(0)
    if (gcForced) {
      // Streaming invariant: the clone's transient overhead (files excluded)
      // must stay below the content it produced. A whole-archive buffer
      // would push this to ≥ content.
      expect(cloneOverhead).toBeLessThan(contentBytes)
    }
  }, 180_000)
})
