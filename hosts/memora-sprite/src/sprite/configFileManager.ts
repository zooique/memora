/**
 * 设定文件管理器 — persona/rule/skill 三类文件的统一 CRUD
 *
 * 职责（精灵设定面板 Epic 2 · H1-H3）：
 *   1. 提供 persona/rule/skill 三类 Markdown 文件的读/写/删/列表能力
 *   2. 纯函数校验 validateConfigFile：每种 type 不同 frontmatter 校验规则
 *   3. 路径统一为 configDir/{personas,rules,skills}/ 为真理源（H3）
 *   4. 安全防护：文件名白名单 + 路径穿越防护 + 内容大小上限
 *
 * 设计原则（参考 skillInstaller.ts 模式）：
 *   - 纯函数校验：validateConfigFile 不依赖文件系统，便于单元测试
 *   - 副作用函数：read/save/delete/list 依赖 node:fs，写入 configDir 子目录
 *   - 幂等操作：save 同名文件覆盖更新；delete 不存在的文件返回 success=false
 *   - 不操作 SQLite/内存缓存：本模块只管文件层，SQLite + Manager 内存同步
 *     由调用方（Sprite wrapper）联动 ConfigManager/PersonaManager/SkillManager 处理
 *
 * 与 skillInstaller.ts 的关系：
 *   - skill 类型的校验复用 skillInstaller.validateSkillFile（避免重复造轮子）
 *   - skill 类型的新增/更新通过本模块的 saveConfigFile 统一入口
 *   - 拖入安装（skillInstaller.installSkill）保留独立通道，本模块不替代
 *
 * 集成点：
 *   - Sprite 类：持有 configFileManager 方法引用，包装为 sprite.readConfigFile 等
 *   - configHandlers.ts：IPC handler 调用 sprite.readConfigFile 等
 *   - personaWatcher / 未来 rulesWatcher / skillsWatcher：文件变化后触发 CONFIG_FILES_CHANGED 广播
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { logger, parseFrontmatter, toError } from 'memora';
import { isValidConfigName } from '../shared/inputValidation.js';
import { validateSkillFile } from './skillInstaller.js';

// ─── 类型定义 ────────────────────────────────────────────────

/**
 * 设定文件类型
 *
 * 三类对应 configDir 下的三个子目录：
 *   - persona → configDir/personas/{name}.md
 *   - rule → configDir/rules/{name}.md
 *   - skill → configDir/skills/{name}.md
 *
 * guardrail 不在此枚举中——guardrail 是只读展示，文件 CRUD 由用户手动管理。
 */
export type ConfigFileType = 'persona' | 'rule' | 'skill';

/**
 * 设定文件条目（列表/读取返回结构）
 */
export interface ConfigFileEntry {
  /** 配置名（frontmatter.name 优先，回退文件名去扩展名） */
  name: string;
  /** 文件名（含 .md 扩展名） */
  fileName: string;
  /** 文件绝对路径 */
  filePath: string;
  /** 文件内容（含 frontmatter + body，仅在 readConfigFile 时填充；listConfigFiles 返回空字符串） */
  content: string;
  /** 文件大小（字节） */
  size: number;
  /** 最后修改时间（ms epoch） */
  mtime: number;
}

/**
 * 校验结果
 */
export interface ConfigValidationResult {
  /** 是否通过校验 */
  valid: boolean;
  /** 错误消息（valid=false 时有效） */
  error?: string;
  /** 解析出的配置名（valid=true 时有效，frontmatter.name 优先，回退文件名去扩展名） */
  configName?: string;
}

/**
 * 文件操作结果（save/delete 通用）
 */
export interface ConfigFileOperationResult {
  /** 是否操作成功 */
  success: boolean;
  /** 错误消息（success=false 时有效） */
  error?: string;
  /** 文件路径（success=true 时有效） */
  filePath?: string;
}

// ─── 常量 ────────────────────────────────────────────────────

/** 设定文件最大大小（64KB，与 skillInstaller 对齐） */
const MAX_CONFIG_FILE_SIZE = 64 * 1024;

/** 设定文件扩展名 */
const CONFIG_FILE_EXTENSION = '.md';

/**
 * 类型 → 子目录映射
 *
 * 单一真理源：所有调用方通过此映射获取子目录名，
 * 避免散落的字符串拼接（如 'personas' / 'rules' / 'skills'）。
 */
const TYPE_TO_SUBDIR: Record<ConfigFileType, string> = {
  persona: 'personas',
  rule: 'rules',
  skill: 'skills',
};

// ─── 纯函数校验 ────────────────────────────────────────────

/**
 * 校验设定文件内容
 *
 * 纯函数，不依赖文件系统。每种 type 的校验规则：
 *
 * persona：
 *   1. 必须包含 frontmatter
 *   2. frontmatter 必须有 name 字段（或从文件名推导）
 *   3. frontmatter 必须有 keywords 字段（关键词匹配激活，逗号分隔）
 *   4. body 不能为空
 *
 * rule：
 *   1. 必须包含 frontmatter
 *   2. frontmatter 必须有 name 字段（或从文件名推导）
 *   3. body 不能为空（rule 正文即注入 system prompt 的内容）
 *   4. 不强制要求 keywords——rule 是常驻 bootstrap，不靠关键词匹配
 *
 * skill：
 *   复用 skillInstaller.validateSkillFile（已有 keywords/trigger 校验，避免重复实现）
 *
 * @param content 文件内容（含 frontmatter + body）
 * @param fileName 文件名（含 .md 扩展名，用于 name 缺失时推导）
 * @param type 配置类型
 * @returns 校验结果
 */
export function validateConfigFile(
  content: string,
  fileName: string,
  type: ConfigFileType,
): ConfigValidationResult {
  // 大小检查
  if (content.length > MAX_CONFIG_FILE_SIZE) {
    return { valid: false, error: '文件过大（超过 64KB）' };
  }

  // skill 类型复用 skillInstaller 校验逻辑
  if (type === 'skill') {
    const skillResult = validateSkillFile(content, fileName);
    return {
      valid: skillResult.valid,
      error: skillResult.error,
      configName: skillResult.skillName,
    };
  }

  // 解析 frontmatter
  const { frontmatter, body } = parseFrontmatter(content);

  // 必须有 frontmatter
  if (Object.keys(frontmatter).length === 0) {
    return { valid: false, error: '缺少 frontmatter（--- 包围的 YAML 块）' };
  }

  // name 字段：frontmatter 优先，否则从文件名推导
  let configName = frontmatter.name;
  if (!configName) {
    if (fileName) {
      configName = fileName.replace(/\.md$/i, '');
    } else {
      return { valid: false, error: 'frontmatter 缺少 name 字段，且无法从文件名推导' };
    }
  }

  // persona 类型必须有 keywords（关键词匹配激活）
  if (type === 'persona' && !frontmatter.keywords) {
    return { valid: false, error: 'persona frontmatter 必须包含 keywords 字段（逗号分隔的关键词）' };
  }

  // body 不能为空
  if (!body.trim()) {
    return { valid: false, error: '正文不能为空' };
  }

  // 安全检查：拒绝 HTML 标签注入（与 skillInstaller 一致）
  if (/<script|<iframe|<object|<embed/i.test(body)) {
    return { valid: false, error: '正文包含不安全的 HTML 标签' };
  }

  return { valid: true, configName };
}

// ─── 副作用函数 ────────────────────────────────────────────

/**
 * 解析配置名为文件名（自动补 .md 扩展名）
 *
 * 内部辅助函数，统一文件名构造逻辑。
 *
 * @param name 配置名（不含扩展名）
 * @returns 文件名（含 .md 扩展名）
 */
function toFileName(name: string): string {
  return name.endsWith(CONFIG_FILE_EXTENSION) ? name : name + CONFIG_FILE_EXTENSION;
}

/**
 * 构造目标文件绝对路径 + 校验路径穿越
 *
 * 内部辅助函数，统一路径拼接与安全校验。
 *
 * @param type 配置类型
 * @param name 配置名
 * @param configDir 配置根目录
 * @returns 目标文件绝对路径；若路径穿越攻击返回 null
 */
function resolveTargetPath(type: ConfigFileType, name: string, configDir: string): string | null {
  const subdir = TYPE_TO_SUBDIR[type];
  const targetDir = path.join(configDir, subdir);
  const targetPath = path.join(targetDir, toFileName(name));
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDir = path.resolve(targetDir);
  // 路径穿越防护：目标路径必须在子目录内
  if (!resolvedTarget.startsWith(resolvedDir + path.sep) && resolvedTarget !== resolvedDir) {
    return null;
  }
  return resolvedTarget;
}

/**
 * 读取设定文件内容
 *
 * @param type 配置类型
 * @param name 配置名（不含 .md 扩展名，自动补全）
 * @param configDir 配置根目录
 * @returns 文件条目（含完整内容）；文件不存在返回 null
 */
export async function readConfigFile(
  type: ConfigFileType,
  name: string,
  configDir: string,
): Promise<ConfigFileEntry | null> {
  // 文件名校验（白名单字符，防路径遍历）
  if (!isValidConfigName(name)) {
    logger.warn({ type, name }, '读取设定文件失败：文件名包含非法字符');
    return null;
  }

  const filePath = resolveTargetPath(type, name, configDir);
  if (!filePath) {
    logger.warn({ type, name }, '读取设定文件失败：路径穿越攻击');
    return null;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      logger.warn({ type, name, filePath }, '读取设定文件失败：目标不是文件');
      return null;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    // 从 frontmatter 提取 name 优先返回，否则用文件名去扩展名
    const { frontmatter } = parseFrontmatter(content);
    const configName = frontmatter.name ?? name;
    logger.debug({ type, name: configName, filePath }, '设定文件读取成功');
    return {
      name: configName,
      fileName: path.basename(filePath),
      filePath,
      content,
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  } catch (err) {
    // 文件不存在是预期场景（删除后查询），降级为 null 而非抛错
    const e = toError(err);
    if (e.message.includes('ENOENT')) {
      logger.debug({ type, name, filePath }, '设定文件不存在');
      return null;
    }
    logger.error({ type, name, err: e.message }, '读取设定文件异常');
    return null;
  }
}

/**
 * 保存设定文件（新增/更新合并）
 *
 * 流程：
 *   1. 文件名白名单校验
 *   2. 内容校验（validateConfigFile）
 *   3. 路径穿越防护
 *   4. 确保目录存在（recursive: true）
 *   5. 写入文件（同名覆盖，幂等）
 *
 * @param type 配置类型
 * @param name 配置名
 * @param content 文件内容（含 frontmatter + body）
 * @param configDir 配置根目录
 * @returns 操作结果
 */
export async function saveConfigFile(
  type: ConfigFileType,
  name: string,
  content: string,
  configDir: string,
): Promise<ConfigFileOperationResult> {
  // 文件名白名单校验
  if (!isValidConfigName(name)) {
    return { success: false, error: '配置名包含非法字符（仅允许字母、数字、连字符、下划线、中文）' };
  }

  // 内容校验
  const validation = validateConfigFile(content, toFileName(name), type);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // 路径穿越防护
  const filePath = resolveTargetPath(type, name, configDir);
  if (!filePath) {
    return { success: false, error: '路径穿越攻击' };
  }

  try {
    // 确保目录存在
    const targetDir = path.dirname(filePath);
    await fs.mkdir(targetDir, { recursive: true });

    // 写入文件（覆盖同名）
    await fs.writeFile(filePath, content, 'utf-8');

    logger.info({ type, name: validation.configName, filePath }, '设定文件保存成功');
    return { success: true, filePath };
  } catch (err) {
    const errMsg = toError(err).message;
    logger.error({ type, name, err: errMsg }, '设定文件保存失败');
    return { success: false, error: `写入文件失败：${errMsg}` };
  }
}

/**
 * 删除设定文件
 *
 * 文件不存在视为 success=false（与 ConfigManager.deleteRule 语义一致）。
 *
 * @param type 配置类型
 * @param name 配置名
 * @param configDir 配置根目录
 * @returns 操作结果
 */
export async function deleteConfigFile(
  type: ConfigFileType,
  name: string,
  configDir: string,
): Promise<ConfigFileOperationResult> {
  // 文件名白名单校验
  if (!isValidConfigName(name)) {
    return { success: false, error: '配置名包含非法字符' };
  }

  // 路径穿越防护
  const filePath = resolveTargetPath(type, name, configDir);
  if (!filePath) {
    return { success: false, error: '路径穿越攻击' };
  }

  try {
    // 检查文件是否存在（不存在返回 success=false，与 Manager.delete 语义一致）
    await fs.access(filePath);
    await fs.unlink(filePath);
    logger.info({ type, name, filePath }, '设定文件删除成功');
    return { success: true, filePath };
  } catch (err) {
    const e = toError(err);
    if (e.message.includes('ENOENT')) {
      return { success: false, error: '文件不存在' };
    }
    logger.error({ type, name, err: e.message }, '设定文件删除失败');
    return { success: false, error: `删除文件失败：${e.message}` };
  }
}

/**
 * 列出指定类型的所有设定文件
 *
 * 返回的 entry.content 为空字符串（列表场景不读取内容，仅元数据）。
 * 调用方需要内容时通过 readConfigFile 单独获取。
 *
 * @param type 配置类型
 * @param configDir 配置根目录
 * @returns 文件条目数组（按 mtime 降序，最近修改的在前）；目录不存在返回空数组
 */
export async function listConfigFiles(
  type: ConfigFileType,
  configDir: string,
): Promise<ConfigFileEntry[]> {
  const subdir = TYPE_TO_SUBDIR[type];
  const targetDir = path.join(configDir, subdir);

  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const result: ConfigFileEntry[] = [];

    for (const entry of entries) {
      // 仅处理 .md 文件，跳过子目录和其他文件（如 .swp 临时文件）
      if (!entry.isFile() || !entry.name.endsWith(CONFIG_FILE_EXTENSION)) {
        continue;
      }

      const filePath = path.join(targetDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        // 列表场景不读取内容，仅返回元数据（content 为空字符串）
        // 调用方需要内容时通过 readConfigFile 单独获取
        result.push({
          name: entry.name.replace(/\.md$/i, ''),
          fileName: entry.name,
          filePath,
          content: '',
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch (err) {
        // 单个文件 stat 失败不阻断列表（文件可能被并发删除）
        logger.warn({ type, fileName: entry.name, err: toError(err).message }, '设定文件 stat 失败，跳过');
      }
    }

    // 按 mtime 降序排序（最近修改的在前，符合"最近编辑优先"心智）
    result.sort((a, b) => b.mtime - a.mtime);

    logger.debug({ type, count: result.length }, '设定文件列表获取成功');
    return result;
  } catch (err) {
    // 目录不存在是预期场景（首次使用未创建目录），降级为空数组
    const e = toError(err);
    if (e.message.includes('ENOENT')) {
      logger.debug({ type, targetDir }, '设定文件目录不存在，返回空列表');
      return [];
    }
    logger.error({ type, err: e.message }, '设定文件列表获取失败');
    return [];
  }
}

