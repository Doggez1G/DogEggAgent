// permission 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
// 三桶分类逻辑已下沉 bridge（classifyPermission）——schema 的唯一解释者在契约包。
export { PermissionManager } from './manager'
