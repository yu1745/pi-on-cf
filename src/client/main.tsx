import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@cloudflare/kumo/components/tooltip'
import { App } from './app'
import { Router } from './router'
import '../styles.css'

/**
 * 客户端入口 —— 纯 SPA，无 SSR。
 * 直接挂载到 #root；HTML 外壳由静态 index.html 提供。
 */
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('找不到 #root 挂载点')

createRoot(rootEl).render(
  <StrictMode>
    <Router>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </Router>
  </StrictMode>,
)
