import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { SessionSearchResult } from '../shared/pi-contract'
import type { ComputerWorkspace } from './computer-workspace'
import { requireWorkspacePath, WORKSPACE_ROOT } from './workspace-root'

type RegistrySearch = {
  searchSessions(input: { query: string; limit?: number }): Promise<SessionSearchResult[]>
}

const text = (value: unknown) => ({
  content: [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)),
  }],
  details: {},
})

export type CreateWorkspaceToolsOptions = {
  /**
   * Credentials injected into git network operations (clone/push/pull)
   * via isomorphic-git's onAuth callback as HTTP Basic auth. Built from
   * the configured git token so the agent never handles credentials itself.
   */
  gitAuth?: { username: string; password: string }
}

export function createWorkspaceTools(workspace: ComputerWorkspace, options?: CreateWorkspaceToolsOptions) {
  const gitAuth = options?.gitAuth
  const authHeaders = gitAuth ? { Authorization: `Basic ${btoa(`${gitAuth.username}:${gitAuth.password}`)}` } : undefined

  const readSchema = Type.Object({ path: Type.String({ description: 'Absolute workspace path' }) })
  const writeSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    content: Type.String({ description: 'Complete file contents' }),
  })
  const editSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    search: Type.String({ minLength: 1, description: 'Non-empty exact text to replace' }),
    replacement: Type.String({ description: 'Replacement text' }),
  })
  const listSchema = Type.Object({
    path: Type.Optional(Type.String({ description: `Directory path, defaults to ${WORKSPACE_ROOT}` })),
  })
  const findSchema = Type.Object({ pattern: Type.String({ description: 'Glob pattern, such as **/*.ts' }) })
  const grepSchema = Type.Object({
    pattern: Type.String({ description: 'File glob to search' }),
    query: Type.String({ description: 'Text or regular expression to find' }),
  })
  const gitSchema = Type.Object({
    command: Type.Union([
      Type.Literal('clone'),
      Type.Literal('status'),
      Type.Literal('add'),
      Type.Literal('commit'),
      Type.Literal('push'),
      Type.Literal('pull'),
      Type.Literal('log'),
    ], { description: 'Git subcommand to run' }),
    url: Type.Optional(Type.String({ description: 'Repository URL for clone. HTTPS only.' })),
    message: Type.Optional(Type.String({ description: 'Commit message for commit' })),
    paths: Type.Optional(Type.Array(Type.String(), { description: 'Paths to stage for add, relative to dir. Defaults to ["."]' })),
    dir: Type.Optional(Type.String({ description: `Working-tree directory, defaults to ${WORKSPACE_ROOT}` })),
    ref: Type.Optional(Type.String({ description: 'Branch/tag/commit ref for clone/push/pull' })),
    remote: Type.Optional(Type.String({ description: 'Remote name for push/pull, defaults to "origin"' })),
    force: Type.Optional(Type.Boolean({ description: 'Force push' })),
  })

  const readTool: AgentHarnessTool<undefined, typeof readSchema> = {
    name: 'read',
    label: 'Read file',
    description: 'Read a UTF-8 file from the durable workspace.',
    parameters: readSchema,
    execute: async (_id, { path }, signal) => {
      signal?.throwIfAborted()
      requireWorkspacePath(path)
      const content = await workspace.readFile(path)
      signal?.throwIfAborted()
      if (content === null) throw new Error(`File not found: ${path}`)
      return text(content)
    },
  }
  const writeTool: AgentHarnessTool<undefined, typeof writeSchema> = {
    name: 'write',
    label: 'Write file',
    description: 'Write a complete UTF-8 file to the durable workspace.',
    parameters: writeSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, content }, signal) => {
      signal?.throwIfAborted()
      requireWorkspacePath(path)
      await workspace.writeFile(path, content)
      signal?.throwIfAborted()
      return text(`Wrote ${path}`)
    },
  }
  const editTool: AgentHarnessTool<undefined, typeof editSchema> = {
    name: 'edit',
    label: 'Edit file',
    description: 'Replace exact text in a durable workspace file.',
    parameters: editSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, search, replacement }, signal) => {
      signal?.throwIfAborted()
      requireWorkspacePath(path)
      const content = await workspace.readFile(path)
      if (content === null) throw new Error(`File not found: ${path}`)
      const occurrences = content.split(search).length - 1
      if (occurrences !== 1) throw new Error(`Expected exactly one match in ${path}, found ${occurrences}.`)
      await workspace.writeFile(path, content.replace(search, replacement))
      signal?.throwIfAborted()
      return text(`Updated ${path}`)
    },
  }
  const listTool: AgentHarnessTool<undefined, typeof listSchema> = {
    name: 'list',
    label: 'List directory',
    description: 'List files and directories in the durable workspace.',
    parameters: listSchema,
    execute: async (_id, { path }, signal) => {
      signal?.throwIfAborted()
      const directory = requireWorkspacePath(path ?? WORKSPACE_ROOT)
      const result = await workspace.readDir(directory)
      signal?.throwIfAborted()
      return text(result)
    },
  }
  const findTool: AgentHarnessTool<undefined, typeof findSchema> = {
    name: 'find',
    label: 'Find files',
    description: 'Find durable workspace files using a glob pattern.',
    parameters: findSchema,
    execute: async (_id, { pattern }, signal) => {
      signal?.throwIfAborted()
      if (pattern.startsWith('/')) requireWorkspacePath(pattern)
      const result = await workspace.glob(pattern)
      signal?.throwIfAborted()
      return text(result)
    },
  }
  const grepTool: AgentHarnessTool<undefined, typeof grepSchema> = {
    name: 'grep',
    label: 'Search files',
    description: 'Search matching durable workspace files for text.',
    parameters: grepSchema,
    execute: async (_id, { pattern, query }, signal) => {
      signal?.throwIfAborted()
      if (pattern.startsWith('/')) requireWorkspacePath(pattern)
      const files = (await workspace.glob(pattern)).filter((entry) => entry.type === 'file')
      const result = (await Promise.all(files.map((file) => workspace.fs.grep(query, file.path)))).flat()
      signal?.throwIfAborted()
      return text(result)
    },
  }

  const gitTool: AgentHarnessTool<undefined, typeof gitSchema> = {
    name: 'git',
    label: 'Git',
    description: 'Run git operations (clone/status/add/commit/push/pull/log) via isomorphic-git over HTTPS. Private-repo auth is injected automatically.',
    parameters: gitSchema,
    executionMode: 'sequential',
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted()
      const dir = requireWorkspacePath(params.dir ?? WORKSPACE_ROOT)
      const git = workspace.git
      try {
        switch (params.command) {
          case 'clone': {
            if (!params.url) throw new Error('url is required for clone')
            await git.clone({ url: params.url, dir, ref: params.ref, headers: authHeaders })
            signal?.throwIfAborted()
            return text(`Cloned ${params.url}${params.ref ? ` (ref ${params.ref})` : ''} into ${dir}`)
          }
          case 'status': {
            const entries = await git.status({ dir })
            signal?.throwIfAborted()
            return text(entries)
          }
          case 'add': {
            const paths = params.paths ?? ['.']
            await git.add({ dir, paths })
            signal?.throwIfAborted()
            return text(`Staged ${paths.join(', ')}`)
          }
          case 'commit': {
            if (!params.message) throw new Error('message is required for commit')
            const result = await git.commit({ message: params.message, dir })
            signal?.throwIfAborted()
            return text({ oid: result.oid })
          }
          case 'push': {
            const result = await git.push({ dir, remote: params.remote ?? 'origin', ref: params.ref, force: params.force, headers: authHeaders })
            signal?.throwIfAborted()
            return text(result)
          }
          case 'pull': {
            await git.pull({ dir, remote: params.remote ?? 'origin', ref: params.ref, headers: authHeaders })
            signal?.throwIfAborted()
            return text(`Pulled into ${dir}`)
          }
          case 'log': {
            const commits = await git.log({ dir })
            signal?.throwIfAborted()
            return text(commits)
          }
        }
      } catch (error) {
        throw new Error(`git ${params.command} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      throw new Error(`Unknown git command: ${params.command}`)
    },
  }

  return [readTool, writeTool, editTool, listTool, findTool, grepTool, gitTool]
}

export function createSessionSearchTool(
  registry: RegistrySearch,
): AgentHarnessTool<undefined> {
  const parameters = Type.Object({
    query: Type.String({ description: 'Lexical query, quoted phrase, or re: regular expression' }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  })
  return {
    name: 'session_search',
    label: 'Search sessions',
    description: 'Search prior Pi sessions for relevant user and assistant message text.',
    parameters,
    execute: async (_id, { query, limit }, signal) => {
      signal?.throwIfAborted()
      const results = await registry.searchSessions({ query, limit })
      signal?.throwIfAborted()
      return text(results.map(({ session, matches }) => ({
        sessionId: session.id,
        name: session.name,
        updatedAt: session.updatedAt,
        matches: matches.map(({ entryId, role, timestamp, text: matchText }) => ({
          entryId,
          role,
          timestamp,
          text: matchText.slice(0, 2_000),
        })),
      })))
    },
  }
}
