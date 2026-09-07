// 主题调色板——纯数据（可变状态归 ThemeRegistry，见 registry.ts）：
//   surface    层次1背景：user 横幅、输入框、状态徽章
//   surfaceAlt 层次2背景：thinking/tool 卡片（与 surface 色相区分，形成层次）
//   border     框线（Banner 等容器边框，比 subtext 暗一档，细腻不吵）
//   faint      最弱文字（分隔线、时间戳、翻页提示）
//   purple     思考色（五色状态系统：accent/green/cyan/purple/red）
// 每套主题有独立的色相倾向——surface/surfaceAlt 带主题色调而非纯灰。

export interface Palette {
  accent: string
  text: string
  subtext: string
  faint: string
  green: string
  yellow: string
  cyan: string
  red: string
  purple: string
  surface: string
  surfaceAlt: string
  border: string
}

export const THEMES: Record<string, { label: string; palette: Palette }> = {
  // Catppuccin Mocha — 柔和蓝紫夜色（默认）
  mocha: { label: '🌌 Catppuccin Mocha', palette: {
    accent: '#89b4fa', text: '#e6e9ef', subtext: '#9399b2', faint: '#6c7086',
    green: '#a6e3a1', yellow: '#f9e2af', cyan: '#89dceb', red: '#f38ba8', purple: '#cba6f7',
    surface: '#2b2d42', surfaceAlt: '#3a3d5c', border: '#4a4d6a',
  } },
  // Tokyo Night — 深蓝夜空，冷冽蓝调
  tokyonight: { label: '🌃 Tokyo Night', palette: {
    accent: '#7aa2f7', text: '#c8d3f5', subtext: '#828bb8', faint: '#565f89',
    green: '#9ece6a', yellow: '#e0af68', cyan: '#7dcfff', red: '#f7768e', purple: '#bb9af7',
    surface: '#262c48', surfaceAlt: '#343b5e', border: '#41486b',
  } },
  // Gruvbox — 复古暖棕，高饱和暖色
  gruvbox: { label: '🍂 Gruvbox', palette: {
    accent: '#fe8019', text: '#ebdbb2', subtext: '#a89984', faint: '#7c6f64',
    green: '#b8bb26', yellow: '#fabd2f', cyan: '#8ec07c', red: '#fb4934', purple: '#d3869b',
    surface: '#453f39', surfaceAlt: '#574f45', border: '#6e6457',
  } },
  // One Dark — Atom 经典蓝灰
  onedark: { label: '🌆 One Dark', palette: {
    accent: '#61afef', text: '#e6e6e6', subtext: '#9da5b4', faint: '#5c6370',
    green: '#98c379', yellow: '#e5c07b', cyan: '#56b6c2', red: '#e06c75', purple: '#c678dd',
    surface: '#2f3440', surfaceAlt: '#3d4452', border: '#4c566a',
  } },
  // DogEgg Warm — 品牌主题：蛋壳暖橙 + 梅紫
  dogegg: { label: '🐶🥚 DogEgg Warm', palette: {
    accent: '#f5a97f', text: '#f2f4f5', subtext: '#a5adba', faint: '#7a7f8c',
    green: '#a6da95', yellow: '#f9e2af', cyan: '#8bd5ca', red: '#ee99a0', purple: '#f5bde6',
    surface: '#3f3849', surfaceAlt: '#4f455c', border: '#615472',
  } },
}

export const DEFAULT_THEME = 'mocha'

export type BlockColor = string
