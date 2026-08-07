import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

type Mode = 'light' | 'dark'

const STORAGE_KEY = 'pi-theme'

/** 读取初始主题：localStorage → 系统偏好 → 默认 light。 */
function getInitialMode(): Mode {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  // 首次访问跟随系统偏好
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 主题切换按钮 —— 在亮色 / 暗色之间切换。
 *
 * 实际的 `data-mode` 属性由 index.html 里的内联脚本在 React 加载前
 * 设置（避免首屏闪白）；这里只负责同步状态 + 提供切换入口。
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(getInitialMode)

  useEffect(() => {
    document.documentElement.dataset.mode = mode
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  const next = mode === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`切换到${next === 'dark' ? '夜间' : '日间'}模式`}
      title={`切换到${next === 'dark' ? '夜间' : '日间'}模式`}
      onClick={() => setMode(next)}
    >
      {mode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
