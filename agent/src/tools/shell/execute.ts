import { spawn } from 'node:child_process'
import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../types'
import { resolveShell } from './interpreter'
import { killTree } from './kill-tree'
import { shellSchema } from './schema'

// 执行 shell 命令，捕获 stdout/stderr 合并 + exit code。
// 解释器可配（ctx.shellProgram），缺省按平台（win: cmd /c，其它: bash -c）。
// 取消三件套之一：把 killTree 挂在 ctx.signal 的 abort 上，cancel 时杀进程树。
// detached（仅 POSIX）用于进程组 kill——kill(-pid) 需要子进程在独立进程组里。
// Windows 不设 detached（taskkill /T 杀子树不需要进程组），且 cmd/powershell 需 shell:true 避免 ENOENT。
export function shellExecute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { command } = args as z.infer<typeof shellSchema>
  const { program, flag } = resolveShell(ctx.shellProgram)
  const isWin = process.platform === 'win32'
  return new Promise((resolve) => {
    const child = spawn(program, [flag, command], {
      cwd: ctx.cwd,
      detached: !isWin,
      // Windows 上 cmd/powershell 用 shell:true 让 spawn 找到解释器（避免 ENOENT）。
      // POSIX 上 bash/sh 通常在 PATH 里，不需要 shell:true。
      shell: isWin,
    })
    let out = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { out += d })
    const onAbort = () => killTree(child)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve({ content: `exit=${code}\n${out}` })
    })
    child.on('error', (e) => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve({ error: String(e) })
    })
  })
}
