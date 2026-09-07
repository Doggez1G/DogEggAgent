// 配置树编辑器的导航路径：表示「当前钻取到哪一层」。
export type ConfigPath =
  | { kind: 'root' }
  | { kind: 'permission' }
  | { kind: 'permissionBucket'; bucket: 'allow' | 'reject' | 'ask' }
  | { kind: 'providers' }
  | { kind: 'provider'; index: number }
  | { kind: 'models'; providerIndex: number }
  | { kind: 'model'; providerIndex: number; modelIndex: number }
  | { kind: 'selectProvider' }
  | { kind: 'selectModel' }
  | { kind: 'selectShell' }
  | { kind: 'selectTheme' }
  | { kind: 'selectTool'; bucket: 'allow' | 'reject' | 'ask' }

// 返回当前路径的父层；根层返回 null（再往上即关闭编辑器）。
export function parentPath(path: ConfigPath): ConfigPath | null {
  switch (path.kind) {
    case 'root': return null
    case 'permission': return { kind: 'root' }
    case 'permissionBucket': return { kind: 'permission' }
    case 'providers': case 'selectProvider': case 'selectModel': case 'selectShell': case 'selectTheme': return { kind: 'root' }
    case 'selectTool': return { kind: 'permissionBucket', bucket: path.bucket }
    case 'provider': return { kind: 'providers' }
    case 'models': return { kind: 'provider', index: path.providerIndex }
    case 'model': return { kind: 'models', providerIndex: path.providerIndex }
  }
}
