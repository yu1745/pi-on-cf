import { Button } from '@cloudflare/kumo/components/button'
import { GitBranch, GitFork, Scissors, Tag } from 'lucide-react'
import type { SessionOverview } from '../../../shared/pi-contract'

type SessionTreeProps = {
  compacting: boolean
  hidden: boolean
  overview: SessionOverview | null
  pending: boolean
  onCompact: () => void
  onFork: (entryId: string) => void
  onLabel: (entryId: string, label?: string) => void
  onNavigate: (entryId: string) => void
}

export function SessionTree({ compacting, hidden, overview, pending, onCompact, onFork, onLabel, onNavigate }: SessionTreeProps) {
  const nodes = overview?.tree ?? []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depth = (id: string) => {
    let value = 0
    let parentId = byId.get(id)?.parentId
    while (parentId && value < 12) {
      value += 1
      parentId = byId.get(parentId)?.parentId
    }
    return value
  }

  return (
    <section id="tree-panel" className={`workspace-panel tree-panel ${hidden ? 'panel-hidden' : ''}`} role="tabpanel" aria-label="TREE">
      <header className="workspace-header">
        <div><span className="panel-kicker">第 {overview?.revision ?? 0} 轮</span><strong>对话脉络</strong></div>
        <span className="branch-key"><i /> 当前脉络</span>
      </header>
      <div className="tree-list" aria-label="对话条目">
        {!overview && <p className="file-state">正在加载…</p>}
        {overview && nodes.length === 0 && <div className="file-empty"><GitBranch size={28} strokeWidth={1.5} /><strong>暂无对话</strong><span>提出一个问题，开始我们的对话。</span></div>}
        {nodes.map((node) => (
          <article className={`tree-node ${node.isOnActiveBranch ? 'active' : ''}`} key={node.id} style={{ '--tree-depth': Math.min(depth(node.id), 6) } as React.CSSProperties}>
            <button className="tree-node-main" onClick={() => onNavigate(node.id)} disabled={pending} aria-current={node.id === overview?.activeLeafId ? 'true' : undefined}>
              <span className="tree-rail" aria-hidden="true" />
              <span className="tree-meta">{node.seq.toString().padStart(3, '0')} / {node.role?.toUpperCase() || node.type.toUpperCase()}</span>
              <strong>{node.label || node.preview || node.type.replaceAll('_', ' ')}</strong>
              <small>{node.id}{node.isLeaf ? ' / 末端' : ''}</small>
            </button>
            <div className="tree-actions">
              <Button shape="square" size="sm" variant="ghost" aria-label={`标记条目 ${node.id}`} title="设置标签" disabled={pending} onClick={() => { const label = window.prompt('标签', node.label ?? ''); if (label !== null) onLabel(node.id, label.trim() || undefined) }} icon={<Tag size={13} />} />
              {node.type === 'message' && node.role === 'user' && <Button shape="square" size="sm" variant="ghost" aria-label={`从条目 ${node.id} 追问`} title="从这里追问" disabled={pending} onClick={() => onFork(node.id)} icon={<GitFork size={13} />} />}
            </div>
          </article>
        ))}
      </div>
      <footer className="tree-footer">
        <Button variant="ghost" aria-label="精简对话" disabled={pending} onClick={onCompact}><Scissors size={12} /> {compacting ? '精简中' : '精简'}</Button>
        <div><span>{nodes.filter((node) => node.isOnActiveBranch).length} 条当前</span><span>{nodes.filter((node) => node.isLeaf).length} 个末端</span></div>
      </footer>
    </section>
  )
}
