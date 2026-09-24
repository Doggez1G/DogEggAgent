import { spawn, type ChildProcess } from 'node:child_process'

// 杀进程树：按 OS 分，不按 shell 类型分。
// - win32 用 taskkill /T /F：杀整棵进程树（对 cmd/powershell/bash 通用）。
// - POSIX 用 process.kill(-pid, SIGKILL)：杀整个 detached 进程组。
// 取消三件套之一：cancel 时外层 AbortController 触发 abort，本函数杀 shell 子进程树。
export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // taskkill 不可达（ENOENT 等）不能崩掉 agent 进程：spawn 的 error 事件没有监听器
    // 会变成未捕获异常。杀树是尽力而为的兜底动作，spawn 失败就静默放弃（外层还有
    // 二级看门狗按已采集输出兜底收场，见 shell/tool.ts）。
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']).on('error', () => {})
  } else {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程已退出 */
      }
    }
  }
}
