/**
 * skill/ 模块入口
 *
 * 技能管理层 — 记忆管道最高优先级
 * 职责：两层目录扫描 + 关键词匹配 + prompt 注入
 */
export { SkillManager } from './skillManager.js';
export type { SkillEntry, SkillMatch } from './skillManager.js';
