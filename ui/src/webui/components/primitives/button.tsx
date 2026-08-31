import React from 'react'
import styles from './button.module.css'

type IconType = React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

// Button — 统一按钮组件，替代各组件手写的 btnPrimary/btnSecondary/btnDanger。
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'sm' | 'md'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: IconType
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, children, className, ...rest }: ButtonProps) {
  return (
    <button
      className={`${styles.btn} ${styles[variant]} ${styles[size]} ${className ?? ''}`}
      {...rest}
    >
      {Icon && <Icon size={size === 'sm' ? 13 : 14} strokeWidth={1.5} className={styles.btnIcon} />}
      {children}
    </button>
  )
}

// IconButton — 图标按钮，统一 32×32（或 28），替代各处手写的 iconBtn。
interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconType
  size?: number
}

export function IconButton({ icon: Icon, size = 32, className, ...rest }: IconButtonProps) {
  return (
    <button
      className={`${styles.iconBtn} ${className ?? ''}`}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon size={Math.floor(size * 0.55)} strokeWidth={1.5} />
    </button>
  )
}
