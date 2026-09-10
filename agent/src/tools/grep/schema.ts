import { z } from 'zod'

// grep 工具参数 schema。
export const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
})

// 暴露给 LLM 的 OpenAI JSON schema。
export const grepParameters = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '正则表达式（逐行匹配）' },
    path: { type: 'string', description: '可选：搜索起点（文件或目录，相对工作目录），缺省为工作目录根' },
    glob: { type: 'string', description: '可选：只搜文件名匹配此 glob 的文件，如 *.ts' },
    case_insensitive: { type: 'boolean', description: '可选：忽略大小写' },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description: '可选：content=命中行（缺省）；files_with_matches=只列命中文件；count=每文件命中数。先粗后细：大搜索先用 files_with_matches 锁定文件再精搜',
    },
  },
  required: ['pattern'],
}
