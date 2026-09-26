import { isAbsolute, resolve } from 'node:path'

// 工具目标路径解析——工具层与权限层共用的同一坐标系。
//
// 立法：一律走 resolve 而非 join。Windows 上 join(cwd, 绝对路径) 会产生变形路径
// （如 join('D:\\proj', 'C:\\Users\\a') → 'D:proj\\C:Usersa'，盘符冒号被吞），
// 而权限层历来按 resolve 归一——过去「分类看的是 A 文件、实际打开的是 B 乱码路径」。
// 绝对路径（含盘符、根路径）原样 resolve；相对路径基于 cwd resolve。
// 不做存在性检查与 cwd 边界限制——越界与否由权限引擎按真实位置判定（ADR-0010）。
export function resolveTargetPath(cwd: string, raw: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
}
