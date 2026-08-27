import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import type { Tool } from './types'
import { resolveShell } from '../common/utils/shell'

// 杀进程树：按 OS 分，不按 shell 类型分。win 用 taskkill /T，POSIX 用 detached 进程组信号。
function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  } else {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  }
}

const schema = z.object({ command: z.string() })

export const shellTool: Tool = {
  name: 'shell',
  description: '执行 shell 命令，捕获 stdout/stderr 与 exit code',
  schema,
  parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] },
  execute(args, ctx) {
    const { command } = args as z.infer<typeof schema>
    // 解释器可配：优先用配置的 shellProgram，缺省按平台（win: cmd /c，其它: bash -c）。
    const { program, flag } = resolveShell(ctx.shellProgram)
    return new Promise((resolve) => {
      const child = spawn(program, [flag, command], { cwd: ctx.cwd, detached: process.platform !== 'win32' })
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
  },
}