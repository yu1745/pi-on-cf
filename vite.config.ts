import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import agents from 'agents/vite'

/**
 * 纯 SPA 配置 —— 无 SSR。
 *
 * 两个构建产物：
 *   1. dist/client/  前端 SPA（index.html + JS/CSS），作为 Static Assets
 *   2. dist/server/  Worker 代码（src/server.ts），仅含 API 逻辑
 *
 * 关键：前端代码（含 shiki 等重依赖）只进 dist/client，
 * 不计入 Worker 3MB bundle 上限。
 */
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  plugins: [
    agents(),
    cloudflare(),
    tailwindcss(),
    viteReact(),
  ],
  build: {
    // 前端入口：index.html → /src/client/main.tsx
    rollupOptions: {
      input: 'index.html',
    },
  },
})
