import { z } from 'zod'

// shell 工具参数 schema：单条命令字符串。解释器由配置决定，工具内不拆参数。
export const shellSchema = z.object({ command: z.string() })
