import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '../../client/router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Copy, GitFork, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { SessionSummary } from '../../shared/pi-contract'
import { useSessionRegistry } from './use-session-registry'

function relativeTime(value: string, now: number) {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

function displayName(session: SessionSummary) {
  return session.name?.trim() || `未命名问题 / ${session.id.slice(0, 8)}`
}

export function SessionCatalog() {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  async function mutate(key: string, operation: () => Promise<void>) {
    setBusy(key)
    setMutationError('')
    try {
      await operation()
      await registry.reload(query)
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy('')
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy('create')
    setMutationError('')
    try {
      const session = await registry.agent.stub.createSession({ name: name.trim() || undefined })
      await navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught))
      setBusy('')
    }
  }

  function rename(session: SessionSummary) {
    const nextName = window.prompt('问题标题', session.name ?? '')
    if (nextName === null) return
    void mutate(`rename-${session.id}`, async () => {
      await registry.agent.stub.renameSession(session.id, nextName.trim() || undefined)
    })
  }

  return (
    <main className="catalog-shell">
      <header className="catalog-masthead">
        <div className="brand-lockup">
          <div className="brand-mark">π</div>
          <div><p className="eyebrow">《我的世界》服务器答疑板</p><h1>MC 答疑板</h1></div>
        </div>
        <div className="catalog-counter"><strong>{registry.sessions.length.toString().padStart(2, '0')}</strong><span>个提问</span></div>
      </header>

      <section className="catalog-grid">
        <aside className="catalog-control">
          <p className="panel-index">01 / 提问</p>
          <h2>提出你的<br />问题</h2>
          <form onSubmit={create} className="create-session-form">
            <label htmlFor="session-name">问题标题 <span>可选</span></label>
            <input id="session-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：如何搭建风力发电机？" maxLength={120} />
            <Button type="submit" disabled={Boolean(busy)} className="catalog-primary">
              <Plus size={18} /> {busy === 'create' ? '提交中' : '提问'}
            </Button>
          </form>
          <div className="registry-note"><span>答疑板</span><strong>在线 / 随时提问</strong><p>每个提问都会开启一个独立的 AI 会话，结合《我的世界》模组源码为你解答。</p></div>
        </aside>

        <div className="catalog-list-area">
          <search>
          <form className="catalog-search" onSubmit={(event) => { event.preventDefault(); void registry.reload(query) }}>
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="session-search">搜索问题</label>
            <input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索问题内容 / re: 模式" />
            <Button type="submit" variant="outline" disabled={registry.loading}>搜索</Button>
          </form>
          </search>

          {(registry.error || mutationError) && <Banner className="error-banner" variant="error" role="alert" description={registry.error || mutationError} />}

          {query.trim() && registry.results.length > 0 && (
            <section className="search-results" aria-labelledby="search-results-title">
              <h2 id="search-results-title">问题匹配 / {registry.results.length}</h2>
              {registry.results.map(({ session, matches }) => (
                <article key={session.id}>
                  <Link to="/sessions/$sessionId" params={{ sessionId: session.id }}>{displayName(session)}</Link>
                  {matches.slice(0, 3).map((match) => <div className="search-hit" key={match.entryId}><span>{match.role === 'user' ? '用户' : '助手'}</span><p>{match.text}</p>{match.role === 'user' && <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void mutate(`fork-${match.entryId}`, async () => { const forked = await registry.agent.stub.forkSession({ sourceSessionId: session.id, entryId: match.entryId, name: `${session.name || '未命名问题'}追问` }); await navigate({ to: '/sessions/$sessionId', params: { sessionId: forked.id } }) })}><GitFork size={13} /> 在此追问</Button>}</div>)}
                </article>
              ))}
            </section>
          )}

          <section className="session-list" aria-labelledby="session-list-title" aria-busy={registry.loading}>
            <div className="session-list-heading"><h2 id="session-list-title">最近的问题</h2><span>按更新时间倒序</span></div>
            {!registry.loading && registry.sessions.length === 0 && <div className="catalog-empty"><strong>还没有提问</strong><span>提出你的第一个问题吧。</span></div>}
            {registry.sessions.map((session, index) => (
              <article className="session-row" key={session.id}>
                <span className="session-number">{String(index + 1).padStart(2, '0')}</span>
                <Link className="session-main-link" to="/sessions/$sessionId" params={{ sessionId: session.id }}>
                  <strong>{displayName(session)}</strong>
                  <span>{session.messageCount} 条对话 / {session.lineage.type.toUpperCase()} / <time dateTime={session.updatedAt}>{relativeTime(session.updatedAt, now)}</time></span>
                </Link>
                <div className="session-actions" aria-label={`对 ${displayName(session)} 的操作`}>
                  <Button shape="square" size="sm" variant="ghost" aria-label="重命名问题" title="重命名问题" disabled={Boolean(busy)} onClick={() => rename(session)} icon={<Pencil size={15} />} />
                  <Button shape="square" size="sm" variant="ghost" aria-label="克隆问题" title="克隆问题" disabled={Boolean(busy)} onClick={() => void mutate(`clone-${session.id}`, async () => { const clone = await registry.agent.stub.cloneSession({ sourceSessionId: session.id, name: `${session.name || '未命名问题'}副本` }); await navigate({ to: '/sessions/$sessionId', params: { sessionId: clone.id } }) })} icon={<Copy size={15} />} />
                  <Button shape="square" size="sm" variant="ghost" aria-label="删除问题" title="删除问题" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`删除 ${displayName(session)}？此操作不可撤销。`)) void mutate(`delete-${session.id}`, () => registry.agent.stub.deleteSession(session.id)) }} icon={<Trash2 size={15} />} />
                </div>
              </article>
            ))}
          </section>
        </div>
      </section>
    </main>
  )
}
