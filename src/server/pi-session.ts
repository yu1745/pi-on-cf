import {
  DEFAULT_COMPACTION_SETTINGS,
  Session,
  compact as compactSession,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core'
import { Agent, callable } from 'agents'
import type { StreamingResponse } from 'agents'
import type {
  ApplyMemoryExtractionInput,
  CompactionSettings,
  Memory,
  MemoryKind,
  PiStreamEvent,
  SessionBranch,
  SessionIndexEvent,
  SessionOverview,
  SessionSummary,
  StoredSessionEntry,
  WorkspaceFile,
  WorkspaceFileContent,
} from '../shared/pi-contract'
import { createPiHarness, getMemoryModel, listModelOptions, type ModelOption, type PiHarness } from './create-pi-harness'
import { extractMemoryOperations, type MemorySourceEntry } from './memory-extractor'
import { createMemoryTool } from './memory-tools'
import { prepareManualCompaction } from './manual-compaction'
import { PiSessionStorage, type PiSessionMetadata } from './pi-session-storage'
import { toPiStreamEvent } from './stream-events'
import { PI_REGISTRY_INSTANCE } from '../shared/pi-contract'
import { createSessionSearchTool, createWorkspaceTools } from './workspace-tools'
import { createFetchTool } from './fetch-tool'
import { MemoryGitClient } from './memory-git'
import { MemoryWorkspace } from './memory-workspace'
import { WORKSPACE_ROOT, workspacePath } from './workspace-root'

type InitializeMetadata = Pick<SessionSummary, 'id' | 'createdAt' | 'updatedAt' | 'lineage'> & { name?: string }
type SessionExport = {
  metadata: PiSessionMetadata
  entries: SessionTreeEntry[]
  compaction: CompactionSettings
  files: Array<{ path: string; content: string; encoding?: 'base64' }>
}

const WORKSPACE_PAGE_SIZE = 250
const MEMORY_EXTRACTION_CURSOR = 'memoryExtractionRevision'
const MEMORY_EXTRACTION_BATCH_CHARS = 30_000
const MEMORY_SOURCE_ENTRY_CHARS = 12_000

type MemoryRegistry = {
  searchSessions(input: { query: string; limit?: number }): Promise<import('../shared/pi-contract').SessionSearchResult[]>
  getMemoryContext(): Promise<string>
  listMemories(): Promise<Memory[]>
  setMemory(input: { id?: string; kind: MemoryKind; content: string; sourceSessionId?: string }): Promise<Memory>
  deleteMemory(id: string): Promise<void>
  applyMemoryExtraction(input: ApplyMemoryExtractionInput): Promise<void>
  applyIndexEvents(sessionId: string, events: SessionIndexEvent[]): Promise<void>
}

type ComputerEnv = Env & {
  GIT_TOKEN?: string
  GIT_USERNAME?: string
}

export class PiSession extends Agent<Env> {
  /** Stay resident in memory while the user is connected. We do NOT
   *  hibernate: the filesystem is purely in-memory, so hibernation
   *  would silently wipe it. A non-hibernating DO is eventually
   *  evicted after the last connection drops, which is the desired
   *  "ephemeral session" behaviour. */
  static options = { hibernate: false } as const

  private active = false
  private harness?: PiHarness
  private memoryExtraction?: Promise<void>
  private autoNaming?: Promise<void>
  private selectedModelId?: string
  private readonly sessionStorage = new PiSessionStorage(this.ctx.storage)
  private readonly session = new Session(this.sessionStorage)
  private readonly workspace = new MemoryWorkspace()

  async onStart(): Promise<void> {
    await this.workspace.ready()
    // Wire a git client bound to the in-memory fs so git operations
    // stay entirely in memory too.
    this.workspace.setGit(new MemoryGitClient(this.workspace))
    if (this.sessionStorage.isInitialized()) {
      this.scheduleMemoryExtraction()
      this.scheduleAutoNaming()
    }
  }

  async initialize(metadata: InitializeMetadata): Promise<SessionOverview> {
    await this.workspace.mkdir(WORKSPACE_ROOT, { recursive: true })
    const created = this.sessionStorage.initialize({
      id: metadata.id,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      lineage: metadata.lineage,
    })
    if (created && metadata.name) await this.session.appendSessionName(metadata.name)
    return this.getOverview()
  }

  @callable()
  async getOverview(): Promise<SessionOverview> {
    await this.waitUntilInitialized()
    const metadata = await this.session.getMetadata()
    const rows = this.sessionStorage.getEntriesWithSeq()
    const leafId = await this.session.getLeafId()
    const activePath = new Set((await this.sessionStorage.getPathToRoot(leafId)).map((entry) => entry.id))
    const parentIds = new Set(rows.map(({ entry }) => entry.parentId).filter((id): id is string => id !== null))
    const stats = await this.session.getSessionStats()
    const labels = new Map<string, string | undefined>()
    for (const { entry } of rows) {
      if (entry.type === 'label') labels.set(entry.targetId, entry.label?.trim() || undefined)
    }
    return {
      id: metadata.id,
      name: await this.session.getSessionName(),
      status: 'ready',
      createdAt: metadata.createdAt,
      updatedAt: rows.at(-1)?.entry.timestamp ?? metadata.updatedAt,
      messageCount: stats.messageCount,
      activeLeafId: leafId,
      lineage: metadata.lineage,
      revision: rows.at(-1)?.seq ?? 0,
      compaction: this.compactionSettings(),
      tree: rows.map(({ seq, entry }) => ({
        seq,
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type,
        role: entry.type === 'message' ? entry.message.role : undefined,
        preview: entryPreview(entry),
        label: labels.get(entry.id),
        timestamp: entry.timestamp,
        isLeaf: !parentIds.has(entry.id),
        isOnActiveBranch: activePath.has(entry.id),
      })),
    }
  }

  @callable()
  async getBranch(leafId?: string): Promise<SessionBranch> {
    await this.waitUntilInitialized()
    const rows = this.sessionStorage.getEntriesWithSeq()
    const seqById = new Map(rows.map(({ seq, entry }) => [entry.id, seq]))
    const selectedLeaf = leafId ?? await this.session.getLeafId()
    const entries = await this.sessionStorage.getPathToRoot(selectedLeaf)
    return {
      leafId: selectedLeaf,
      revision: rows.at(-1)?.seq ?? 0,
      entries: entries.map((entry) => storedEntry(seqById.get(entry.id) ?? 0, entry)),
    }
  }

  @callable()
  async navigateTree(entryId: string, options?: { summarize?: boolean; customInstructions?: string; label?: string }): Promise<{ editorText?: string }> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      const result = await this.getHarness().navigateTree(entryId, options)
      await this.flushOutboxToRegistry()
      return { editorText: result.editorText }
    } finally {
      this.active = false
    }
  }

  @callable()
  async setSessionName(name: string): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      await this.session.appendSessionName(name)
      await this.flushOutboxToRegistry()
      return this.getOverview()
    })
  }

  @callable()
  async setEntryLabel(entryId: string, label?: string): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      await this.session.appendLabel(entryId, label)
      await this.flushOutboxToRegistry()
      return this.getOverview()
    })
  }

  @callable()
  async compact(focus?: string): Promise<{ summary: string; tokensBefore: number }> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      const result = await this.runCompaction(this.getHarness(), this.compactionSettings(), focus, true)
      await this.flushOutboxToRegistry()
      return result
    } finally {
      this.active = false
    }
  }

  @callable()
  async updateCompactionSettings(settings: CompactionSettings): Promise<CompactionSettings> {
    if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens < 0 ||
        !Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens < 0) {
      throw new Error('Compaction token settings must be non-negative integers.')
    }
    return this.withExclusiveOperation(async () => {
      const value = { ...settings }
      this.sessionStorage.setSetting('compaction', value)
      return value
    })
  }

  @callable()
  async steer(prompt: string): Promise<void> {
    await this.getHarness().steer(validPrompt(prompt))
  }

  @callable()
  async followUp(prompt: string): Promise<void> {
    await this.getHarness().followUp(validPrompt(prompt))
  }

  @callable()
  async abort(): Promise<void> {
    await this.getHarness().abort()
  }

  @callable()
  async listFiles(): Promise<WorkspaceFile[]> {
    const files = await this.listAllWorkspaceFiles()
    return files.map(({ path, size, updatedAt }) => ({ path, size, mtime: new Date(updatedAt).toISOString() }))
  }

  @callable()
  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    path = workspacePath(path)
    const [content, stat] = await Promise.all([this.workspace.readFile(path), this.workspace.stat(path)])
    if (content === null || !stat || stat.type !== 'file') throw new Error(`File not found: ${path}`)
    return { path, content, size: stat.size, mtime: new Date(stat.updatedAt).toISOString() }
  }

  @callable()
  async listModels(): Promise<{ models: ModelOption[]; selected?: string }> {
    return { models: listModelOptions(this.env), selected: this.selectedModelId }
  }

  @callable()
  async setModel(modelId: string): Promise<{ selected: string }> {
    const options = listModelOptions(this.env)
    if (!options.some((o) => o.id === modelId)) throw new Error(`Unknown model: ${modelId}`)
    this.selectedModelId = modelId
    this.harness = undefined
    return { selected: modelId }
  }

  @callable({ streaming: true })
  async prompt(stream: StreamingResponse, prompt: string, modelId?: string): Promise<void> {
    if (!this.env.CLOUDFLARE_ACCOUNT_ID || !this.env.AI_API_KEY) {
      if (!this.env.CF_API_TOKEN) {
        throw new Error('No LLM credentials configured. Set AI_API_KEY (env provider) or CF_API_TOKEN (Workers AI).')
      }
    }
    if (modelId && modelId !== this.selectedModelId) {
      this.selectedModelId = modelId
      this.harness = undefined
    }
    prompt = validPrompt(prompt)
    if (this.active) throw new Error('Pi is already running in this workspace.')

    this.active = true
    const harness = this.getHarness()
    const unsubscribe = harness.subscribe((event) => {
      const payload = toPiStreamEvent(event)
      if (payload) stream.send(payload)
      if (event.type === 'save_point') {
        this.ctx.waitUntil(this.flushOutboxToRegistry().catch((error) => console.error('Could not index session', error)))
      }
    })
    try {
      await this.compactIfNeeded(harness)
      await harness.prompt(prompt)
    } catch (error) {
      stream.send({ type: 'error', error: error instanceof Error ? error.message : String(error) } satisfies PiStreamEvent)
    } finally {
      unsubscribe()
      this.active = false
      stream.send({ type: 'done' } satisfies PiStreamEvent)
      stream.end()
      this.scheduleMemoryExtraction()
      this.scheduleAutoNaming()
    }
  }

  async exportSession(entryId?: string): Promise<SessionExport> {
    return this.withExclusiveOperation(() => this.createExport(entryId))
  }

  async exportFork(entryId: string): Promise<SessionExport> {
    return this.withExclusiveOperation(async () => {
      const target = await this.session.getEntry(entryId)
      if (!target || target.type !== 'message' || target.message.role !== 'user') {
        throw new Error('A fork must select a user message on the source branch.')
      }
      return this.createExport(target.parentId ?? undefined)
    })
  }

  async exportClone(): Promise<SessionExport> {
    return this.withExclusiveOperation(async () => this.createExport((await this.session.getLeafId()) ?? undefined))
  }

  async importSession(snapshot: SessionExport, metadata?: InitializeMetadata): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      const targetMetadata: PiSessionMetadata = metadata ? {
        id: metadata.id,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        lineage: metadata.lineage,
      } : snapshot.metadata
      this.sessionStorage.replace(targetMetadata, snapshot.entries)
      this.sessionStorage.setSetting('compaction', snapshot.compaction)
      this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, this.sessionStorage.getEntriesWithSeq().at(-1)?.seq ?? 0)
      for (const file of snapshot.files) {
        const path = workspacePath(file.path)
        if (this.isMountedPath(path)) continue
        const parent = path.slice(0, path.lastIndexOf('/')) || '/'
        if (parent !== '/') await this.workspace.mkdir(parent, { recursive: true })
        if (file.encoding === 'base64') await this.workspace.writeFile(path, decodeBase64(file.content))
        else await this.workspace.writeFile(path, file.content)
      }
      if (metadata?.name) await this.session.appendSessionName(metadata.name)
      this.harness = undefined
      return this.getOverview()
    })
  }

  async deleteContents(): Promise<void> {
    if (this.active) {
      const harness = this.getHarness()
      await harness.abort()
      await harness.waitForIdle()
    }
    this.active = true
    for (const entry of await this.workspace.readDir('/')) {
      if (this.isMountedPath(entry.path)) continue
      await this.workspace.rm(entry.path, { recursive: true, force: true })
    }
    await this.destroy()
  }

  // TODO: push these to PiRegistry when that binding is present in the generated Env type.
  async flushOutbox(): Promise<SessionIndexEvent[]> {
    return this.sessionStorage.getOutbox() as SessionIndexEvent[]
  }

  async acknowledgeOutbox(eventIds: string[]): Promise<void> {
    this.sessionStorage.acknowledgeOutbox(eventIds)
  }

  private getHarness(): PiHarness {
    const registry = this.registry()
    const sessionId = this.sessionStorage.getMetadataSync().id
    this.harness ??= createPiHarness({
      env: this.env,
      storage: this.sessionStorage,
      tools: [
        ...createWorkspaceTools(this.workspace, { gitAuth: gitAuthConfig(this.env as ComputerEnv) }),
        createFetchTool(),
        createSessionSearchTool(registry),
        createMemoryTool(registry, sessionId),
      ],
      memory: registry,
      modelId: this.selectedModelId,
    })
    return this.harness
  }

  private compactionSettings(): CompactionSettings {
    return this.sessionStorage.getSetting<CompactionSettings>('compaction') ?? { ...DEFAULT_COMPACTION_SETTINGS }
  }

  private async compactIfNeeded(harness: PiHarness): Promise<void> {
    const settings = this.compactionSettings()
    if (!settings.enabled) return
    const context = await this.session.buildContext()
    const estimate = estimateContextTokens(context.messages)
    if (!shouldCompact(estimate.tokens, harness.getModel().contextWindow, settings)) return
    await this.runCompaction(harness, settings)
  }

  private async runCompaction(harness: PiHarness, settings: CompactionSettings, focus?: string, manual = false) {
    const entries = await this.session.getBranch()
    const preparation = manual ? prepareManualCompaction(entries, settings) : prepareCompaction(entries, settings)
    if (!preparation.ok) throw preparation.error
    if (!preparation.value) throw new Error('Nothing to compact')
    if (preparation.value.messagesToSummarize.length === 0 && preparation.value.turnPrefixMessages.length === 0) {
      throw new Error('Nothing to compact')
    }
    const result = await compactSession(
      preparation.value,
      harness.models,
      harness.getModel(),
      focus,
      undefined,
      harness.getThinkingLevel(),
    )
    if (!result.ok) throw result.error
    await this.session.appendCompaction(
      result.value.summary,
      result.value.firstKeptEntryId,
      result.value.tokensBefore,
      result.value.details,
      false,
      result.value.usage,
      result.value.retainedTail,
    )
    return { summary: result.value.summary, tokensBefore: result.value.tokensBefore }
  }

  private async createExport(entryId?: string): Promise<SessionExport> {
    const entries = entryId ? await this.sessionStorage.getPathToRoot(entryId) : []
    const files = await this.listAllWorkspaceFiles()
    const contents: Array<{ path: string; content: string; encoding: 'base64' }> = []
    for (const { path } of files) {
      if (this.isMountedPath(path)) continue
      const content = await this.workspace.readFileBytes(path)
      if (content !== null) contents.push({ path, content: encodeBase64(content), encoding: 'base64' })
    }
    return {
      metadata: await this.session.getMetadata(),
      entries,
      compaction: this.compactionSettings(),
      files: contents,
    }
  }

  private async waitUntilInitialized(): Promise<void> {
    for (let attempt = 0; attempt < 40 && !this.sessionStorage.isInitialized(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!this.sessionStorage.isInitialized()) throw new Error('Session has not been initialized.')
  }

  private async listAllWorkspaceFiles() {
    const files: Awaited<ReturnType<typeof this.workspace.readDir>> = []
    if (!await this.workspace.stat(WORKSPACE_ROOT)) return files
    const directories = [WORKSPACE_ROOT]
    while (directories.length > 0) {
      const directory = directories.pop()!
      for (let offset = 0; ; offset += WORKSPACE_PAGE_SIZE) {
        const entries = await this.workspace.readDir(directory, { limit: WORKSPACE_PAGE_SIZE, offset })
        for (const entry of entries) {
          if (entry.type === 'directory') directories.push(entry.path)
          else if (entry.type === 'file') files.push(entry)
        }
        if (entries.length < WORKSPACE_PAGE_SIZE) break
      }
    }
    return Promise.all(files.map(async (file) => await this.workspace.stat(file.path) ?? file))
  }

  private isMountedPath(_path: string): boolean {
    // MemoryWorkspace has no mounts; nothing is ever a mounted path.
    return false
  }

  private async withExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      return await operation()
    } finally {
      this.active = false
    }
  }

  private async flushOutboxToRegistry(): Promise<void> {
    const events = this.sessionStorage.getOutbox() as SessionIndexEvent[]
    if (events.length === 0) return
    await this.registry().applyIndexEvents(this.sessionStorage.getMetadataSync().id, events)
    this.sessionStorage.acknowledgeOutbox(events.map((event) => event.eventId))
  }

  private registry(): MemoryRegistry {
    return this.env.PiRegistry.getByName(PI_REGISTRY_INSTANCE) as unknown as MemoryRegistry
  }

  private scheduleMemoryExtraction(): void {
    const previous = this.memoryExtraction
    const extraction = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(async () => {
        await this.flushOutboxToRegistry()
        await this.extractNextMemoryBatch()
      })
    this.memoryExtraction = extraction
    this.ctx.waitUntil(extraction
      .catch((error) => console.error('Could not extract session memory', error))
      .finally(() => {
        if (this.memoryExtraction === extraction) this.memoryExtraction = undefined
      }))
  }

  private scheduleAutoNaming(): void {
    const previous = this.autoNaming ?? this.memoryExtraction
    const naming = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(async () => {
        await this.flushOutboxToRegistry()
        await this.autoNameSessionIfUnnamed()
      })
    this.autoNaming = naming
    this.ctx.waitUntil(naming
      .catch((error) => console.error('Could not auto-name session', error))
      .finally(() => {
        if (this.autoNaming === naming) this.autoNaming = undefined
      }))
  }

  /** 会话还没有名称时，在第一次回答完成后自动生成一个标题。
   *  已有名称（用户手动命名过）绝不覆盖；命名失败保持未命名，下次会话活跃时再试。 */
  private async autoNameSessionIfUnnamed(): Promise<void> {
    if (!this.env.CLOUDFLARE_ACCOUNT_ID) return
    if (!this.env.AI_API_KEY && !this.env.CF_API_TOKEN) return
    const sessionId = this.sessionStorage.getMetadataSync().id
    if (await this.session.getSessionName()) return

    const entries = this.sessionStorage.getEntriesWithSeq()
    const isUserMessage = (entry: SessionTreeEntry): entry is Extract<SessionTreeEntry, { type: 'message' }> =>
      entry.type === 'message' && entry.message.role === 'user'
    const isAnswered = (entry: SessionTreeEntry): entry is Extract<SessionTreeEntry, { type: 'message' }> =>
      entry.type === 'message' && entry.message.role === 'assistant' && Boolean(messageText(entry.message).trim())
    const question = entries.map(({ entry }) => entry).find(isUserMessage)
    const answer = entries.map(({ entry }) => entry).find(isAnswered)
    if (!question || !answer) return

    const title = await generateSessionTitle(
      this.getHarness(),
      messageText(question.message).trim().slice(0, 2_000),
      messageText(answer.message).trim().slice(0, 2_000),
      sessionId,
    )
    if (!title) return
    await this.session.appendSessionName(title)
    await this.flushOutboxToRegistry()
  }

  private async extractNextMemoryBatch(): Promise<void> {
    if (!this.env.CLOUDFLARE_ACCOUNT_ID) return
    if (!this.env.AI_API_KEY && !this.env.CF_API_TOKEN) return
    const cursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    const pending = this.sessionStorage.getEntriesWithSeq().filter(({ seq }) => seq > cursor)
    if (pending.length === 0) return

    const entries: MemorySourceEntry[] = []
    let characters = 0
    let throughRevision = cursor
    for (const { seq, entry } of pending) {
      const source = memorySourceEntry(entry)
      const size = source?.text.length ?? 0
      if (entries.length > 0 && characters + size > MEMORY_EXTRACTION_BATCH_CHARS) break
      throughRevision = seq
      if (source) {
        entries.push(source)
        characters += size
      }
    }
    if (entries.length === 0) {
      this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, throughRevision)
      return
    }

    const registry = this.registry()
    const operations = await extractMemoryOperations({
      models: this.getHarness().models,
      model: getMemoryModel(this.env),
      memories: await registry.listMemories(),
      entries,
      sessionId: this.sessionStorage.getMetadataSync().id,
    })
    await registry.applyMemoryExtraction({
      extractionId: `${this.sessionStorage.getMetadataSync().id}:${throughRevision}`,
      sessionId: this.sessionStorage.getMetadataSync().id,
      throughRevision,
      operations,
    })
    const latestCursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, Math.max(latestCursor, throughRevision))
  }
}

function gitAuthConfig(env: ComputerEnv): { username: string; password: string } | undefined {
  const token = env.GIT_TOKEN
  if (!token) return undefined
  return { username: env.GIT_USERNAME || 'oauth2', password: token }
}

function validPrompt(prompt: string): string {
  prompt = prompt.trim()
  if (!prompt) throw new Error('A prompt is required.')
  if (prompt.length > 20_000) throw new Error('Prompt exceeds 20,000 characters.')
  return prompt
}

function storedEntry(seq: number, entry: SessionTreeEntry): StoredSessionEntry {
  return {
    seq,
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
    message: entry.type === 'message' ? entry.message : undefined,
    summary: entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.summary : undefined,
    firstKeptEntryId: entry.type === 'compaction' ? entry.firstKeptEntryId : undefined,
    targetId: entry.type === 'leaf' ? entry.targetId : entry.type === 'label' ? entry.targetId : undefined,
    label: entry.type === 'label' ? entry.label : undefined,
    name: entry.type === 'session_info' ? entry.name : undefined,
  }
}

function entryPreview(entry: SessionTreeEntry): string {
  let value = ''
  if (entry.type === 'message') value = messageText(entry.message)
  else if (entry.type === 'compaction' || entry.type === 'branch_summary') value = entry.summary
  else if (entry.type === 'session_info') value = entry.name ?? ''
  else if (entry.type === 'label') value = entry.label ?? ''
  else if (entry.type === 'custom_message') value = messageText(entry.content)
  return value.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function messageText(message: unknown): string {
  const content = typeof message === 'object' && message !== null && 'content' in message
    ? message.content
    : message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** 用一次轻量 LLM 请求，根据第一条问答生成会话标题。失败返回空字符串。 */
async function generateSessionTitle(harness: PiHarness, question: string, answer: string, sessionId: string): Promise<string> {
  const response = await harness.models.complete(harness.getModel(), {
    systemPrompt: [
      'You are the titling assistant for a Minecraft (我的世界) Q&A board.',
      'Given a player\'s question and the assistant\'s answer, produce a concise Chinese title that summarizes the topic.',
      'Rules: at most 20 Chinese characters; no quotes; no "标题：" prefix; no trailing punctuation; return only the title itself.',
    ].join('\n'),
    messages: [{
      role: 'user',
      content: `问题：${question}\n\n回答开头：${answer.slice(0, 800)}`,
      timestamp: Date.now(),
    }],
  }, {
    maxTokens: 64,
    transformHeaders: (headers: Record<string, string | null>) => ({
      ...headers,
      'cf-aig-metadata': JSON.stringify({ sessionId, purpose: 'session-naming' }),
    }),
  })
  if (response.stopReason === 'error' || response.stopReason === 'aborted') return ''
  const text = response.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
  return sanitizeSessionTitle(text)
}

function sanitizeSessionTitle(title: string): string {
  let value = title.replace(/^["'「『“”‘’]+|["'」』“”‘’]+$/g, '').trim()
  value = value.replace(/^标题[:：]\s*/, '')
  value = value.replace(/[\r\n]+/g, ' ').trim()
  if (!value || value.length > 40) return ''
  return value
}

function memorySourceEntry(entry: SessionTreeEntry): MemorySourceEntry | undefined {
  if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return
  let text = messageText(entry.message).trim()
  if (!text) return
  if (text.length > MEMORY_SOURCE_ENTRY_CHARS) {
    const half = MEMORY_SOURCE_ENTRY_CHARS / 2
    text = `${text.slice(0, half)}\n[...truncated for memory extraction...]\n${text.slice(-half)}`
  }
  return { id: entry.id, role: entry.message.role, text }
}

function encodeBase64(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(value)
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
