/**
 * 技能模块类型定义 — 三级渐进披露
 *
 * L1 元数据：name + description（必填，渐进披露唯一激活依据）→ 常驻 system prompt（B1 对齐主流：仅两字段）
 * L2 正文：content（SKILL.md 全文）→ read_skill 按需加载
 * L3 资源/脚本：resources + references + scripts → read_resource / run_skill_script 按需调用
 */

import type { ResourceSubdir } from '@/utils/scanner.js';

/** L3 资源条目（resources/ 或 references/ 目录下的参考文件） */
export interface SkillResource {
  /** 资源相对路径（相对技能目录根，如 "resources/api-spec.md"） */
  path: string;
  /** 资源描述（可选，供 L1 清单提示） */
  description?: string;
  /** 文件大小（字节），用于判断是否需要分块读取 */
  size?: number;
  /**
   * 资源来源子目录（resources / references）。
   * references/ 为 TRAE / Agent Skills 主流辅助文档目录（B1 兼容），read_resource 据此选择读取基目录。
   * 取值 SSOT 在 `utils/scanner`（目录名常量派生），此处只引用类型不重复字面量。
   */
  subdir?: ResourceSubdir;
}

/** L3 脚本条目（scripts/ 目录下的可执行脚本） */
export interface SkillScript {
  /** 脚本相对路径（相对技能目录根，如 "scripts/lint.ts"） */
  path: string;
  /** 运行时 */
  runtime: 'node' | 'python' | 'shell';
  /** 脚本描述（可选） */
  description?: string;
  /** 执行超时（秒，默认 30） */
  timeout?: number;
}

/** L3 层数据（资源 + 脚本，可选） */
export interface SkillLayer3 {
  /** 资源列表 */
  resources: SkillResource[];
  /** 脚本列表 */
  scripts: SkillScript[];
}

/** 技能条目（从 skills/*.md 或 skills/<dir>/SKILL.md 解析） */
export interface SkillEntry {
  /** 技能名（文件名去 .md，或目录名） */
  name: string;
  /** 技能描述（可选） */
  description?: string;
  /** 技能 prompt 正文（L2 内容） */
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
  /**
   * L3 层数据（资源 + 脚本，可选）
   *
   * 当技能目录包含 resources/ 或 scripts/ 时自动填充。
   * 三级渐进披露：L3 内容不进 system prompt，由 read_resource / run_skill_script 按需调用。
   */
  layer3?: SkillLayer3;
}

/** 技能校验单条问题（G22 写→验→用闭环，2026-08-25） */
export interface SkillIssue {
  /** 级别：error=不可生效 / warning=可加载但变弱 */
  level: 'error' | 'warning';
  /** 问题归属字段（frontmatter/description/layer/body/file） */
  field?: string;
  /** 人类可读问题描述（说明影响，供 UI 错误定位） */
  message: string;
}

/** 技能校验结果（单一入口 validateFile 返回；UI 据此叠加健康徽章 + 错误定位） */
export interface SkillValidation {
  /** 是否可用（无 error 即 true；warning 不阻断） */
  ok: boolean;
  /** 问题清单（error + warning） */
  issues: SkillIssue[];
}
