import React, { useState, useEffect } from 'react'
import { ChevronRight, FolderClosed, FolderUp, ArrowLeft, X } from 'lucide-react'
import { Button } from '../primitives'
import { ModalPortal } from '../modal-portal'
import styles from '../../app/app.module.css'

// 目录浏览器 Modal——通过 /api/fs 浏览目录，选择工作目录。
export function FsBrowserModal({ onConfirm, onClose }: { onConfirm: (path: string) => void; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [dirs, setDirs] = useState<string[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const [history, setHistory] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/fs').then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }, [])

  const browse = (path: string) => {
    setHistory((h) => [...h, current])
    fetch(`/api/fs?path=${encodeURIComponent(path)}`).then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }

  const goBack = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]!
    setHistory((h) => h.slice(0, -1))
    fetch(`/api/fs?path=${encodeURIComponent(prev)}`).then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }

  const breadcrumbs = current ? current.split(/[/\\]/).filter(Boolean) : []

  return (
    <ModalPortal onClose={onClose} label="Select Working Directory" className={styles.modal + ' modal-enter'}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>Select Working Directory</h2>
        <button className={styles.modalClose} onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
      </div>
      <div className={styles.fsBreadcrumb}>
        {history.length > 0 && (<button className={styles.fsBackBtn} onClick={goBack} aria-label="Go back"><ArrowLeft size={14} strokeWidth={1.5} /></button>)}
        {parent && (<button className={styles.fsCrumbUp} onClick={() => browse(parent)} title="Go up"><FolderUp size={14} strokeWidth={1.5} /></button>)}
        {breadcrumbs.map((seg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight size={10} strokeWidth={1.5} className={styles.fsCrumbSep} />}
            <span className={i === breadcrumbs.length - 1 ? styles.fsCrumbActive : styles.fsCrumbItem}>{seg}</span>
          </React.Fragment>
        ))}
      </div>
      <div className={styles.fsList}>
        {dirs.length === 0 ? (<p className={styles.fsEmpty}>No subdirectories</p>) : (
          dirs.map((d) => (<button key={d} className={styles.fsItem} onClick={() => browse(current + '/' + d)}><FolderClosed size={15} strokeWidth={1.5} className={styles.fsItemIcon} /><span>{d}</span></button>))
        )}
      </div>
      <div className={styles.fsManualRow}>
        <input className={styles.fsInput} value={manualPath} onChange={(e) => setManualPath(e.target.value)} placeholder="/path/to/project" onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(manualPath) }} />
      </div>
      <div className={styles.modalActions}>
        <Button variant="primary" onClick={() => onConfirm(manualPath)}>Select Directory</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </ModalPortal>
  )
}
