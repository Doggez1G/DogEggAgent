import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Message, ToolPermission } from '@dogegg/bridge'

// 会话快照：R1 双持久化的完整会话数据。
// history = 完整原文（永不压缩，给 UI 显示）；context = 发给模型的消息（会压缩）。
// sessionPermissions = 会话内权限提升（按工具分组：patterns 空 = 整工具，非空 = 范围模式；
// resume 时恢复）。旧格式的 allowedTools（纯工具名数组）不再读取——旧会话的提升视为空。
// usage = 会话累计真实用量（prompt/completion tokens + 轮次数，resume 续计）；compactions = 累计压缩次数。
// cwd = 创建会话时的工作目录（resume 时恢复，实现项目→会话切换恢复目录）。
// thinking = 推理模型的思考内容数组（resume 时恢复思考块显示，不进 history/context）。
export interface SessionSnapshot {
  id: string
  history: Message[]
  context: Message[]
  sessionPermissions: ToolPermission[]
  usage: { promptTokens: number; completionTokens: number; turns: number }
  compactions: number
  /** 会话标题（/rename 手动命名或首轮后自动生成）；缺省时列表展示 preview。 */
  title?: string
  cwd: string
  thinking: { text: string }[]
}

// 会话列表项：preview 取 history 末条非 tool 消息的前 40 字符。
export interface SessionSummary {
  id: string
  updatedAt: string
  preview: string
  cwd: string
  title?: string
}

export function defaultSessionsDir(): string {
  return join(homedir(), '.dogegg', 'sessions')
}

// JSON 会话持久化。baseDir 可注入（测试传临时目录），运行时默认 ~/.dogegg/sessions。
// 写入为原子写（tmp + rename），避免半写文件损坏会话。
export class SessionStore {
  constructor(private readonly baseDir: string = defaultSessionsDir()) {}

  save(snapshot: SessionSnapshot): void {
    mkdirSync(this.baseDir, { recursive: true })
    const target = this.file(snapshot.id)
    // tmp 名含 pid 与随机后缀（立法同 shared/atomic.ts）：固定 target + '.tmp' 在双进程
    // 并发写同一会话时互踩（A 写完 B 覆盖，各自 rename 后内容张冠李戴）。后缀含随机段，
    // 同进程内的重入写也不会撞名；后缀在 .json 之后——list() 的 .endsWith('.json') 过滤
    // 天然不会把残留 tmp 当会话文件列出。
    const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify({
      id: snapshot.id,
      updatedAt: new Date().toISOString(),
      history: snapshot.history,
      context: snapshot.context,
      sessionPermissions: snapshot.sessionPermissions,
      usage: snapshot.usage,
      compactions: snapshot.compactions,
      cwd: snapshot.cwd,
      thinking: snapshot.thinking,
      ...(snapshot.title ? { title: snapshot.title } : {}),
    }))
    renameSync(tmp, target)
  }

  load(id: string): SessionSnapshot {
    const raw = JSON.parse(readFileSync(this.file(id), 'utf8'))
    // 兼容旧格式（只有 messages）：若无 history/context 字段，回退用 messages。
    const history: Message[] = raw.history ?? raw.messages ?? []
    const context: Message[] = raw.context ?? [...history]
    // 旧格式的 allowedTools 不再读取——旧会话的提升视为空（重新询问一次即可）。
    const sessionPermissions: ToolPermission[] = raw.sessionPermissions ?? []
    const usage = raw.usage ?? { promptTokens: 0, completionTokens: 0, turns: 0 }
    const compactions: number = raw.compactions ?? 0
    const title: string | undefined = typeof raw.title === 'string' ? raw.title : undefined
    const cwd: string = raw.cwd ?? ''
    const thinking: { text: string }[] = raw.thinking ?? []
    return { id: raw.id ?? id, history, context, sessionPermissions, usage, compactions, title, cwd, thinking }
  }

  // 删除会话文件。文件不存在时静默成功（幂等）。
  delete(id: string): void {
    const target = this.file(id)
    if (existsSync(target)) unlinkSync(target)
  }

  // 会话列表 + preview + cwd，按 updatedAt 降序排序（最新在最前，方便查找）。
  // preview 取 history（完整原文）最后一条非 tool 且 content 非空字符串的消息（从尾部向前找）——
  // 用 history 而非 context，因为 history 是用户可见的完整历史，preview 要反映用户真实对话。
  // 从尾部向前扫而非只看末条：轮次收尾时 history 常以 tool 消息结尾（工具任务刚结束），
  // 只看末条会得到空 preview，侧栏全是无摘要条目。
  // cwd 用于前端按项目（工作目录）分组会话。
  list(): SessionSummary[] {
    if (!existsSync(this.baseDir)) return []
    return readdirSync(this.baseDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        // 单个文件损坏不阻断整个列表——跳过并返回占位项。
        try {
          const raw = JSON.parse(readFileSync(join(this.baseDir, f), 'utf8'))
          const history: Message[] = raw.history ?? raw.messages ?? []
          let preview = ''
          for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i]!
            if (m.role !== 'tool' && typeof m.content === 'string' && m.content.length > 0) {
              preview = m.content.slice(0, 40)
              break
            }
          }
          const cwd: string = raw.cwd ?? ''
          const title: string | undefined = typeof raw.title === 'string' ? raw.title : undefined
          return { id: raw.id ?? f.replace('.json', ''), updatedAt: raw.updatedAt ?? '', preview, cwd, title }
        } catch {
          return { id: f.replace('.json', ''), updatedAt: '', preview: '（文件损坏）', cwd: '' }
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) // 降序：最新在前
  }

  // id 直接拼进文件名——调用方（SessionManager 的 resume / deleteSession）必须在入口先过
  // 白名单 /^[A-Za-z0-9._-]+$/（防 `../../` 路径穿越读/删目录外任意 json）。本类不再重复校验，
  // 但任何新的直调入口都必须沿用同一白名单（立法位置见 session/manager.ts 文件头）。
  private file(id: string): string {
    return join(this.baseDir, `${id}.json`)
  }
}
