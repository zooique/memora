/**
 * 角色模块类型定义
 */

/** 角色定义（从 personas/*.md frontmatter 解析） */
export interface Persona {
  /** 角色名（文件名去 .md） */
  name: string;
  /** 唯一 id（用于 SQLite 索引） */
  id: string;
  /** 角色描述（可选） */
  description?: string;
  /** 关键词（用于自动匹配切换） */
  keywords: string[];
  /** 人格正文（frontmatter 之后的 markdown 内容） */
  content: string;
  /** 来源路径 */
  filePath: string;
}

/** 角色激活模式 */
export type PersonaMode = 'auto' | 'manual';
