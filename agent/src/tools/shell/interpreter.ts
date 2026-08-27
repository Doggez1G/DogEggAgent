// shell 解释器解析：把配置里的 shellProgram（可缺省）映射成 spawn 需要的「程序 + 标志」。
// 设计文档要求解释器可配置（Windows 默认 cmd，可切 powershell/bash），
// 统一用 spawn(program, [flag, command]) 显式指定，而非 { shell: true } 让 Node 自选。

export interface ShellSpec {
  program: string
  flag: string
}

export function defaultShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  return platform === 'win32' ? { program: 'cmd', flag: '/c' } : { program: 'bash', flag: '-c' }
}

// 已知解释器映射到标准 flag；未知值回退为「程序名 + -c」，仍可显式执行。
// 防御：含非 ASCII 字符的值（如误保存的占位文本「（默认按平台）」）回退到平台默认。
export function resolveShell(program: string | undefined, platform: NodeJS.Platform = process.platform): ShellSpec {
  if (!program || !program.trim()) return defaultShell(platform)
  // 含非 ASCII（如中文占位文本）——视为非法，回退到平台默认。
  if (/[^\x00-\x7F]/.test(program)) return defaultShell(platform)
  switch (program.toLowerCase()) {
    case 'cmd': return { program: 'cmd', flag: '/c' }
    case 'powershell':
    case 'pwsh': return { program: 'powershell', flag: '-Command' }
    case 'bash': return { program: 'bash', flag: '-c' }
    case 'sh': return { program: 'sh', flag: '-c' }
    default: return { program, flag: '-c' }
  }
}