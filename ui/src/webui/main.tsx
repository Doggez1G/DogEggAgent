import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { createSseUiPort } from './channel'
import './styles/global.css'
import './theme/themes/catppuccin.css'
import './theme/themes/ios-light.css'
import './theme/themes/ios-dark.css'
import './theme/layouts/focus.css'
import './theme/layouts/workspace.css'
import './theme/layouts/zen.css'
import './theme/animations.css'

// WebUI 入口：创建 SSE UiPort，渲染 App。
// 与 TUI 的 renderTui(uiPort) 对称——唯一区别是传输方式（SSE vs in-memory）。
const port = createSseUiPort()
const root = document.getElementById('root')!
createRoot(root).render(
  <React.StrictMode>
    <App port={port} />
  </React.StrictMode>,
)
