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
   * skillManager 写入（project 层扫描），精灵宿主通过 systemHandlers 读取
   * 并在 settingsPanelManager 中渲染"全局/项目"标签。
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
