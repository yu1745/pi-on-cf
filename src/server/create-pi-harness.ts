import { AgentHarness, Session, type AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { PiSessionStorage } from './pi-session-storage'

export type ModelSource = 'env'

export type ModelOption = {
  /** Model id sent to the provider, e.g. "MiniMax-M3" or "deepseek-v4-flash". */
  id: string
  /** Display label for the UI selector. */
  label: string
  /** Where the model is served. */
  source: ModelSource
  /** Whether this is the currently configured default. */
  default?: boolean
}

type CreatePiHarnessOptions = {
  env: Env
  storage: PiSessionStorage
  tools: AgentHarnessTool<undefined>[]
  memory: { getMemoryContext(): Promise<string> }
  /** Model id chosen by the UI. Falls back to env default. */
  modelId?: string
}

const BASE_SYSTEM_PROMPT = [
  'You are Pi running natively on Cloudflare Workers.',
  'This instance is a Q&A board (答疑板) for the user\'s Minecraft (我的世界) server. Users come here to ask questions about modded Minecraft — mainly IC2 / IndustrialCraft 2 / 工业2. Be a friendly Minecraft mod expert and answer their questions in Chinese, grounding answers in the actual ic2-fabric source code when relevant.',
  'Always respond in Chinese (中文) unless the user explicitly asks otherwise.',
  'Use the workspace tools to inspect and modify files.',
  'Workspace paths are absolute and rooted at /workspace.',
  'Available file tools: read, write, edit, and list. These operate on an in-memory filesystem — extremely fast, but see the lifetime note below.',,
  'Git is available inside the bash tool with exactly two subcommands: `git clone <url> [<dir>] [-b <ref>]` and `git ls-remote <url> [--heads] [--tags] [--symref] [<patterns>...)`. Both are strictly read-only network fetches. SSH/bare URLs (git@host:o/r, ssh://..., host/o/r) are rewritten to HTTPS automatically; .git is dropped after clone to save memory. No other git subcommand exists — there is no status/log/diff/branch/checkout/add/commit/push, so you can neither inspect a local working tree\'s git state nor modify any repository. Never attempt to modify any repository or push to a remote. Treat all repositories as read-only.',
  'Private-repository authentication is injected automatically from the configured token, solely so `git clone` / `git ls-remote` can read private repos. Do not ask the user for credentials and never try to pass tokens, passwords, or Authorization headers yourself.',
  'HTTP requests: use `curl` inside bash. It runs on the server (no browser CORS), so you can fetch web pages, query REST/JSON APIs, and download text — and pipe the result through grep/jq/sed/wc/etc. for processing (e.g. `curl -s https://api.example.com | jq .field`). HTML comes back as raw markup; strip tags with `sed`/`grep` if you only need text. There is no separate fetch tool — curl is the only HTTP surface.',
  'In the bash tool there is no native binary execution (no npm, python, node). For searching, piping, or any text processing use bash (grep, sed, awk, jq, find, sort, uniq, wc, etc. all work, with pipes and redirections) — it is strictly more capable than a dedicated search tool and operates on the same filesystem as read/write. For HTTP use `curl` inside bash. For git use `git clone`/`git ls-remote` inside bash.',
  'The in-memory filesystem is tied to this session\'s lifetime: when the session is idle for a while the runtime may restart it, which empties the filesystem. If a file or repository that should exist is missing (ENOENT), do not treat it as user error — re-clone the repository or re-create the file as needed. Conversation history persists across such restarts, so the user may refer to work from earlier without realizing the files are gone.',
  'Use the memory tool only when the user directly asks to remember, save, correct, or forget something. Do not call it merely because they state a fact or preference; background extraction handles that.',
  'When the user asks anything about IC2 (IndustrialCraft 2 / 工业2), that always refers to the project github.com/yu1745/ic2-fabric. Before answering, run `git clone https://github.com/yu1745/ic2-fabric` in bash (or re-clone it if the repository is missing, per the filesystem lifetime note above) so you can answer from the actual source code.',
].join('\n')

/**
 * Build the list of selectable models for the UI.
 *
 * Only the env-configured model (AI_MODEL via AI_BASE_URL / AI_API_KEY)
 * is offered. There is no longer a Cloudflare Workers AI fallback list.
 */
export function listModelOptions(env: Env): ModelOption[] {
  const options: ModelOption[] = []

  const envModelId = env.AI_MODEL || 'MiniMax-M3'
  if (env.AI_API_KEY) {
    options.push({
      id: envModelId,
      label: envModelId,
      source: 'env',
      default: true,
    })
  }
  return options
}

/** Resolve a model id to its concrete Model descriptor + provider credentials. */
function resolveModel(env: Env, modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: env.AI_BASE_URL || 'https://api.minimaxi.com/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  }
}

export function createPiHarness({ env, storage, tools, memory, modelId }: CreatePiHarnessOptions) {
  const options = listModelOptions(env)
  const chosen = modelId && options.some((o) => o.id === modelId)
    ? modelId
    : (options.find((o) => o.default)?.id || options[0]?.id || env.AI_MODEL || 'MiniMax-M3')
  const model = resolveModel(env, chosen)

  const models = createModels()

  // Env OpenAI-compatible provider (MiniMax / DeepSeek / etc).
  if (env.AI_API_KEY) {
    models.setProvider(createProvider({
      id: 'openai',
      name: 'OpenAI-compatible',
      auth: {
        apiKey: {
          name: 'API key',
          resolve: async () => ({
            auth: { apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL || 'https://api.minimaxi.com/v1' },
            source: 'AI_API_KEY',
          }),
        },
      },
      models: [resolveModel(env, env.AI_MODEL || 'MiniMax-M3')],
      api: { stream, streamSimple },
    }))
  }

  return new AgentHarness({
    session: new Session(storage),
    models,
    model,
    tools,
    systemPrompt: async () => {
      try {
        return buildPiSystemPrompt(await memory.getMemoryContext())
      } catch (error) {
        console.error('Could not load long-term memory', error)
        return buildPiSystemPrompt('')
      }
    },
    thinkingLevel: 'medium',
  })
}

export function getMemoryModel(env: Env): Model<'openai-completions'> {
  const id = env.AI_MEMORY_MODEL || env.AI_MODEL || 'MiniMax-M3'
  return resolveModel(env, id)
}

export function buildPiSystemPrompt(memoryContext: string): string {
  return memoryContext ? `${BASE_SYSTEM_PROMPT}\n\n${memoryContext}` : BASE_SYSTEM_PROMPT
}

export type PiHarness = ReturnType<typeof createPiHarness>
