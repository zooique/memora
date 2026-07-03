/**
 * 技能模块类型定义
 */

/** 技能条目（从 skills/*.md 解析） */
export interface SkillEntry {
  /** 技能名（文件名去 .md） */
  name: string;
  /** 触发关键词列表 */
  keywords: string[];
  /** 触发正则（可选，优先级高于 keywords） */
  trigger?: RegExp;
  /** 技能描述（可选） */
  description?: string;
  /** 技能 prompt 正文 */
  content: string;
  /** 来源路径 */
  filePath: string;
  /**
   * 来源层（agent / project）
   *
   * L-03：预留字段，当前仅写入无读取消费者（skillManager + configManager 标注来源层）。
   * 保留用于未来"按层禁用"（如宿主临时屏蔽 project 层技能）或"UI 显示来源"场景。
   * 保留在 SkillEntry 契约中以维持类型稳定（同 R-03 判例）。
   */
  layer: 'agent' | 'project';
}

/** 技能匹配结果 */
export interface SkillMatch {
  /** 匹配的技能 */
  skill: SkillEntry;
  /** 匹配得分（0-1，用于排序） */
  score: number;
}
