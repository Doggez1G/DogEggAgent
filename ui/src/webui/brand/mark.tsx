import React from 'react'
import { Egg, PawPrint } from 'lucide-react'
import styles from './mark.module.css'

// 品牌标识：Egg + PawPrint 组合 mark + DoggEgg wordmark。
// Mark：Lucide Egg 图标为主体，PawPrint 缩小叠在蛋右上区域——爪印戳在蛋上。
// Wordmark："DoggEgg" 用 Space Grotesk，两个 gg（Dogg 的尾 gg + Egg 的首 gg）用 accent 色高亮。
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <div className={styles.mark} style={{ width: size, height: size }}>
      <Egg size={size} strokeWidth={1.5} className={styles.egg} />
      <PawPrint size={size * 0.4} strokeWidth={1.5} className={styles.paw} />
    </div>
  )
}

export function Wordmark() {
  return (
    <span className={styles.wordmark} style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
      <span>Dog</span>
      <span className={styles.highlight}>gg</span>
      <span>E</span>
      <span className={styles.highlight}>gg</span>
    </span>
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
