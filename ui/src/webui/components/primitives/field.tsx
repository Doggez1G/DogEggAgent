import React, { useState } from 'react'
import { ChevronDown, Check, X } from 'lucide-react'
import styles from './field.module.css'

type IconType = React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

// Input — 统一文本输入框。
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
}

export function Input({ mono, className, ...rest }: InputProps) {
  return (
    <input className={`${styles.input} ${mono ? styles.mono : ''} ${className ?? ''}`} {...rest} />
  )
}

// Textarea — 多行文本输入。
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean
}

export function Textarea({ mono, className, ...rest }: TextareaProps) {
  return (
    <textarea className={`${styles.textarea} ${mono ? styles.mono : ''} ${className ?? ''}`} {...rest} />
  )
}

// SelectField — label + desc + select 下拉。
interface SelectFieldProps {
  label: string
  desc?: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}

export function SelectField({ label, desc, value, options, onChange }: SelectFieldProps) {
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldInfo}>
        <label className={styles.fieldLabel}>{label}</label>
        {desc && <span className={styles.fieldDesc}>{desc}</span>}
      </div>
      <div className={styles.selectWrap}>
        <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown size={12} strokeWidth={2} className={styles.selectArrow} />
      </div>
    </div>
  )
}

// EditableField — 点击显示当前值，点击进入编辑模式。
interface EditableFieldProps {
  label: string
  desc?: string
  value: string
  placeholder: string
  onSave: (v: string) => void
  mono?: boolean
  password?: boolean
}

export function EditableField({ label, desc, value, placeholder, onSave, mono, password }: EditableFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const display = password && value ? '••••••••' : (value || placeholder)
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldInfo}>
        <label className={styles.fieldLabel}>{label}</label>
        {desc && <span className={styles.fieldDesc}>{desc}</span>}
      </div>
      {editing ? (
        <div className={styles.inputGroup}>
          <input
            className={`${styles.input} ${mono ? styles.mono : ''}`}
            type={password ? 'password' : 'text'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onSave(draft); setEditing(false) }
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <button className={styles.iconSave} onClick={() => { onSave(draft); setEditing(false) }}><Check size={14} strokeWidth={2} /></button>
          <button className={styles.iconCancel} onClick={() => setEditing(false)}><X size={14} strokeWidth={2} /></button>
        </div>
      ) : (
        <button
          className={`${styles.valueBtn} ${mono ? styles.mono : ''}`}
          onClick={() => { setDraft(value); setEditing(true) }}
        >
          {display}
        </button>
      )}
    </div>
  )
}

// Toggle — 统一开关组件。
interface ToggleProps {
  on: boolean
  onChange: () => void
}

export function Toggle({ on, onChange }: ToggleProps) {
  return (
    <button
      className={`${styles.toggle} ${on ? styles.toggleOn : ''}`}
      onClick={onChange}
      role="switch"
      aria-checked={on}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

// Badge — 统一小标签。
type BadgeVariant = 'accent' | 'warning' | 'success' | 'danger' | 'neutral'

interface BadgeProps {
  variant?: BadgeVariant
  children: React.ReactNode
}

export function Badge({ variant = 'neutral', children }: BadgeProps) {
  return <span className={`${styles.badge} ${styles[`badge_${variant}`]}`}>{children}</span>
}

// Tooltip — CSS-only hover tooltip，aria-label 兜底。
interface TooltipProps {
  text: string
  children: React.ReactNode
}

export function Tooltip({ text, children }: TooltipProps) {
  return (
    <span className={styles.tooltipWrap}>
      {children}
      <span className={styles.tooltipText}>{text}</span>
    </span>
  )
}
