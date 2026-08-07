import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { Bash } from 'just-bash'
import type { SessionSearchResult } from '../shared/pi-contract'
import type { MemoryWorkspace } from './memory-workspace'
import { LightningFsAdapter } from './just-bash-fs-adapter'
import { defineBashGitCommand } from './bash-git-command'
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

export function createWorkspaceTools(workspace: MemoryWorkspace, options?: CreateWorkspaceToolsOptions) {
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
  const bashSchema = Type.Object({
    command: Type.String({ description: 'Bash command or script to run. Pipes, redirections, &&, variables, globs, loops, and functions all work. cwd is /workspace. Example: grep -rn TODO src/ | wc -l' }),
    cwd: Type.Optional(Type.String({ description: `Working directory, defaults to ${WORKSPACE_ROOT}` })),
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
  const bashTool: AgentHarnessTool<undefined, typeof bashSchema> = {
    name: 'bash',
    label: 'Run bash command',
    description:
      'Run a bash command against the in-memory workspace. Supports the full core unix toolset — pipes (|), redirections (> >> 2> &>), command chaining (&& || ;), variables, globs, loops, and functions — plus text tools like grep, sed, awk, jq, sort, uniq, wc, head/tail, cut, tr. `git clone` and `git ls-remote` are also available inside bash (SSH/bare URLs are rewritten to HTTPS automatically; .git is dropped after clone to save memory). Filesystem is shared with the read/write/edit tools: a file written with `write` is visible to `cat`, and vice versa. cwd is /workspace. There is no network beyond git/fetch and no native binaries (no npm, python, node).',
    parameters: bashSchema,
    executionMode: 'sequential',
    execute: async (_id, { command, cwd }, signal) => {
      signal?.throwIfAborted()
      const bash = new Bash({
        fs: new LightningFsAdapter(workspace.fs as unknown as ConstructorParameters<typeof LightningFsAdapter>[0]) as unknown as ConstructorParameters<typeof Bash>[0] extends { fs?: infer F } ? F : never,
        cwd: cwd ?? WORKSPACE_ROOT,
        // defenseInDepth hooks node:module.registerHooks, which workerd
        // does not implement; the Worker isolate IS the security
        // boundary (matches Computer's ShellWorker config).
        defenseInDepth: { enabled: false } as unknown as ConstructorParameters<typeof Bash>[0] extends { defenseInDepth?: infer D } ? D : never,
        executionLimits: { maxExecutionTimeMs: 30_000 },
        // git is exposed as a bash custom command (clone + ls-remote only).
        // See bash-git-command.ts. Other subcommands exit 1.
        customCommands: [defineBashGitCommand({
          git: workspace.git as never,
          workspaceRoot: WORKSPACE_ROOT,
          authHeaders,
        })],
      })
      const result = await bash.exec(command, { signal })
      signal?.throwIfAborted()
      const out = []
      if (result.stdout) out.push(`stdout:\n${result.stdout}`)
      if (result.stderr) out.push(`stderr:\n${result.stderr}`)
      out.push(`exit code: ${result.exitCode}`)
      return text(out.join('\n\n'))
    },
  }

  return [readTool, writeTool, editTool, listTool, bashTool]
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
