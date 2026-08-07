import { Link, useNavigate } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { ArrowLeft, GitCommitHorizontal } from 'lucide-react'
import { PromptComposer } from './components/prompt-composer'
import { SessionTree } from './components/session-tree'
import { TranscriptView } from './components/transcript-view'
import { WorkspaceBrowser } from './components/workspace-browser'
import { usePiSession } from './use-pi-session'

export function WorkspaceApp({ sessionId }: { sessionId: string }) {
  return <WorkspaceSession key={sessionId} sessionId={sessionId} />
}

function WorkspaceSession({ sessionId }: { sessionId: string }) {
  const session = usePiSession(sessionId)
  const navigate = useNavigate()
  const messageCount = session.entries.filter((entry) => entry.type === 'message').length
  const name = session.overview?.name || `未命名问题 / ${sessionId.slice(0, 8)}`
  const lineage = session.overview?.lineage
  function rename() {
    const next = window.prompt('问题标题', session.overview?.name ?? '')
    if (next !== null) void session.rename(next.trim())
  }

  async function fork(entryId: string) {
    try {
      const forked = await session.fork(entryId, `${session.overview?.name || '未命名问题'}追问`)
      await navigate({ to: '/sessions/$sessionId', params: { sessionId: forked.id } })
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <main className="app-shell">
      <header className="masthead workspace-masthead">
        <div className="brand-lockup">
          <Link to="/" className="back-button" aria-label="返回问题列表"><ArrowLeft size={19} /></Link>
          <div className="brand-mark">π</div>
          <div className="session-title">
            <p className="eyebrow">提问 / {sessionId}</p>
            <h1><button onClick={rename} disabled={!session.overview || Boolean(session.pendingAction)} title="重命名问题">{name}</button></h1>
            <p className="lineage-line">
              {lineage?.type.toUpperCase() || '加载中'}
              {lineage?.parentSessionId && <> 源自 <Link to="/sessions/$sessionId" params={{ sessionId: lineage.parentSessionId }}>{lineage.parentSessionId.slice(0, 8)}</Link></>}
            </p>
          </div>
        </div>
        <div className="runtime-status">
          <select
            aria-label="模型"
            value={session.selectedModel}
            onChange={(event) => void session.selectModel(event.target.value)}
            disabled={Boolean(session.pendingAction) || session.isRunning}
          >
            {session.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.source === 'env' ? '★ ' : ''}{model.label}
              </option>
            ))}
          </select>
          <span className="status-light" />AI 在线
        </div>
      </header>

      <section className="workbench">
        <nav className="mobile-switcher" aria-label="工作区视图">
          <Tabs
            tabs={[
              { value: 'chat', label: '对话', render: <button id="chat-tab" aria-label="对话" aria-controls="chat-panel" /> },
              { value: 'files', label: <>文件 <span>{session.files.length}</span></>, render: <button id="files-tab" aria-label="文件" aria-controls="files-panel" /> },
              { value: 'tree', label: <>树 <span>{session.overview?.tree.length ?? 0}</span></>, render: <button id="tree-tab" aria-label="树" aria-controls="tree-panel" /> },
            ]}
            value={session.mobileView}
            onValueChange={(value) => session.setMobileView(value as 'chat' | 'files' | 'tree')}
            activateOnFocus className="mobile-tabs" listClassName="mobile-tabs-list" indicatorClassName="mobile-tabs-indicator"
          />
        </nav>

        <div id="chat-panel" className={`console-panel ${session.mobileView !== 'chat' ? 'mobile-hidden' : ''}`} role="tabpanel" aria-label="对话" aria-labelledby="chat-tab">
          <div className="console-header"><span>对话</span><span>{messageCount} 条对话</span></div>
          <TranscriptView activeTextId={session.activeTextId} entries={session.entries} isRunning={session.isRunning} onScroll={session.handleTranscriptScroll} onTryOperation={() => session.setInput('如何正确搭建 IC2 风力发电机并接入电网？')} transcriptRef={session.transcriptRef} />
          {session.error && <Banner className="error-banner" variant="error" role="alert" description={session.error} />}
          <PromptComposer input={session.input} isReady={session.isReady} isResetting={Boolean(session.pendingAction)} isRunning={session.isRunning} onAbort={() => void session.abort()} onInputChange={session.setInput} onSubmit={session.submit} />
        </div>

        <div className={`right-panel ${session.mobileView === 'chat' ? 'mobile-hidden' : ''}`}>
          <div className="desktop-panel-tabs" aria-label="工作区面板" role="tablist">
            <button id="desktop-files-tab" role="tab" aria-label="文件面板" aria-controls="files-panel" aria-selected={session.desktopPanel === 'files'} tabIndex={session.desktopPanel === 'files' ? 0 : -1} className={session.desktopPanel === 'files' ? 'active' : ''} onClick={() => session.setDesktopPanel('files')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { session.setDesktopPanel('tree'); document.getElementById('desktop-tree-tab')?.focus() } }}><GitCommitHorizontal size={14} /> 文件</button>
            <button id="desktop-tree-tab" role="tab" aria-label="树面板" aria-controls="tree-panel" aria-selected={session.desktopPanel === 'tree'} tabIndex={session.desktopPanel === 'tree' ? 0 : -1} className={session.desktopPanel === 'tree' ? 'active' : ''} onClick={() => session.setDesktopPanel('tree')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { session.setDesktopPanel('files'); document.getElementById('desktop-files-tab')?.focus() } }}><GitCommitHorizontal size={14} /> 树</button>
          </div>
          <WorkspaceBrowser canDownload={session.canDownload} fileContent={session.fileContent} fileError={session.fileError} files={session.files} filesError={session.filesError} filesLoading={session.filesLoading} hidden={(session.mobileView === 'files' ? false : session.mobileView === 'tree' ? true : session.desktopPanel !== 'files')} onDownload={session.downloadSelectedFile} onRefresh={() => void session.refreshFiles()} onSelectPath={session.setSelectedPath} selectedPath={session.selectedPath} />
          <SessionTree compacting={session.pendingAction === 'compact'} hidden={(session.mobileView === 'tree' ? false : session.mobileView === 'files' ? true : session.desktopPanel !== 'tree')} overview={session.overview} pending={Boolean(session.pendingAction) || session.isRunning} onCompact={() => void session.compact()} onFork={(entryId) => void fork(entryId)} onLabel={(entryId, label) => void session.setEntryLabel(entryId, label)} onNavigate={(entryId) => void session.navigateTree(entryId)} />
        </div>
      </section>
    </main>
  )
}
