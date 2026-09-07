import { DEFAULT_THEME, THEMES, type Palette } from './palette'

// 主题注册表：当前主题的唯一可变持有者（显式实例，替代旧模块级 let 单例）。
// onChange 订阅供两处消费：App（清屏 + Static 重挂载）、ThemeProvider（React 重渲染）。
export class ThemeRegistry {
  private current: string
  private listeners: (() => void)[] = []

  constructor(current: string = DEFAULT_THEME) {
    this.current = current
  }

  get name(): string {
    return this.current
  }

  get palette(): Palette {
    return THEMES[this.current]?.palette ?? THEMES[DEFAULT_THEME]!.palette
  }

  set(name: string): void {
    if (!THEMES[name] || name === this.current) return
    this.current = name
    this.listeners.forEach((cb) => cb())
  }

  onChange(cb: () => void): () => void {
    this.listeners.push(cb)
    return () => { this.listeners = this.listeners.filter((c) => c !== cb) }
  }

  list(): { name: string; label: string }[] {
    return Object.entries(THEMES).map(([name, t]) => ({ name, label: t.label }))
  }
}

// 应用级单例（显式命名实例——组合根与配置选择器直接引用它）。
export const themeRegistry = new ThemeRegistry()

// 兼容读取层：组件与纯函数（markdown 渲染）继续以 `palette.x` 取色，
// 读取时透传到 themeRegistry——可变状态已收归注册表，组件零改动。
export const palette: Palette = new Proxy({} as Palette, {
  get(_target, prop: string) {
    return themeRegistry.palette[prop as keyof Palette]
  },
})
