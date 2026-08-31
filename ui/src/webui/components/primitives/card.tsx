import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import styles from './card.module.css'

type IconType = React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

// Card — 可折叠卡片容器，统一 bg + border + radius。
// 替代 settings 的 SettingsCard/subCard 和 info-panel 的 CollapsibleSection。
interface CardProps {
  title: string
  desc?: string
  icon?: IconType
  defaultOpen?: boolean
  collapsible?: boolean
  children: React.ReactNode
}

export function Card({ title, desc, icon: Icon, defaultOpen = true, collapsible = true, children }: CardProps) {
  const [open, setOpen] = useState(defaultOpen)
  if (!collapsible) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          {Icon && <Icon size={16} strokeWidth={1.5} className={styles.cardIcon} />}
          <div className={styles.cardTitleArea}>
            <span className={styles.cardTitle}>{title}</span>
            {desc && <span className={styles.cardDesc}>{desc}</span>}
          </div>
        </div>
        <div className={styles.cardBody}>{children}</div>
      </div>
    )
  }
  return (
    <div className={styles.card}>
      <button className={styles.cardHeader} onClick={() => setOpen(!open)}>
        {Icon && <Icon size={16} strokeWidth={1.5} className={styles.cardIcon} />}
        <div className={styles.cardTitleArea}>
          <span className={styles.cardTitle}>{title}</span>
          {desc && <span className={styles.cardDesc}>{desc}</span>}
        </div>
        {open ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
      </button>
      {open && <div className={styles.cardBody}>{children}</div>}
    </div>
  )
}

// Section — 轻量可折叠 section（信息面板用，无卡片边框，只有分隔线）。
interface SectionProps {
  title: string
  icon?: IconType
  defaultOpen?: boolean
  children: React.ReactNode
}

export function Section({ title, icon: Icon, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={styles.section}>
      <button className={styles.sectionToggle} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
        {Icon && <Icon size={13} strokeWidth={1.5} />}
        <span>{title}</span>
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </section>
  )
}
