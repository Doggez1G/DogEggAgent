import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '../primitives'
import { ModalPortal } from '../modal-portal'
import styles from '../../app/app.module.css'

// 单行文本输入 Modal（prompt）——/rename 无参 / 命令面板执行时的会话重命名编辑框。
// 打开即全选预填值（直接输入即覆盖）；空值确认视为取消（不清空会话名）。
export function PromptModal({ title, value, placeholder, onConfirm, onClose }: {
  title: string
  value: string
  placeholder?: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [input, setInput] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开即聚焦 + 全选——重命名场景多数是「覆盖改名」。
  useEffect(() => { inputRef.current?.select() }, [])

  const confirm = (): void => {
    const trimmed = input.trim()
    if (!trimmed) { onClose(); return }
    onConfirm(trimmed)
  }

  return (
    <ModalPortal onClose={onClose} label={title} className={styles.modal + ' modal-enter'}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>{title}</h2>
        <button className={styles.modalClose} onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
      </div>
      <input
        ref={inputRef}
        className={styles.fsInput}
        value={input}
        placeholder={placeholder}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirm() }
        }}
      />
      <div className={styles.modalActions}>
        <Button variant="primary" onClick={confirm}>Confirm</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </ModalPortal>
  )
}
