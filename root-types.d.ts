// 根级类型声明占位。Phase 2-3 期间 src/main、src/ui 被 tsconfig 排除（尚未迁移），
// 此文件让根 tsconfig 有输入不报空错。Phase 4 删除 src/ 后此文件保留作为根级 ambient 声明位。
export {}
