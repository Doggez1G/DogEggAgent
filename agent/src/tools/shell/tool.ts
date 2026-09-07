import { spawn } from 'node:child_process'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { resolveShell } from './support/interpreter'
import { killTree } from './support/kill-tree'
import { shellSchema, shellParameters } from './schema'

// 单命令超时：交互式/常驻进程（游戏循环、dev server、缺输入的命令）不会自行退出，
// 没有超时会卡死整轮对话。超时后杀进程树，把已有输出 + 超时说明回填模型（模型可据此调整）。
const SHELL_TIMEOUT_MS = 120_000

// shell 工具：执行 shell 命令，捕获 stdout/stderr 合并 + exit code。
// 解释器可配（ctx.shellProgram），缺省按平台（win: cmd /c，其它: bash -c）。
// 取消三件套之一：把 killTree 挂在 ctx.signal 的 abort 上，cancel 时杀进程树。
// detached（仅 POSIX）用于进程组 kill——kill(-pid) 需要子进程在独立进程组里。
// Windows 不设 detached（taskkill /T 杀子树不需要进程组），不用 shell:true（会触发 DEP0190 弃用警告）。
export class ShellTool implements Tool {
  readonly name = 'shell'
  readonly description = '执行 shell 命令，捕获 stdout/stderr 与 exit code'
  readonly schema = shellSchema
  readonly parameters = shellParameters

  execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command } = args as z.infer<typeof shellSchema>
    const { program, flag } = resolveShell(ctx.shellProgram)
    const isWin = process.platform === 'win32'
    const timeoutMs = ctx.shellTimeoutMs ?? SHELL_TIMEOUT_MS
    return new Promise((resolve) => {
      const child = spawn(program, [flag, command], {
        cwd: ctx.cwd,
        detached: !isWin,
      })
      let out = ''
      let timedOut = false
      child.stdout?.on('data', (d) => { out += d })
      child.stderr?.on('data', (d) => { out += d })
      const kill = () => killTree(child)
      const onAbort = () => kill()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      // 超时：杀进程树（close 事件仍会触发，走正常回填路径），把已有输出 + 超时说明回填模型。
      const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve({
          content: timedOut
            ? `exit=${code}（命令超过 ${Math.round(timeoutMs / 1000)}s 未结束，已终止进程树；如需长任务请放后台并轮询输出）\n${out}`
            : `exit=${code}\n${out}`,
        })
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve({ error: String(e) })
      })
    })
  }
}
