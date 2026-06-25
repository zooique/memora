/**
 * 技能文件安装器 — 校验 + 安装到 configDir/skills/
 *
 * 职责（Phase 4.3）：
 *   1. 校验技能文件格式（Markdown + YAML frontmatter）
 *   2. 校验 frontmatter 必填字段（name / keywords 或 trigger）
 *   3. 安全过滤（拒绝包含恶意内容的文件）
 *   4. 写入到 configDir/skills/ 目录
 *
 * 设计原则：
 *   - 纯函数校验：validateSkillFile 不依赖文件系统，便于单元测试
 *   - 安全优先：拒绝路径穿越、拒绝可执行脚本注入
 *   - 幂等安装：同名文件覆盖更新，不产生重复
 *
 * 集成点：
 *   - main.ts：IPC handler 调用 installSkill 写入文件
 *   - 渲染层：用户拖入 .md 文件后调用 installSkill
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { logger, parseFrontmatter } from 'memora';

/** 校验结果 */
export interface SkillValidationResult {
  /** 是否通过校验 */
  valid: boolean;
  /** 错误消息（valid=false 时有效） */
  error?: string;
  /** 解析出的技能名（valid=true 时有效） */
  skillName?: string;
}

/** 安装结果 */
export interface SkillInstallResult {
  /** 是否安装成功 */
  success: boolean;
  /** 错误消息（success=false 时有效） */
  error?: string;
  /** 安装路径（success=true 时有效） */
  installedPath?: string;
  /** 技能名（success=true 时有效） */
  skillName?: string;
}

/** 技能文件最大大小（64KB，防止超大文件拖入） */
const MAX_SKILL_FILE_SIZE = 64 * 1024;

/** 技能文件扩展名 */
const SKILL_FILE_EXTENSION = '.md';

/** 允许的文件名字符（字母、数字、连字符、下划线、点、空格、中文） */
const SAFE_FILENAME_PATTERN = /^[\w\u4e00-\u9fa5 \-.]+$/;

/**
 * 校验技能文件内容
 *
 * 纯函数，不依赖文件系统。校验规则：
 * 1. 必须包含 frontmatter（`---` 包围的 YAML 块）
 * 2. frontmatter 必须包含 name 字段（或从文件名推导）
 * 3. frontmatter 必须包含 keywords 或 trigger 字段（至少一个）
 * 4. body 不能为空
 * 5. 拒绝包含 `<script>` / `<iframe>` 等 HTML 标签（防注入）
 *
 * @param content 文件内容
 * @param fileName 文件名（可选，用于在 name 缺失时推导）
 * @returns 校验结果
 */
export function validateSkillFile(
  content: string,
  fileName?: string,
): SkillValidationResult {
  // 大小检查
  if (content.length > MAX_SKILL_FILE_SIZE) {
    return { valid: false, error: '文件过大（超过 64KB）' };
  }

  // 解析 frontmatter
  const { frontmatter, body } = parseFrontmatter(content);

  // 必须有 frontmatter
  if (Object.keys(frontmatter).length === 0) {
    return { valid: false, error: '缺少 frontmatter（--- 包围的 YAML 块）' };
  }

  // name 字段：frontmatter 优先，否则从文件名推导
  let skillName = frontmatter.name;
  if (!skillName) {
    if (fileName) {
      skillName = fileName.replace(/\.md$/i, '');
    } else {
      return { valid: false, error: 'frontmatter 缺少 name 字段，且无法从文件名推导' };
    }
  }

  // 必须有 keywords 或 trigger（至少一个触发条件）
  const hasKeywords = !!frontmatter.keywords;
  const hasTrigger = !!frontmatter.trigger;
  if (!hasKeywords && !hasTrigger) {
    return { valid: false, error: 'frontmatter 必须包含 keywords 或 trigger 字段' };
  }

  // body 不能为空
  if (!body.trim()) {
    return { valid: false, error: '技能 prompt 正文为空' };
  }

  // 安全检查：拒绝 HTML 标签注入（技能 prompt 是纯文本 + Markdown）
  if (/<script|<iframe|<object|<embed/i.test(body)) {
    return { valid: false, error: '正文包含不安全的 HTML 标签' };
  }

  return { valid: true, skillName };
}

/**
 * 安装技能文件到 configDir/skills/ 目录
 *
 * 流程：
 * 1. 校验文件内容
 * 2. 确保目标目录存在
 * 3. 写入文件（同名覆盖，幂等）
 *
 * @param content 文件内容
 * @param fileName 文件名（含扩展名）
 * @param configDir Agent 级配置目录
 * @returns 安装结果
 */
export async function installSkill(
  content: string,
  fileName: string,
  configDir: string,
): Promise<SkillInstallResult> {
  // 文件名安全校验
  if (!fileName || !SAFE_FILENAME_PATTERN.test(fileName)) {
    return { success: false, error: '文件名包含非法字符' };
  }

  if (!fileName.endsWith(SKILL_FILE_EXTENSION)) {
    return { success: false, error: '技能文件必须是 .md 格式' };
  }

  // 内容校验
  const validation = validateSkillFile(content, fileName);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // 路径穿越防护：确保最终路径在 configDir/skills/ 内
  const skillsDir = path.join(configDir, 'skills');
  const targetPath = path.join(skillsDir, fileName);
  const resolvedTarget = path.resolve(targetPath);
  const resolvedSkillsDir = path.resolve(skillsDir);
  if (!resolvedTarget.startsWith(resolvedSkillsDir + path.sep) && resolvedTarget !== resolvedSkillsDir) {
    return { success: false, error: '路径穿越攻击' };
  }

  try {
    // 确保目录存在
    await fs.mkdir(skillsDir, { recursive: true });

    // 写入文件（覆盖同名）
    await fs.writeFile(targetPath, content, 'utf-8');

    logger.info({ skillName: validation.skillName, targetPath }, '技能文件安装成功');

    return {
      success: true,
      installedPath: targetPath,
      skillName: validation.skillName,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ fileName, err: errMsg }, '技能文件安装失败');
    return { success: false, error: `写入文件失败：${errMsg}` };
  }
}
