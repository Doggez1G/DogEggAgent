import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// 本机可用 shell 扫描（立法：配置只在扫描结果中选择，扫描不到的不允许配置生效）。
// 检测方式：PATH 扫描（比逐个 spawn 探测快且确定）；cmd 在 Windows 上视为必然可用（System32）。
// powershell.exe = Windows PowerShell 5.1；pwsh.exe = PowerShell 7+——两者语法能力不同，
// 必须区分为两个 kind（5.1 不支持 && ||，7 支持）。
//
// P1-5 bash 身份消歧立法：Windows 的 CreateProcess 对「裸名」spawn 按固定搜索序解析
// （应用目录 → System32 → … → PATH 各目录），System32 恒先于 PATH——装了 WSL 的机器上
// System32\bash.exe（WSL 启动器）会压过 PATH 上的 Git Bash。而本模块的 PATH 扫描只能看到
// PATH 上的命中，若只扫不消歧，「检测说有 Git Bash、执行起来却是 WSL bash」两套坐标必然脱节
// （WSL bash 对 Windows 路径的挂载点是 /mnt/c/...，模型按 Git Bash 习惯写路径必失败）。
// 判据：win32 上 PATH 扫描命中的 bash 落点在名为 System32 的目录下（大小写不敏感）→ 判为
// WSL 启动器，从检测结果剔除 bash，resolveShellPath('bash') 同步返回 null。Git Bash 从不装
// 在 System32（其安装目录是 <Git>\bin 或 <Git>\usr\bin），此判据不会误伤 Git Bash。
// 消歧后 bash 候选可能一个不剩（没装 Git Bash、只装了 WSL）——detectShells 不含 bash 即
// 配置不可选 bash，行为正确（fail-closed：消歧只在「身份存疑」时收窄可用面，不放宽）。

export type ShellKind = 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh'

const EXE_NAME: Record<ShellKind, string> = {
  cmd: 'cmd.exe',
  powershell: 'powershell.exe',
  pwsh: 'pwsh.exe',
  bash: 'bash.exe',
  sh: 'sh',
}

// PATH 扫描：EXE_NAME 自带扩展名（powershell.exe 等），PATHEXT 是补充而非替代——
// 先按裸名找，再按 PATHEXT 补扩展名找。若只做「exe+ext」拼接，检查的会是
// powershell.exe.EXE（永不存在），powershell/pwsh/bash 在 Windows 上恒扫描不到。
// Unix 下 exts=['']，等价于只按裸名找（行为不变）。
// 返回命中的绝对路径（而非布尔）：调用方拿绝对路径 spawn 可绕过 CreateProcess 的
// System32-先于-PATH 搜索序，是 bash 身份消歧落地的执行侧前提（见 detectShells 立法）。
function findOnPath(exe: string, platform: NodeJS.Platform): string | null {
  const dirs = (process.env.PATH ?? '').split(platform === 'win32' ? ';' : ':')
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const dir of dirs) {
    if (!dir) continue
    const base = dir.trim()
    if (existsSync(join(base, exe))) return join(base, exe)
    for (const ext of exts) {
      if (!ext) continue // 裸名已查过；空扩展名（含 PATHEXT 尾分号产生的空段）无需重复
      if (existsSync(join(base, exe + ext))) return join(base, exe + ext)
    }
  }
  return null
}

// WSL 启动器判据：命中目录（末段，大小写不敏感）为 System32。同一目录名判据同时约束
// detectShells 与 resolveShellPath，保证「检测结果」与「执行路径解析」永远同一口径。
// 测试可造同名临时目录触发（写真实 System32 需要管理员，用例不必也无权）。
function isWslBashLauncher(hit: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  return basename(dirname(hit)).toLowerCase() === 'system32'
}

// kind → 绝对路径的单 kind 扫描（detectShells 与 resolveShellPath 共用的同一份判定）：
// - cmd：Windows 基线解释器，不参与 PATH 扫描（System32 恒在）——直接给 System32 绝对路径，
//   与 detectShells 的基线立法同源；SystemRoot/windir 均缺失（理论上不会）返回 null，调用方
//   回退裸名/ComSpec。Unix 上 cmd 无意义，恒 null。
// - 其余 kind：PATH 扫描命中即返回绝对路径；bash 命中 System32（WSL 启动器）→ null（见头部立法）。
function scanShellPath(kind: ShellKind, platform: NodeJS.Platform): string | null {
  if (kind === 'cmd') {
    if (platform !== 'win32') return null
    const root = process.env.SystemRoot ?? process.env.windir
    return root ? join(root, 'System32', 'cmd.exe') : null
  }
  const hit = findOnPath(EXE_NAME[kind], platform)
  if (!hit) return null
  if (kind === 'bash' && isWslBashLauncher(hit, platform)) return null
  return hit
}

let cached: ShellKind[] | null = null
const pathCache = new Map<ShellKind, string | null>()

// 扫描本机可用 shell（结果缓存——运行期不变）。对外 API 保持返回 ShellKind[]，调用方不受
// findOnPath 返回值升级影响；System32 bash（WSL 启动器）在此被剔除（判据见文件头立法）。
export function detectShells(platform: NodeJS.Platform = process.platform): ShellKind[] {
  if (cached) return cached
  if (platform === 'win32') {
    // cmd 是 Windows 的基线解释器（System32 恒在）；其余按 PATH 扫描。
    cached = (['cmd', 'powershell', 'pwsh', 'bash'] as ShellKind[]).filter((k) => k === 'cmd' || scanShellPath(k, platform) !== null)
  } else {
    // Unix：sh 视为基线；bash 按 PATH 扫描。
    cached = (['bash', 'sh'] as ShellKind[]).filter((k) => k === 'sh' || scanShellPath(k, platform) !== null)
  }
  return cached
}

// 解析 kind 的可执行文件绝对路径（缓存——运行期不变），供 spawn 使用：绝对路径 spawn 绕过
// CreateProcess 的「System32 先于 PATH」搜索序，执行侧与 detectShells 的扫描结果对齐
//（否则装了 WSL 的机器上 spawn('bash') 会启动 System32 的 WSL bash，而检测认为可用的是
// PATH 上的 Git Bash——两套解析序必然脱节，见文件头立法）。
// 返回 null 的情形：本机扫描不到该 kind（含 bash 被 WSL 消歧剔除、Unix 上请求 cmd）——
// 调用方应回退裸名（kind 不在 detectShells 结果内时本就不该被选中）。
export function resolveShellPath(kind: ShellKind, platform: NodeJS.Platform = process.platform): string | null {
  const hit = pathCache.get(kind)
  if (hit !== undefined) return hit
  const resolved = scanShellPath(kind, platform)
  pathCache.set(kind, resolved)
  return resolved
}

// 测试专用：重置扫描缓存（注入受控的 PATH 前调用）。两份缓存一并清——kind 列表与路径
// 解析都依赖 PATH，只清其一会让两组结果互相矛盾。
export function resetDetectCache(): void {
  cached = null
  pathCache.clear()
}
