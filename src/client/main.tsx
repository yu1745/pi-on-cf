import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@cloudflare/kumo/components/tooltip'
import { appBranding } from '../config/app-branding'
import { App } from './app'
import { Router } from './router'
import '../styles.css'

/**
 * 客户端入口 —— 纯 SPA，无 SSR。
 * 直接挂载到 #root；HTML 外壳由静态 index.html 提供。
 */
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('找不到 #root 挂载点')

// 页面标题属于部署实例的业务身份（index.html 只留通用占位）。
document.title = appBranding.documentTitle

createRoot(rootEl).render(
  <StrictMode>
    <Router>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </Router>
  </StrictMode>,
)
