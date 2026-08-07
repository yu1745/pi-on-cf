import { lazy, memo, Suspense } from 'react'
import type { RefObject, UIEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Streamdown } from 'streamdown'
import type { TranscriptEntry } from '../transcript'
import { ActivityCard } from './activity-card'

const HighlightedMarkdown = lazy(() => import('./highlighted-code').then((module) => ({ default: module.HighlightedMarkdown })))

function latestAssistantText(entries: TranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type === 'message' && entry.role === 'assistant') return entry.text
  }
  return ''
}

type TranscriptViewProps = {
  activeTextId: string
  entries: TranscriptEntry[]
  isRunning: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  onTryOperation: () => void
  transcriptRef: RefObject<HTMLDivElement | null>
}

export function TranscriptView({ activeTextId, entries, isRunning, onScroll, onTryOperation, transcriptRef }: TranscriptViewProps) {
  const assistantText = latestAssistantText(entries)

  return (
    <div className="transcript" ref={transcriptRef} onScroll={onScroll} aria-busy={isRunning} role="log" aria-live="off">
      <span className="sr-only" aria-live="polite" aria-atomic="true">{isRunning ? '正在解答…' : assistantText ? `助手回复：${assistantText}` : '助手已就绪。'}</span>
      {entries.length === 0 && (
        <div className="empty-state">
          <span className="oversized-pi">π</span>
          <div>
            <h2>《我的世界》模组答疑助手。</h2>
            <p>这里是你的《我的世界》服务器答疑板：工业2（IC2）等模组的问题都可以直接提问，助手会结合真实项目源码来解答。</p>
            <Button className="empty-state-action" variant="ghost" onClick={onTryOperation}>试试问一个问题</Button>
          </div>
        </div>
      )}

      {entries.map((entry) => {
        return <TranscriptRow active={entry.id === activeTextId} entry={entry} isRunning={isRunning} key={entry.id} />
      })}
    </div>
  )
}

const TranscriptRow = memo(function TranscriptRow({ active, entry, isRunning }: {
  active: boolean
  entry: TranscriptEntry
  isRunning: boolean
}) {
  if (entry.type !== 'message') return <ActivityCard entry={entry} />

  return (
    <article className={`message message-${entry.role}`}>
      <div className="message-role">{entry.role === 'user' ? '你' : '助手'}</div>
      <div className="message-body">
        {entry.role === 'assistant' && entry.text ? entry.text.includes('```') ? (
          <Suspense fallback={<Streamdown>{entry.text}</Streamdown>}>
            <HighlightedMarkdown active={active}>{entry.text}</HighlightedMarkdown>
          </Suspense>
        ) : (
          <Streamdown caret={active ? 'block' : undefined} isAnimating={active}>{entry.text}</Streamdown>
        ) : entry.text || (isRunning && active ? <span className="cursor" /> : '')}
      </div>
    </article>
  )
})
