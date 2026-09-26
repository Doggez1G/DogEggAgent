import { useEffect, useRef } from 'react'
import { Button } from '../primitives'
import styles from '../../app/app.module.css'

// 权限确认条——在输入框上方内联呈现，与对话区一体。
// P2-36 a11y 立法：挂起期间必须可被读屏/键盘感知与操作——
// 1) role="alert" + aria-live="assertive"：permission_request 到达时读屏立即播报横幅内容
//    （role=alert 本身隐含 assertive live region，显式写出以防实现差异）；
// 2) 挂起即聚焦横幅内首个按钮（Allow Once）——键盘用户不用 Tab 逐个寻址；
// 3) Escape → 拒绝：与 TUI 的 esc=reject 语义对齐（tui/features/permission/keys.ts:
//    escape → permission_decision { decision: 'reject' }）；
// 4) scoped 按钮的完整 pattern 可能是长 shell 前缀——CSS ellipsis + title 悬停看全。
export function PermissionBanner({ tool, input, alwaysScope, onDecision }: {
  tool: string
  input: unknown
  alwaysScope?: { pattern: string }
  onDecision: (d: 'allow_once' | 'allow_always' | 'allow_always_scoped' | 'reject') => void
}) {
  const inp = input as Record<string, unknown> | null
  const filePath = inp ? String(inp.path ?? inp.command ?? '') : ''
  const bannerRef = useRef<HTMLDivElement>(null)

  // 挂起即聚焦首个按钮（Allow Once）——键盘/读屏用户落点直接在决策区。
  // 决策提交后横幅卸载、焦点回到 body；此处不强行归还焦点（归还目标——输入框——
  // 在 isRunning 期间是 disabled 态，聚焦无意义）。
  useEffect(() => {
    bannerRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [])

  // Escape → 拒绝（与 TUI esc=reject 对齐）。守卫：若有 modal（role=dialog）打开，
  // Escape 优先归 modal 的关闭链路（ModalPortal 的 document 级监听），此时不据此拒绝——
  // 否则用户在设置弹窗里按 Esc 关窗会连带把挂起中的工具审批拒掉。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[role="dialog"]')) return
      onDecision('reject')
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onDecision])

  return (
    <div ref={bannerRef} className={styles.permissionBanner + ' block-enter'} role="alert" aria-live="assertive">
      <div className={styles.permissionHeader}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={styles.permissionShield}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <span className={styles.permissionTool}>{tool}</span>
        {filePath && <span className={styles.permissionFile}>{filePath.split(/[/\\]/).pop()}</span>}
        <span className={styles.permissionHint}>wants to execute — approve?</span>
      </div>
      {tool === 'edit_file' && inp && (
        <div className={styles.permissionDiffWrap}>
          <span className={`${styles.permissionDiffLine} ${styles.permissionDiffDel}`}>- {String(inp.old_string ?? '').slice(0, 150)}</span>
          <span className={`${styles.permissionDiffLine} ${styles.permissionDiffAdd}`}>+ {String(inp.new_string ?? '').slice(0, 150)}</span>
        </div>
      )}
      {tool === 'write_file' && inp && (
        <div className={styles.permissionDiffWrap}>
          <span className={`${styles.permissionDiffLine} ${styles.permissionDiffAdd}`}>+ {String(inp.content ?? '').slice(0, 150)}</span>
        </div>
      )}
      {tool === 'shell' && inp && (
        <div className={styles.permissionDiffWrap}>
          <code className={styles.permissionShellCmd}>{String(inp.command ?? '')}</code>
        </div>
      )}
      <div className={styles.permissionActions}>
        <Button size="sm" variant="primary" onClick={() => onDecision('allow_once')}>Allow Once</Button>
        {alwaysScope && (
          // scoped 按钮内嵌完整 pattern（shell 前缀可能很长）会撑宽横幅——按钮限宽收缩、
          // 标签单行 ellipsis，全名走 title 悬停；title 注明 shell 作用域语义（前缀匹配含命令链）。
          <Button
            size="sm"
            variant="secondary"
            className={styles.permissionScopedBtn}
            onClick={() => onDecision('allow_always_scoped')}
            title={`Always allow: ${alwaysScope.pattern} — shell 范围含该前缀的一切命令（含命令链）`}
          >
            <span className={styles.permissionScopedLabel}>Always Allow: {alwaysScope.pattern}</span>
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => onDecision('allow_always')}>Always Allow (tool)</Button>
        <Button size="sm" variant="danger" onClick={() => onDecision('reject')}>Reject</Button>
      </div>
    </div>
  )
}
