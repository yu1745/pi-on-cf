import { useMemo } from 'react'
import { Link, useParams } from './router'
import { SessionCatalog } from '../features/sessions/session-catalog'
import { WorkspaceApp } from '../features/workspace/workspace-app'

/**
 * 应用根：根据当前路径决定渲染哪个页面。
 * 替代 TanStack Start 的文件式路由（routes/__root.tsx 等）。
 */
export function App() {
  const { sessionId } = useParams<{ sessionId?: string }>()

  return useMemo(() => {
    if (sessionId) {
      return <WorkspaceApp sessionId={sessionId} />
    }
    return <SessionCatalog />
  }, [sessionId])
}

/** 导出给 session-catalog 等组件复用（统一 import 源）。 */
export { Link }
