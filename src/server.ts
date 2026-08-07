import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { PI_AGENT_PREFIX } from './shared/pi-contract'

export { PiSession } from './server/pi-session'
export { PiRegistry } from './server/pi-registry'

/**
 * Worker 默认导出 —— 纯 API 网关（无 SSR）。
 *
 * wrangler.jsonc 配置：
 *   assets.run_worker_first = ["/api/*"]   仅 /api/* 进 Worker
 *   assets.not_found_handling = "single-page-application"  其余走静态资源 + SPA 回退
 *
 * 所以前端代码（React + shiki 等）作为静态资源部署，
 * 不计入 Worker 3MB bundle 上限 —— 这正是去掉 SSR 的目的。
 */
export default {
  async fetch(request: Request): Promise<Response> {
    // agents SDK 路由：把 /api/agents/* 导向对应的 Durable Object
    const agentResponse = await routeAgentRequest(request, env, { prefix: PI_AGENT_PREFIX })
    if (agentResponse) return agentResponse

    // run_worker_first 只放行 /api/*，理论上不会走到这里；
    // 真走到说明是 /api 下的非 agents 请求，返回 404。
    return new Response('Not Found', { status: 404 })
  },
}
