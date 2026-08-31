import React from 'react'
import { Egg, PawPrint } from 'lucide-react'
import styles from './mark.module.css'

// 品牌标识：Egg + PawPrint 组合 mark + DogEgg wordmark。
// Mark：Lucide Egg 图标为主体，PawPrint 缩小叠在蛋右上区域——爪印戳在蛋上。
// Wordmark："DogEgg" 用 Space Grotesk（--font-display），统一字体，不再拆分高亮。
// Hover 微动效：paw 轻微弹跳，尊重 reduced-motion（animations.css 全局覆盖）。
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <div className={styles.mark} style={{ width: size, height: size }}>
      <Egg size={size} strokeWidth={1.5} className={styles.egg} />
      <PawPrint size={size * 0.35} strokeWidth={1.5} className={styles.paw} />
    </div>
  )
}

export function Wordmark() {
  return (
    <span className={styles.wordmark}>DogEgg</span>
  )
}

export function Brand({ size = 24 }: { size?: number }) {
  return (
    <div className={styles.brand}>
      <BrandMark size={size} />
      <Wordmark />
    </div>
  )
}
