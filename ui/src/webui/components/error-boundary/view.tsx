import React from 'react'
import styles from './error-boundary.module.css'

// ErrorBoundary：捕获子树渲染异常，显示错误兜底页而非白屏。
// 分区使用——某个区域崩溃只影响该区域，其他区域仍可用。
// 全局兜底 ErrorBoundary 放在 <App> 最外层。
interface ErrorBoundaryProps {
  children: React.ReactNode
  /** 区域名——显示在错误提示中（如 "Chat View"）。 */
  area?: string
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.area ?? 'ErrorBoundary'}]`, error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    const area = this.props.area ?? 'this section'
    return (
      <div className={styles.errorFallback}>
        <p className={styles.errorTitle}>{area} encountered an error</p>
        <p className={styles.errorMessage}>{this.state.error?.message ?? 'Unknown error'}</p>
        <button className={styles.retryBtn} onClick={() => this.setState({ hasError: false, error: null })}>
          Try again
        </button>
      </div>
    )
  }
}
