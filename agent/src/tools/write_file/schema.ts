import { z } from 'zod'

// write_file 工具参数 schema：文件路径 + 完整内容（整文件覆写）。
export const writeFileSchema = z.object({ path: z.string(), content: z.string() })
