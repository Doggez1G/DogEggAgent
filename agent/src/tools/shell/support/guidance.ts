import type { ShellSpec } from './interpreter'

// 模型可见的 shell 环境引导（系统提示注入段）：把「实际执行命令的解释器 + 语法要点」
// 前置告诉模型——模型训练分布偏向 Unix/bash，不注入则只能按 bash 猜，Windows 上
// cmd / PowerShell 的语法差异（无 grep、5.1 无 && 、变量 %VAR%）就是失败的主因。
// 每类解释器一段保守、可执行的要点（宁少勿错——只列确定性高的事实）。

export function shellGuidance(spec: ShellSpec, platform: NodeJS.Platform = process.platform): string {
  const platformLine = platform === 'win32' ? '平台：Windows' : `平台：${platform}`
  const perKind: Record<string, string[]> = {
    cmd: [
      'shell 命令通过 cmd.exe 执行——请使用 cmd 语法：',
      '- 没有 ls/grep/cat/rm/export/which 等 Unix 命令（对应 dir / findstr / type / rmdir / set）',
      '- 环境变量用 %VAR%（不是 $VAR）；路径正斜杠与反斜杠一般均可',
      '- 复杂逻辑请拆分成多条命令，或改用 node -e "…" 执行脚本',
    ],
    powershell: [
      'shell 命令通过 Windows PowerShell 5.1 执行——注意：',
      '- 不支持 && 与 || 链接符（用分号分隔命令，或用 if ($?) { … } 判断上一条成功）',
      '- 常用别名部分可用（ls、cat、rm），grep/which 不可用（用 Select-String / Get-Command）',
      '- 变量 $x = 值；向原生命令传含空格参数时注意引号重组',
    ],
    pwsh: [
      'shell 命令通过 PowerShell 7 执行——支持 && 与 || 链接符；',
      '- 常用别名部分可用（ls、cat、rm），grep/which 不可用（用 Select-String / Get-Command）',
    ],
    bash: ['shell 命令通过 bash 执行（标准 POSIX 语法）；注意 Windows 下部分 Unix 工具与路径行为有差异。'],
    sh: ['shell 命令通过 sh 执行（标准 POSIX 语法）；注意 Windows 下部分 Unix 工具与路径行为有差异。'],
  }
  const lines = perKind[spec.kind] ?? ['shell 命令通过未知解释器执行——先运行一次探测命令确认语法。']
  return [
    '',
    '## Shell 环境',
    `${platformLine}；命令在会话工作目录执行；当前 shell 为 ${spec.kind}（${spec.program} ${spec.flag}）。`,
    ...lines,
  ].join('\n')
}
