import { Button } from '../primitives'
import styles from '../../app/app.module.css'

// 权限确认条——在输入框上方内联呈现，与对话区一体。
export function PermissionBanner({ tool, input, alwaysScope, onDecision }: {
  tool: string
  input: unknown
  alwaysScope?: { pattern: string }
  onDecision: (d: 'allow_once' | 'allow_always' | 'allow_always_scoped' | 'reject') => void
}) {
  const inp = input as Record<string, unknown> | null
  const filePath = inp ? String(inp.path ?? inp.command ?? '') : ''
  return (
    <div className={styles.permissionBanner + ' block-enter'}>
      <div className={styles.permissionHeader}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" className={styles.permissionShield}>
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
          <Button size="sm" variant="secondary" onClick={() => onDecision('allow_always_scoped')} title={'Always allow: ' + alwaysScope.pattern}>
            Always Allow: {alwaysScope.pattern}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => onDecision('allow_always')}>Always Allow (tool)</Button>
        <Button size="sm" variant="danger" onClick={() => onDecision('reject')}>Reject</Button>
      </div>
    </div>
  )
}
