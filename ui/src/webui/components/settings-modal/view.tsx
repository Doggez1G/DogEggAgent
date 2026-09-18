import { X } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { ModalPortal } from '../modal-portal'
import { Settings } from '../settings'
import styles from '../../app/app.module.css'

// 设置 Modal——IDE 风格左导航 + 右内容区。closeOnScrim=false：只能用关闭按钮关闭。
export function SettingsModal({ config, port, onClose, initialSection }: { config: Config | null; port: UiPort; onClose: () => void; initialSection?: 'skills' | 'mcp' }) {
  return (
    <ModalPortal onClose={onClose} closeOnScrim={false} label="Settings" className={styles.settingsModal + ' modal-enter'}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>Settings</h2>
        <button className={styles.modalClose} onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
      </div>
      <div className={styles.settingsModalBody}>
        <Settings config={config} port={port} onClose={onClose} initialSection={initialSection} />
      </div>
    </ModalPortal>
  )
}
