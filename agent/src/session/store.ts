import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Message } from '@dogegg/bridge'

// 会话快照：R1 双持久化的完整会话数据。
// history = 完整原文（永不压缩，给 UI 显示）；context = 发给模型的消息（会压缩）。
// allowedTools = 会话级 allow_always 授权工具列表（resume 时恢复，实现跨会话切换保留授权）。
// cwd = 创建会话时的工作目录（resume 时恢复，实现项目→会话切换恢复目录）。
// thinking = 推理模型的思考内容数组（resume 时恢复思考块显示，不进 history/context）。
export interface SessionSnapshot {
  id: string
  history: Message[]
  context: Message[]
  allowedTools: string[]
  cwd: string
  thinking: { text: string }[]
}

// 会话列表项：preview 取 history 末条非 tool 消息的前 40 字符。
export interface SessionSummary {
  id: string
  updatedAt: string
  preview: string
  cwd: string
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
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify({
      id: snapshot.id,
      updatedAt: new Date().toISOString(),
      history: snapshot.history,
      context: snapshot.context,
      allowedTools: snapshot.allowedTools,
      cwd: snapshot.cwd,
      thinking: snapshot.thinking,
    }))
    renameSync(tmp, target)
  }

  load(id: string): SessionSnapshot {
    const raw = JSON.parse(readFileSync(this.file(id), 'utf8'))
    // 兼容旧格式（只有 messages）：若无 history/context 字段，回退用 messages。
    const history: Message[] = raw.history ?? raw.messages ?? []
    const context: Message[] = raw.context ?? [...history]
    const allowedTools: string[] = raw.allowedTools ?? []
    const cwd: string = raw.cwd ?? ''
    const thinking: { text: string }[] = raw.thinking ?? []
    return { id: raw.id ?? id, history, context, allowedTools, cwd, thinking }
  }

  // 删除会话文件。文件不存在时静默成功（幂等）。
  delete(id: string): void {
    const target = this.file(id)
    if (existsSync(target)) unlinkSync(target)
  }

  // 会话列表 + preview + cwd，按 updatedAt 降序排序（最新在最前，方便查找）。
  // preview 取 history（完整原文）最后一条非 tool 消息——
  // 用 history 而非 context，因为 history 是用户可见的完整历史，preview 要反映用户真实对话。
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
          const last: Message | undefined = history[history.length - 1]
          const preview = last && last.role !== 'tool' && typeof last.content === 'string' ? last.content.slice(0, 40) : ''
          const cwd: string = raw.cwd ?? ''
          return { id: raw.id ?? f.replace('.json', ''), updatedAt: raw.updatedAt ?? '', preview, cwd }
        } catch {
          return { id: f.replace('.json', ''), updatedAt: '', preview: '（文件损坏）', cwd: '' }
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) // 降序：最新在前
  }

  private file(id: string): string {
    return join(this.baseDir, `${id}.json`)
  }
}
