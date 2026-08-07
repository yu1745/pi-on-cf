import {
  createContext,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react'

/**
 * 轻量客户端路由 —— 替代 @tanstack/react-router。
 * 仅支持本项目用到的两个 URL 形状：
 *   - /                          会话列表
 *   - /sessions/:sessionId       工作区
 *
 * 暴露 TanStack Router 同名 API（Link / useNavigate / useParams），
 * 让现有组件几乎零改动迁移。
 */

interface RouteContextValue {
  path: string
  params: Record<string, string>
  navigate: (to: string) => void
}

const RouteContext = createContext<RouteContextValue>({
  path: '/',
  params: {},
  navigate: () => {},
})

/** 解析当前 URL 路径 + 路径参数。 */
function parseLocation(): { path: string; params: Record<string, string> } {
  const path = window.location.pathname || '/'
  const sessionMatch = path.match(/^\/sessions\/([^/]+)/)
  if (sessionMatch) {
    return { path, params: { sessionId: decodeURIComponent(sessionMatch[1]) } }
  }
  return { path, params: {} }
}

/** 路由根：监听 popstate / pushState，提供当前路径给子组件。 */
export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(parseLocation)

  useEffect(() => {
    const onPop = () => setLocation(parseLocation())
    window.addEventListener('popstate', onPop)
    // 拦截 history.pushState（见下方 navigate 实现）
    const onPush = () => setLocation(parseLocation())
    window.addEventListener('pi-navigate', onPush)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('pi-navigate', onPush)
    }
  }, [])

  const navigate = (to: string) => {
    if (to === window.location.pathname) return
    window.history.pushState({}, '', to)
    window.dispatchEvent(new Event('pi-navigate'))
    window.scrollTo(0, 0)
  }

  return (
    <RouteContext.Provider value={{ path: location.path, params: location.params, navigate }}>
      {children}
    </RouteContext.Provider>
  )
}

/** 读取当前路径参数（如 sessionId）。 */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const ctx = useContext(RouteContext)
  return ctx.params as T
}

/** 编程式跳转。签名兼容旧 TanStack 用法：navigate({ to, params })。 */
export function useNavigate() {
  const ctx = useContext(RouteContext)
  return (opts: { to: string; params?: Record<string, string> }) => {
    const to = resolveTo(opts.to, opts.params)
    ctx.navigate(to)
  }
}

/** 把 TanStack 的 `to="/sessions/$sessionId"` 模板解析成真实路径。 */
function resolveTo(template: string, params?: Record<string, string>): string {
  if (!params) return template
  let out = template
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`$${key}`, encodeURIComponent(value))
  }
  return out
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
  params?: Record<string, string>
  children?: ReactNode
}

/** 声明式跳转链接，签名兼容 TanStack <Link to params>。 */
export function Link({ to, params, children, onClick, ...rest }: LinkProps) {
  const ctx = useContext(RouteContext)
  const href = resolveTo(to, params)
  return (
    <a
      href={href}
      onClick={(event) => {
        // 允许修饰键正常打开新标签页
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        ctx.navigate(href)
        onClick?.(event)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
