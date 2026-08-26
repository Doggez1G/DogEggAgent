import type { Tool } from './types'
import { readFileTool } from './read_file'
import { writeFileTool } from './write_file'
import { editFileTool } from './edit_file'
import { shellTool } from './shell'

const tools: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool]

export function getAllTools(): Tool[] {
  return tools
}

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}

// 组装为 OpenAI `tools` 参数：每个工具一个 { type: 'function', function: {...} }。
export function toolSchemas(): object[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}