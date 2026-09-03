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
  // Catppuccin Mocha — 柔和暗色，高对比度
  mocha: { label: 'Catppuccin Mocha', palette: {
    accent: '#89b4fa', text: '#cdd6f4', subtext: '#7f849c',
    green: '#a6e3a1', yellow: '#f9e2af', cyan: '#89dceb', red: '#f38ba8',
  } },
  // Tokyo Night — 深蓝调，鲜艳亮色
  tokyonight: { label: 'Tokyo Night', palette: {
    accent: '#7aa2f7', text: '#c0caf5', subtext: '#737aa2',
    green: '#9ece6a', yellow: '#e0af68', cyan: '#7dcfff', red: '#f7768e',
  } },
  // Gruvbox Dark — 暖色复古，高辨识度
  gruvbox: { label: 'Gruvbox Dark', palette: {
    accent: '#fabd2f', text: '#ebdbb2', subtext: '#a89984',
    green: '#b8bb26', yellow: '#fe8019', cyan: '#8ec07c', red: '#fb4934',
  } },
  // Nord — 冷色调，低饱和度高级感
  nord: { label: 'Nord', palette: {
    accent: '#88c0d0', text: '#e5e9f0', subtext: '#616e88',
    green: '#a3be8c', yellow: '#ebcb8b', cyan: '#8fbcbb', red: '#bf616a',
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
export const palette: Palette = new Proxy({} as Palette, {
  get(_target, prop: string) {
    return getCurrentPalette()[prop as keyof Palette]
  },
})

export type BlockColor = string
