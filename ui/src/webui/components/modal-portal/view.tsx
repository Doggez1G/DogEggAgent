import React, { useEffect, useRef } from 'react'
import styles from './modal-portal.module.css'

// 通用 Modal 容器：封装 role=dialog + aria-modal + focus trap + Escape 关闭。
// 所有 modal 用这个组件包裹，统一无障碍行为。
// scrim 点击是否关闭由 prop 控制——设置 modal 不响应 scrim 点击外部关闭时传 closeOnScrim=false。
interface ModalPortalProps {
  children: React.ReactNode
  onClose?: () => void
  closeOnScrim?: boolean // 默认 true：点击遮罩关闭。设置 false 时不关闭（如 Settings modal）。
  label?: string // aria-label
  className?: string
}

export function ModalPortal({ children, onClose, closeOnScrim = true, label, className }: ModalPortalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // 首次聚焦 modal 内第一个可聚焦元素；同时记录打开前聚焦的元素——关闭（卸载）时归还焦点，
  // 键盘/读屏用户不会被丢到 body，焦点回到聊天输入框或触发按钮等原位置。
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const el = dialogRef.current
    if (!el) return
    const focusable = el.querySelector<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')
    focusable?.focus()
    return () => {
      // 归还前提：元素仍在文档中（已被移除的旧节点 focus() 无效且无意义）。
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  // focus trap：Tab 在 modal 内循环。
  useEffect(() => {
    if (!onClose) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'Tab') {
        const el = dialogRef.current
        if (!el) return
        const focusables = el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className={styles.scrim} onClick={closeOnScrim ? onClose : undefined}>
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
