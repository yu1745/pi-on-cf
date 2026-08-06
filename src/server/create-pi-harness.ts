import { AgentHarness, Session, type AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { PiSessionStorage } from './pi-session-storage'

export type ModelSource = 'env' | 'cloudflare'

export type ModelOption = {
  /** Model id sent to the provider, e.g. "MiniMax-M3" or "@cf/zai-org/glm-5". */
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
  'Use the durable workspace tools to inspect and modify files.',
  'Workspace paths are absolute and rooted at /workspace.',
  'Available file tools: read, write, edit, list, find, and grep. These read and write the durable SQLite-backed workspace directly.',
  'The git tool performs git operations (clone, status, add, commit, push, pull, log) over HTTPS using isomorphic-git. SSH transports are not supported.',
  'Private-repository authentication is injected automatically from the configured token. Do not ask the user for credentials and never try to pass tokens, passwords, or Authorization headers yourself.',
  'There is no shell, no container, and no code execution tool. Use the file and git tools for everything; for searching use grep/find rather than shell pipelines.',
  'Files under /workspace/reference are a read-only R2 mount when configured.',
  'Use the memory tool only when the user directly asks to remember, save, correct, or forget something. Do not call it merely because they state a fact or preference; background extraction handles that.',
].join('\n')

/**
 * Build the list of selectable models for the UI.
 *
 * - The env-configured model (AI_MODEL via AI_BASE_URL) is always first and marked default.
 * - Cloudflare Workers AI models are appended when CF_AI_MODELS is set (comma-separated).
 *   They are served from the account-scoped Workers AI endpoint using CF_API_TOKEN.
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

  const cfModels = (env.CF_AI_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const id of cfModels) {
    if (options.some((option) => option.id === id)) continue
    options.push({ id, label: id, source: 'cloudflare' })
  }

  // If no env key, mark the first CF model as default.
  if (!env.AI_API_KEY && options.length > 0 && !options.some((o) => o.default)) {
    options[0].default = true
  }
  return options
}

/** Resolve a model id to its concrete Model descriptor + provider credentials. */
function resolveModel(env: Env, modelId: string, source: ModelSource): Model<'openai-completions'> {
  if (source === 'cloudflare') {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'cloudflare',
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 8_000,
    }
  }
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

function sourceFor(env: Env, modelId: string): ModelSource {
  const options = listModelOptions(env)
  const found = options.find((o) => o.id === modelId)
  if (found) return found.source
  // Unknown id: assume env provider if a key is set, else cloudflare.
  return env.AI_API_KEY ? 'env' : 'cloudflare'
}

export function createPiHarness({ env, storage, tools, memory, modelId }: CreatePiHarnessOptions) {
  const options = listModelOptions(env)
  const chosen = modelId && options.some((o) => o.id === modelId)
    ? modelId
    : (options.find((o) => o.default)?.id || options[0]?.id || env.AI_MODEL || 'MiniMax-M3')
  const source = sourceFor(env, chosen)
  const model = resolveModel(env, chosen, source)

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
      models: [resolveModel(env, env.AI_MODEL || 'MiniMax-M3', 'env')],
      api: { stream, streamSimple },
    }))
  }

  // Cloudflare Workers AI provider.
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CF_API_TOKEN) {
    const cfToken = env.CF_API_TOKEN
    const cfModelIds = (env.CF_AI_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)
    models.setProvider(createProvider({
      id: 'cloudflare',
      name: 'Cloudflare Workers AI',
      auth: {
        apiKey: {
          name: 'CF API token',
          resolve: async () => ({
            auth: {
              apiKey: cfToken,
              baseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
            },
            source: 'CF_API_TOKEN',
          }),
        },
      },
      models: cfModelIds.map((id) => resolveModel(env, id, 'cloudflare')),
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
  return resolveModel(env, id, sourceFor(env, id))
}

export function buildPiSystemPrompt(memoryContext: string): string {
  return memoryContext ? `${BASE_SYSTEM_PROMPT}\n\n${memoryContext}` : BASE_SYSTEM_PROMPT
}

export type PiHarness = ReturnType<typeof createPiHarness>
