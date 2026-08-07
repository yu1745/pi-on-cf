import { vi } from 'vitest'

class ResizeObserverStub implements ResizeObserver {
  disconnect = vi.fn()
  observe = vi.fn()
  unobserve = vi.fn()
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)

// jsdom 不实现 matchMedia; ThemeToggle 等组件依赖它。
// 直接定义到 window 上 (vi.stubGlobal 对 window.* 属性不可靠)。
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle))
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
