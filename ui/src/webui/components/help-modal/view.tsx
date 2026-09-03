import React from 'react'
import { X } from 'lucide-react'
import { ModalPortal } from '../modal-portal'
import styles from '../../app/app.module.css'

// 帮助 Modal——斜杠命令列表 grid。
export function HelpModal({ onClose }: { onClose: () => void }) {
  const commands = [
    ['/new', 'New session'], ['/session', 'List sessions'], ['/config', 'Settings'],
    ['/model', 'Switch model'], ['/clear', 'Clear history'], ['/compact', 'Compact context'],
    ['/cd', 'Change directory'], ['/context', 'Context usage'], ['/tools', 'List tools'],
    ['/system', 'System prompt'], ['/status', 'Status'], ['/log', 'Debug log'],
    ['/permissions', 'Session permissions'], ['/help', 'This help'],
  ]
  return (
    <ModalPortal onClose={onClose} label="Commands" className={styles.modal + ' modal-enter'}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>Commands</h2>
        <button className={styles.modalClose} onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
      </div>
      <div className={styles.helpGrid}>
        {commands.map(([cmd, desc]) => (
          <React.Fragment key={cmd}>
            <code className={styles.helpCmd}>{cmd}</code>
            <span className={styles.helpDesc}>{desc}</span>
          </React.Fragment>
        ))}
      </div>
    </ModalPortal>
  )
}
