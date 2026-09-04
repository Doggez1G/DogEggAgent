// 主题调色板：多套可选主题，运行时可切换。
// surface 用于背景色块（用户消息横幅、输入框背景）——OpenCode 式设计的关键色。

export interface Palette {
  accent: string
  text: string
  subtext: string
  green: string
  yellow: string
  cyan: string
  red: string
  surface: string
}

export const THEMES: Record<string, { label: string; palette: Palette }> = {
  // Catppuccin Mocha — 默认主题
  mocha: { label: 'Catppuccin Mocha', palette: {
    accent: '#89b4fa', text: '#e6e9ef', subtext: '#9399b2',
    green: '#a6e3a1', yellow: '#f9e2af', cyan: '#89dceb', red: '#f38ba8',
    surface: '#313244',
  } },
  // Tokyo Night — 深蓝调
  tokyonight: { label: 'Tokyo Night', palette: {
    accent: '#7aa2f7', text: '#c8d3f5', subtext: '#828bb8',
    green: '#9ece6a', yellow: '#e0af68', cyan: '#7dcfff', red: '#f7768e',
    surface: '#24283b',
  } },
  // Gruvbox — 暖色复古
  gruvbox: { label: 'Gruvbox', palette: {
    accent: '#fe8019', text: '#ebdbb2', subtext: '#a89984',
    green: '#b8bb26', yellow: '#fabd2f', cyan: '#8ec07c', red: '#fb4934',
    surface: '#3c3836',
  } },
  // One Dark — Atom 风格
  onedark: { label: 'One Dark', palette: {
    accent: '#61afef', text: '#e6e6e6', subtext: '#9da5b4',
    green: '#98c379', yellow: '#e5c07b', cyan: '#56b6c2', red: '#e06c75',
    surface: '#2c313a',
  } },
  // DogEgg Warm — 品牌主题：蛋壳暖橙 + 暖白，默认色的活泼替代
  dogegg: { label: 'DogEgg Warm', palette: {
    accent: '#f5a97f', text: '#f2f4f5', subtext: '#a5adba',
    green: '#a6da95', yellow: '#f9e2af', cyan: '#8bd5ca', red: '#ee99a0',
    surface: '#3b3540',
  } },
}

export const DEFAULT_THEME = 'mocha'

let currentTheme = DEFAULT_THEME

export function getCurrentTheme(): string { return currentTheme }

export function getCurrentPalette(): Palette {
  return THEMES[currentTheme]?.palette ?? THEMES[DEFAULT_THEME]!.palette
}

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

export const palette: Palette = new Proxy({} as Palette, {
  get(_target, prop: string) {
    return getCurrentPalette()[prop as keyof Palette]
  },
})

export type BlockColor = string
