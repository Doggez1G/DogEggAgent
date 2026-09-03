// 主题调色板：多套可选主题，运行时可切换。
// 每个 palette 保持相同结构（accent/text/subtext/green/yellow/cyan/red）。

export interface Palette {
  accent: string
  text: string
  subtext: string
  green: string
  yellow: string
  cyan: string
  red: string
}

// 主题列表：name → Palette。
export const THEMES: Record<string, { label: string; palette: Palette }> = {
  mocha: { label: 'Catppuccin Mocha', palette: {
    accent: '#89b4fa', text: '#cdd6f4', subtext: '#6c7086',
    green: '#a6e3a1', yellow: '#f9e2af', cyan: '#94e2d5', red: '#f38ba8',
  } },
  tokyonight: { label: 'Tokyo Night', palette: {
    accent: '#7aa2f7', text: '#c0caf5', subtext: '#565f89',
    green: '#9ece6a', yellow: '#e0af68', cyan: '#7dcfff', red: '#f7768e',
  } },
  gruvbox: { label: 'Gruvbox Dark', palette: {
    accent: '#83a598', text: '#ebdbb2', subtext: '#928374',
    green: '#b8bb26', yellow: '#fabd2f', cyan: '#8ec07c', red: '#fb4934',
  } },
  dracula: { label: 'Dracula', palette: {
    accent: '#bd93f9', text: '#f8f8f2', subtext: '#6272a4',
    green: '#50fa7b', yellow: '#f1fa8c', cyan: '#8be9fd', red: '#ff5555',
  } },
}

export const DEFAULT_THEME = 'mocha'

// 当前主题名——模块级可变状态。
let currentTheme = DEFAULT_THEME

export function getCurrentTheme(): string {
  return currentTheme
}

export function getCurrentPalette(): Palette {
  return THEMES[currentTheme]?.palette ?? THEMES[DEFAULT_THEME]!.palette
}

// 主题切换回调——注册后切换主题时触发（用于触发 React 重渲染）。
let themeChangeCallbacks: (() => void)[] = []

export function onThemeChange(cb: () => void): () => void {
  themeChangeCallbacks.push(cb)
  return () => { themeChangeCallbacks = themeChangeCallbacks.filter((c) => c !== cb) }
}

export function setTheme(name: string): void {
  if (!THEMES[name] || name === currentTheme) return
  currentTheme = name
  themeChangeCallbacks.forEach((cb) => cb())
}

// palette 保持为对象（向后兼容），但属性通过 getter 动态读取当前主题。
// 这样 `import { palette }` 的旧代码无需修改即可跟随主题切换。
export const palette: Palette = new Proxy({} as Palette, {
  get(_target, prop: string) {
    return getCurrentPalette()[prop as keyof Palette]
  },
})

export type BlockColor = string
