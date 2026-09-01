import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ErrorBoundary } from './components'
import { createSseUiPort, type ConnectionState } from './channel'
import './styles/global.css'
import './theme/themes/midnight.css'
import './theme/themes/forest.css'
import './theme/themes/dawn.css'
import './theme/animations.css'

// WebUI 入口：创建 SSE UiPort，渲染 App。
// 与 TUI 的 renderTui(uiPort) 对称——唯一区别是传输方式（SSE vs in-memory）。
// 全局 ErrorBoundary 包裹 App，防止未捕获的渲染异常导致白屏。
// 连接状态通过回调传给 App，App 在顶栏显示指示器 + 首次断连时 toast。
function Root() {
  const [connState, setConnState] = useState<ConnectionState>('reconnecting')
  const [port] = useState(() => createSseUiPort(setConnState))
  return <App port={port} connectionState={connState} />
}

const root = document.getElementById('root')!
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary area="DogEggAgent">
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
)
