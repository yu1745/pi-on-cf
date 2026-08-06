import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

/**
 * Web search tool. Workers reach the public internet with no CORS limits,
 * so search pairs naturally with the fetch tool: fetch is for a known URL,
 * web_search is for "find pages about X".
 *
 * Backends are pluggable because free, key-less web search is fragile on
 * edge IPs:
 *  - duckduckgo (default): no key, general web, parses the HTML results
 *    page. May be rate-limited; on failure the tool errors rather than
 *    silently substituting another source.
 *  - wikipedia: no key, rock-solid, but only the encyclopedia.
 *  - searxng: truly open source, general web, but you must point it at a
 *    SearXNG instance you trust (public ones usually block Workers IPs).
 *  - brave: stable, general web, needs a free-tier API key.
 *
 * Configure via SEARCH_BACKEND (+ SEARCH_API_URL for searxng,
 * SEARCH_API_KEY for brave). Defaults to duckduckgo+wikipedia.
 */

export type SearchBackend = 'duckduckgo' | 'wikipedia' | 'searxng' | 'brave'

export interface WebSearchConfig {
  backend?: SearchBackend
  /** SearXNG instance base URL (required when backend is searxng). */
  apiUrl?: string
  /** Subscription token (required when backend is brave). */
  apiKey?: string
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const schema = Type.Object({
  query: Type.String({ description: 'Search query.' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Maximum results to return. Defaults to 10.' })),
})

const text = (value: unknown) => ({
  content: [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)),
  }],
  details: {},
})

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

/** DDG wraps real result URLs in a `//duckduckgo.com/l/?uddg=<encoded>` redirect. Unwrap it. */
function resolveDdgUrl(raw: string): string {
  try {
    const href = raw.replace(/&amp;/g, '&')
    const full = href.startsWith('//') ? `https:${href}` : href
    const u = new URL(full)
    const uddg = u.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : full
  } catch { return raw }
}

async function fetchText(url: string, signal: AbortSignal | undefined, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res.text()
}

// ---------- backends ----------

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal)
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const titles = [...html.matchAll(titleRe)]
  const snippets = [...html.matchAll(snippetRe)]
  const out: SearchResult[] = []
  for (let i = 0; i < Math.min(titles.length, limit); i++) {
    const t = titles[i]!
    const url = resolveDdgUrl(t[1]!)
    // Skip unresolved DDG redirect links (site:operator-only hits, ad units).
    if (!url || /duckduckgo\.com\/l\//.test(url)) continue
    out.push({
      title: cleanText(t[2]!),
      url,
      snippet: cleanText(snippets[i]?.[1] ?? ''),
    })
  }
  return out
}

async function searchWikipedia(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const body = await fetchText(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${limit}&origin=*`,
    signal, { Accept: 'application/json' },
  )
  const data = JSON.parse(body) as { query?: { search?: Array<{ title: string; snippet: string }> } }
  return (data.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: cleanText(r.snippet),
  }))
}

async function searchSearxng(query: string, apiUrl: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const base = apiUrl.replace(/\/+$/, '')
  const body = await fetchText(
    `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&pageno=1`,
    signal, { Accept: 'application/json' },
  )
  const data = JSON.parse(body) as { results?: Array<{ title: string; url: string; content: string }> }
  return (data.results ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: cleanText(r.content) }))
}

async function searchBrave(query: string, apiKey: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { signal, headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey } },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } }
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: cleanText(r.description) }))
}

// ---------- tool ----------

export function createWebSearchTool(config: WebSearchConfig = {}): AgentHarnessTool<undefined, typeof schema> {
  const backend = config.backend ?? 'duckduckgo'
  return {
    name: 'web_search',
    label: 'Web search',
    description:
      'Search the public web for pages matching a query. Returns numbered titles, URLs, and short snippets. ' +
      'Use it for current information, docs, or to discover URLs you then read in full with the fetch tool. ' +
      'The backend is fixed server-side (default DuckDuckGo).',
    parameters: schema,
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted()
      const query = params.query.trim()
      if (!query) throw new Error('query is required')
      const limit = params.limit ?? 10

      const run = async (b: SearchBackend): Promise<SearchResult[]> => {
        if (b === 'searxng') {
          if (!config.apiUrl) throw new Error('searxng backend requires SEARCH_API_URL')
          return searchSearxng(query, config.apiUrl, limit, signal)
        }
        if (b === 'brave') {
          if (!config.apiKey) throw new Error('brave backend requires SEARCH_API_KEY')
          return searchBrave(query, config.apiKey, limit, signal)
        }
        if (b === 'wikipedia') return searchWikipedia(query, limit, signal)
        return searchDuckDuckGo(query, limit, signal)
      }

      let results: SearchResult[]
      try {
        results = await run(backend)
      } catch (error) {
        if (signal?.aborted) throw new Error('aborted')
        throw new Error(`search failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      signal?.throwIfAborted()

      if (results.length === 0) return text(`No results for "${query}".`)
      const header = `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"\n\n`
      const bodyText = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
      return text(header + bodyText)
    },
  }
}
