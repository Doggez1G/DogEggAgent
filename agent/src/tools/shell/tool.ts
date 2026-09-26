import { spawn } from 'node:child_process'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { resolveShell } from './support/interpreter'
import { resolveShellPath } from './support/detect'
import { killTree } from './support/kill-tree'
import { shellSchema, shellParameters } from './schema'

// 单命令超时：交互式/常驻进程（游戏循环、dev server、缺输入的命令）不会自行退出，
// 没有超时会卡死整轮对话。超时后杀进程树，把已有输出 + 超时说明回填模型（模型可据此调整）。
const SHELL_TIMEOUT_MS = 120_000

// 采集上限立法：grep 有 1MB/文件防护，shell 采集侧同样必须有界——失控命令（cat 大文件、
// 死循环打印）不该把 agent 进程拖向 OOM。超限后停止累积、记录丢弃字节数，回执末尾可见
// （截断要有回执，对齐 grep 的截断说明先例）。
const SHELL_OUTPUT_CAP = 1024 * 1024

// 二级看门狗宽限：kill（超时/取消）后等待 close 的最长时间。杀树失败或逃逸守护进程持有
// stdio 管道时 close 永不触发，整轮对话会挂死——宽限一过按已采集输出强制收场。
// 立法：真实运行不需要可配（配置只会被误用去放宽挂死）；测试可经 setKillWatchdogForTest 调短。
const KILL_WATCHDOG_MS = 5_000
let killWatchdogMs = KILL_WATCHDOG_MS

// 测试专用：调短二级看门狗宽限（对齐 resetDetectCache 的测试缝隙先例），不落入用户配置。
export function setKillWatchdogForTest(ms: number): void {
  killWatchdogMs = ms
}

// 有界输出采集器：stdout/stderr 共用一份容量（回执是合并视图，分开封顶反而难解释）。
// 按 Buffer 块累积、close 时一次性 concat + utf8 解码——逐 chunk toString 会把跨 chunk
// 被切断的多字节字符解码成乱码（U+FFFD），Buffer 级拼接从根上避免。
class BoundedOutput {
  private chunks: Buffer[] = []
  private total = 0    // 已采集字节（两端流合计）
  private dropped = 0  // 超限后丢弃的字节数——回执里可见
  push(d: Buffer): void {
    if (this.total >= SHELL_OUTPUT_CAP) {
      this.dropped += d.length
      return
    }
    const room = SHELL_OUTPUT_CAP - this.total
    if (d.length > room) {
      this.chunks.push(d.subarray(0, room))
      this.total = SHELL_OUTPUT_CAP
      this.dropped += d.length - room
    } else {
      this.chunks.push(d)
      this.total += d.length
    }
  }

  // 终态文本：合并解码；发生过丢弃则在末尾追加可见说明（截断要有回执）。
  text(): string {
    const out = Buffer.concat(this.chunks).toString('utf8')
    return this.dropped > 0 ? `${out}\n[输出超过采集上限，已丢弃 ${this.dropped} 字节]` : out
  }
}

// shell 工具：执行 shell 命令，捕获 stdout/stderr 合并 + exit code。
// 解释器可配（ctx.shellProgram），缺省按平台（win: cmd /c，其它: bash -c）。
// 取消三件套之一：把 killTree 挂在 ctx.signal 的 abort 上，cancel 时杀进程树。
// detached（仅 POSIX）用于进程组 kill——kill(-pid) 需要子进程在独立进程组里。
// Windows 不设 detached（taskkill /T 杀子树不需要进程组），不用 shell:true（会触发 DEP0190 弃用警告）。
// spawn 形态按解释器分两支（P1-4）：win 的 cmd 分支用 verbatim 引号包裹形态（cmd.exe 的引号
// 规则与 MSVCRT 转义不兼容，见 execute 内立法注释）；powershell/pwsh/bash/sh 保持
// 「程序 + flag + 命令」数组形态——这些解释器把 flag 后的命令串当单个参数自行解析，
// 与 node 的参数转义兼容，无需特殊处理。
export class ShellTool implements Tool {
  readonly name = 'shell'
  readonly description = '执行 shell 命令，捕获 stdout/stderr 与 exit code'
  readonly schema = shellSchema
  readonly parameters = shellParameters

  execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command } = args as z.infer<typeof shellSchema>
    const spec = resolveShell(ctx.shellProgram)
    const isWin = process.platform === 'win32'
    const timeoutMs = ctx.shellTimeoutMs ?? SHELL_TIMEOUT_MS
    // 执行程序优先用绝对路径（P1-5 接线）：resolveShellPath 与 detectShells 走同一份扫描判定，
    // 保证「检测到的 shell」和「实际启动的 shell」是同一个文件。win32 上绝对路径 spawn 绕过
    // CreateProcess 的 System32-先于-PATH 搜索序——否则装了 WSL 的机器上裸名 bash 会被
    // System32 的 WSL 启动器截胡，与检测结果脱节（详见 detect.ts 头部立法）。
    // 解析不到（null）回退裸名：行为与旧版一致——Unix 上 bash.exe 命名扫描不到即属此列。
    const shellExe = resolveShellPath(spec.kind) ?? spec.program
    return new Promise((resolve) => {
      // stdio 立法（P2-14）：stdin 显式 'ignore'——旧实现用缺省 pipe 却从不写入、从不 end，
      // 读 stdin 的交互命令（缺参数的脚本、等待确认的 CLI）会一直等输入，挂满 120s 超时才被杀；
      // 'ignore' 让子进程 stdin 指向空设备，读立即得 EOF，交互命令按「无输入」自然失败。
      // stdout/stderr 保持 'pipe' 与下方 BoundedOutput 采集相接（缺省本就是 pipe，行为不变，
      // 显式写出是为了与 stdin 一起构成完整的管道声明，避免读者去查 spawn 缺省值）。
      //
      // P1-4 cmd 引号立法：cmd 分支禁止「裸名数组」形态（旧实现 spawn('cmd', ['/c', command])）。
      // 原因：数组形态下 node 按 MSVCRT 规则对每个参数做转义，命令串内嵌的 " 会被改写成 \"，
      // 而 cmd.exe 不认 \"（反斜杠对它是普通字符，引号转义只有 "" 一条路），含引号的命令因此
      // 被错拆——实测 `findstr /c:"hello world"` 在旧形态下报「Cannot open world\"」。
      // 改为与 node { shell: true } 内部实现完全一致的 verbatim 形态（但显式 spawn 而非
      // shell:true，避开 DEP0190 弃用警告），三个组成部分缺一不可：
      // - /d：跳过 AutoRun 注册表项——用户自定义的 cmd 启动脚本会污染输出甚至改写命令语义；
      // - /s：改变 cmd 对 /c 后字符串的引号剥离规则——仅当整个串首尾恰是一对引号时剥掉这一对，
      //   命令内部其余引号原样保留（与本包裹形态配套，引号体验对齐 bash -c）；
      // - 整体 "..." 包裹 + windowsVerbatimArguments: true：后者禁止 node 做 MSVCRT 参数转义，
      //   命令串逐字节原样到达 cmd.exe，再由外层引号 + /s 规则还原出原命令——没有 verbatim
      //   时包裹引号自身也会被转义破坏，两步必须同时存在。
      // ComSpec 是 Windows 自己记录的 cmd 真实位置（沙箱/精简镜像可能改写），缺省 cmd.exe。
      // PowerShell 与 bash 侧的引号由各自解释器处理（-Command / -c 取单参数），不需要本机制。
      const child =
        isWin && spec.kind === 'cmd'
          ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
              cwd: ctx.cwd,
              windowsVerbatimArguments: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : spawn(shellExe, [spec.flag, command], {
              cwd: ctx.cwd,
              detached: !isWin,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
      const output = new BoundedOutput()
      let timedOut = false
      let killed = false   // 是否已进入杀进程路径（决定是否需要二级看门狗兜底）
      let settled = false
      let watchdog: NodeJS.Timeout | undefined
      let timer: NodeJS.Timeout | undefined
      child.stdout?.on('data', (d) => output.push(d))
      child.stderr?.on('data', (d) => output.push(d))

      // 统一收场：三个完成路径（close / error / 二级看门狗）共用——幂等，先到者定胜负；
      // 且必须清掉两个 timer 与 abort 监听，避免迟到回调再做无谓的杀树。
      const finish = (r: ToolResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (watchdog) clearTimeout(watchdog)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(r)
      }

      // 杀进程 + 二级看门狗：kill 后 close 仍可能永不到达（taskkill 失败、逃逸守护进程持有
      // stdio 管道）——宽限期内 close 未到就销毁流、按已采集输出强制收场，防止整轮挂死。
      // 正常路径（close 先到）由 finish 清掉看门狗，行为完全不变。
      const kill = () => {
        killTree(child)
        if (killed) return
        killed = true
        watchdog = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish({ content: `${output.text()}\n[进程未正常退出，已按已有输出返回]` })
        }, killWatchdogMs)
        watchdog.unref() // 看门狗只是兜底：不阻止事件循环自然收尾（真实收场靠 close）
      }
      const onAbort = () => kill()
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      // 超时：杀进程树（close 事件仍会触发，走正常回填路径），把已有输出 + 超时说明回填模型。
      timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
      child.on('close', (code) => {
        finish({
          content: timedOut
            ? `exit=${code}（命令超过 ${Math.round(timeoutMs / 1000)}s 未结束，已终止进程树；如需长任务请放后台并轮询输出）\n${output.text()}`
            : `exit=${code}\n${output.text()}`,
        })
      })
      child.on('error', (e) => {
        finish({ error: String(e) })
      })
    })
  }
}
