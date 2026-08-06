import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { convert } from 'html-to-text'

/**
 * Network access tool. Cloudflare Workers expose a global `fetch` that
 * runs from the server edge, so there are no browser CORS restrictions —
 * the agent can read any public URL or API directly. This wraps that
 * capability as an agent tool with sensible safety rails.
 *
 * HTML extraction uses `html-to-text` (htmlparser2-based, pure JS, no DOM
 * dependency) rather than hand-rolled regex: it handles entity decoding,
 * block-level spacing, lists, tables, and link hrefs correctly, which
 * matters a lot for the model's ability to read fetched pages.
 *
 * Safety:
 *  - The body is streamed and read stops at `max_bytes`, cancelling the
 *    stream so a multi-MB response can never OOM the isolate.
 *  - Binary content types are detected and their bodies omitted.
 *  - The user's abort signal is forwarded to `fetch` so cancellation
 *    interrupts the request immediately.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
type Method = (typeof METHODS)[number]

const fetchSchema = Type.Object({
  url: Type.String({
    description: 'Absolute URL to request. The http:// or https:// prefix is added automatically if omitted.',
  }),
  method: Type.Optional(Type.Union(
    METHODS.map((m) => Type.Literal(m)),
    { description: 'HTTP method. Defaults to GET.' },
  )),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: 'Request headers as a key/value object, e.g. {"Authorization": "Bearer x", "Accept": "application/json"}.',
  })),
  body: Type.Optional(Type.String({
    description: 'Request body for POST/PUT/PATCH requests (sent verbatim).',
  })),
  max_bytes: Type.Optional(Type.Integer({
    minimum: 1_000,
    maximum: 1_000_000,
    description: 'Maximum response body bytes to read and return. Larger bodies are truncated. Defaults to 50000.',
  })),
})

const text = (value: unknown) => ({
  content: [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)),
  }],
  details: {},
})

/** Content-type prefixes whose bodies are not human/model-readable text. */
function isBinaryType(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  return /^(image\/|video\/|audio\/|font\/|application\/octet-stream|application\/zip|application\/pdf|application\/x-|application\/gzip|application\/wasm|model\/)/.test(ct)
}

/**
 * Read up to `maxBytes` from a response stream, then cancel it so the
 * remaining bytes are never buffered. Returns the decoded UTF-8 text, the
 * total bytes the server started sending, and whether truncation happened.
 */
async function readBodyUpTo(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; totalBytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', totalBytes: 0, truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let total = 0
  let truncated = false
  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (received < maxBytes) {
        chunks.push(value)
        received += value.byteLength
      } else {
        // Already have our budget; stop reading and release the stream.
        truncated = true
        await reader.cancel()
        break
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
  truncated = truncated || total > maxBytes
  // Merge collected chunks, capping to maxBytes (a final chunk may push past).
  const cap = Math.min(received, maxBytes)
  const merged = new Uint8Array(cap)
  let off = 0
  for (const chunk of chunks) {
    if (off >= cap) break
    const end = off + chunk.byteLength
    if (end <= cap) {
      merged.set(chunk, off)
      off = end
    } else {
      merged.set(chunk.subarray(0, cap - off), off)
      off = cap
    }
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(merged)
  return { text: decoded, totalBytes: total, truncated }
}

export function createFetchTool(): AgentHarnessTool<undefined, typeof fetchSchema> {
  return {
    name: 'fetch',
    label: 'Fetch URL',
    description:
      'Make an HTTP request to any URL from the server (no browser CORS limits). ' +
      'Use to read web pages, query REST/JSON APIs, fetch documentation, or download text. ' +
      'Responses are streamed and truncated to max_bytes (default 50KB) to protect memory. ' +
      'JSON is pretty-printed; HTML is converted to readable plain text; binary bodies are summarized. ' +
      'Non-2xx status codes are returned normally (not errors) so response bodies are still readable.',
    parameters: fetchSchema,
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted()

      // Normalise and validate the URL.
      let urlStr = params.url.trim()
      if (!/^https?:\/\//i.test(urlStr)) urlStr = `http://${urlStr}`
      let parsed: URL
      try {
        parsed = new URL(urlStr)
      } catch {
        throw new Error(`Invalid URL: ${params.url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`)
      }

      const method = (params.method ?? 'GET').toUpperCase() as Method
      const maxBytes = params.max_bytes ?? 50_000

      const init: RequestInit = {
        method,
        redirect: 'follow',
        signal,
      }
      if (params.headers) init.headers = params.headers
      if (params.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.body = params.body
      }

      let res: Response
      try {
        res = await fetch(parsed.href, init)
      } catch (error) {
        if (signal?.aborted) throw new Error('aborted')
        throw new Error(`fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      signal?.throwIfAborted()

      const contentType = res.headers.get('content-type') || ''
      const contentLength = res.headers.get('content-length')
      const headerLines = [
        `${res.status} ${res.statusText}`.trim(),
        `content-type: ${contentType}`.trim(),
        contentLength ? `content-length: ${contentLength}` : null,
        `url: ${res.url}`,
      ].filter((l): l is string => l !== null && l.length > 0).join('\n')

      // Binary bodies: do not stream/decode, just report metadata.
      if (isBinaryType(contentType)) {
        return text(`${headerLines}\n\n[binary body (${contentType || 'unknown'}) — content omitted, use a dedicated tool if you need it]`)
      }

      // Text-ish bodies: stream up to the cap and clean per content-type.
      const { text: raw, totalBytes, truncated } = await readBodyUpTo(res, maxBytes, signal)
      signal?.throwIfAborted()

      let body = raw
      if (/\bjson\b/i.test(contentType)) {
        try { body = JSON.stringify(JSON.parse(raw), null, 2) } catch { /* keep raw */ }
      } else if (/\bhtml\b/i.test(contentType)) {
        // html-to-text strips scripts/styles, decodes entities, formats
        // lists/tables/headings, and keeps link hrefs — far more reliable
        // than regex for the model to read a fetched page.
        body = convert(raw, {
          wordwrap: false,
          limits: { maxInputLength: maxBytes + 1024 },
          selectors: [
            { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
            { selector: 'img', format: 'skip' },
          ],
        }).trim()
      }
      // XML / RSS / plain text / everything else: return raw (structure is useful).

      let out = `${headerLines}\n\n${body}`
      if (truncated) {
        out += `\n\n[... response truncated at ${maxBytes} bytes of ${totalBytes} total; increase max_bytes to read more]`
      }
      return text(out)
    },
  }
}
