import { X } from 'lucide-react'
import { Button } from '../primitives'
import { ModalPortal } from '../modal-portal'
import styles from '../../app/app.module.css'

// 确认 Modal——危险操作确认。
export function ConfirmModal({ title, message, onConfirm, onClose }: { title: string; message: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <ModalPortal onClose={onClose} label={title} className={styles.modal + ' modal-enter'}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>{title}</h2>
        <button className={styles.modalClose} onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
      </div>
      <p className={styles.modalMessage}>{message}</p>
      <div className={styles.modalActions}>
        <Button variant="primary" onClick={onConfirm}>Confirm</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </ModalPortal>
  )
}
