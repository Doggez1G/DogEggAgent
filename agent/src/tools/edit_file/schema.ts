import { z } from 'zod'

// edit_file 工具参数 schema：路径 + 要替换的原文 + 新片段。code agent 的核心工具。
export const editFileSchema = z.object({ path: z.string(), old_string: z.string(), new_string: z.string() })
