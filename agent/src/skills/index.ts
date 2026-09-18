// skills 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { SkillsManager, SKILL_NAME_RE, type SkillInfo } from './manager'
export { parseSkillMd, skeletonSkillMd } from './parser'
