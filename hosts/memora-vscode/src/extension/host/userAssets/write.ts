/**
 * 用户资产（技能 / 角色包）校验与写盘（宿主写入用户的唯一执行面）。
 *
 * 设计边界（为什么没有交互）：
 *   - 本模块**不 prompt、不弹框、不问 Agent**：入参就是已确定的元数据，返回 `{ok, path}`
 *     或可读原因。交互属于入口（命令面板 / 设置页 / 未来的对话安装窄口），不属于执行面。
 *   - 这样「压缩包导入」与「对话写入」两条承接路径可以各自采集输入，最终都落到这里，
 *     校验与落盘只有一份（第二份判据必漂移，且没有测试会红）。
 *
 * 技能写盘序：名字净化 → `description` 非空且无换行 → 正文非空 → 同名用户文件拒绝 → 写 `.md`。
 * 角色包写盘序：名字净化 → 同名用户目录拒绝 → 池内同名拒绝（内核 loadExtraDir 对同名包
 * 直接跳过 ⇒ 写进去也永不装载）→ 复用内置模板填值 → `validateManifestText` → 落盘。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateManifestText } from '@zooique/memora';
import { toNoticeText } from '../noticeText.js';
import { pathExists, resolveInsideDir, sanitizeAssetName } from './path.js';

// ══════════════════════════════════════════════════════════════
// 技能
// ══════════════════════════════════════════════════════════════

/** 技能写入入参：三项都已确定（正文由调用方提供，本模块不生成空壳模板） */
export interface SkillAssetInput {
  /** 技能名（落盘文件名的来源，也是 frontmatter 的 name） */
  name: string;
  /** 一句话描述（必填；缺失的技能不会进入模型可见清单） */
  description: string;
  /** 正文（markdown，不含 frontmatter；空技能对模型无用，故必填） */
  content: string;
}

/** 技能写盘结果：成功回显实际写入路径；失败给可读原因（不落盘） */
export type WriteSkillResult = { ok: true; filePath: string } | { ok: false; reason: string };

/**
 * 写前校验（技能侧唯一判据）
 *
 * @returns null = 通过；字符串 = 拒绝原因
 */
export function validateSkillAsset(input: SkillAssetInput): string | null {
  const sanitized = sanitizeAssetName(input.name);
  if (!sanitized.ok) return sanitized.reason;
  if (!input.description.trim()) {
    return '描述（description）必填：缺失的技能不会进入模型可见清单，等于白建';
  }
  // 换行会提前闭合 frontmatter 块，把正文误读成元数据
  if (/[\r\n]/.test(input.description)) {
    return '描述不得包含换行（会破坏技能 frontmatter 结构）';
  }
  if (!input.content.trim()) {
    return '技能正文不能为空';
  }
  return null;
}

/**
 * 生成完整技能 markdown（frontmatter + 正文）
 *
 * frontmatter 值不裹引号：内核 `parseFrontmatter` 按首个冒号朴素切分且不剥引号，
 * 裹引号会让 `description` 原样带上引号进入 LLM 清单。
 */
export function buildSkillMarkdown(name: string, description: string, content: string): string {
  return `---\nname: ${name}\ndescription: ${description.trim()}\n---\n${content}`;
}

/**
 * 解析用户技能文件路径（名字净化 + 逃逸断言后的唯一路径来源）
 *
 * @param userSkillsDir 用户技能根目录
 * @param name 用户输入名字
 */
export function userSkillFilePath(
  userSkillsDir: string,
  name: string,
): { ok: true; filePath: string } | { ok: false; reason: string } {
  const sanitized = sanitizeAssetName(name);
  if (!sanitized.ok) return sanitized;
  const resolved = resolveInsideDir(userSkillsDir, `${sanitized.name}.md`);
  if (!resolved.ok) return resolved;
  return { ok: true, filePath: resolved.path };
}

/**
 * 技能的唯一写盘实现
 *
 * 同名用户文件存在时拒绝，杜绝「入口说新建、实际把用户已有技能静默覆盖」。
 *
 * @param userSkillsDir 用户技能根目录
 * @param input 已确定的技能内容（name / description / content）
 */
export async function writeUserSkillFile(
  userSkillsDir: string,
  input: SkillAssetInput,
): Promise<WriteSkillResult> {
  const invalid = validateSkillAsset(input);
  if (invalid) return { ok: false, reason: invalid };
  const target = userSkillFilePath(userSkillsDir, input.name);
  if (!target.ok) return target;
  // 同名用户文件已存在 ⇒ 拒绝（不静默覆盖）
  if (await pathExists(target.filePath)) {
    return { ok: false, reason: `同名用户技能文件已存在：${target.filePath}` };
  }
  const sanitized = sanitizeAssetName(input.name);
  if (!sanitized.ok) return sanitized;
  await mkdir(userSkillsDir, { recursive: true });
  await writeFile(
    target.filePath,
    buildSkillMarkdown(sanitized.name, input.description, input.content),
    'utf-8',
  );
  return { ok: true, filePath: target.filePath };
}

// ══════════════════════════════════════════════════════════════
// 角色包
// ══════════════════════════════════════════════════════════════

/** 角色包写入入参（displayName / description 可缺省，缺省值由模板填值规则兜底） */
export interface RolePackAssetInput {
  /** 角色包标识（目录名 + manifest.name） */
  name: string;
  /** 界面显示名（缺省与标识相同） */
  displayName?: string;
  /** 一句话描述（可选；空则不写该字段） */
  description?: string;
}

/** 角色包写盘结果：成功回显目录与写入的文件清单 */
export type WriteRolePackResult =
  { ok: true; dirPath: string; filePaths: string[] } | { ok: false; reason: string };

/** 模板中的文本文件（相对 templateDir；manifest.json 单独处理——它要被填值后再序列化） */
const TEMPLATE_TEXT_FILES = ['persona.md', 'rules.md', join('skills', 'README.md')] as const;

/** 模板占位符（唯一清单；文本文件替换与 manifest 填值分工，禁散落字面量） */
const PLACEHOLDER_NAME = '{{PACK_NAME}}';
const PLACEHOLDER_DISPLAY_NAME = '{{PACK_DISPLAY_NAME}}';
const PLACEHOLDER_DESCRIPTION = '{{PACK_DESCRIPTION}}';
const PLACEHOLDER_HANDOFF = '{{PACK_HANDOFF}}';

/**
 * 默认接手话术（调用方未给 handoffPrompt 时使用）
 *
 * 与设置页「带入对话」的兜底话术同语义，保证新包创建后即可被代入对话。
 */
function defaultHandoff(displayName: string): string {
  return `继续以「${displayName}」的视角处理任务`;
}

/**
 * 角色包的唯一写盘实现
 *
 * @param userRolePacksDir 用户角色包根目录
 * @param templateDir 内置模板目录（dist/extension/skills/role-pack-creator/templates/standard）
 * @param input 已确定的角色包元数据
 * @param isNameTaken 池内同名判定（调用方用 `rolePackManager.get` 或导入器的同名表实现）；
 *        命中即拒绝——内核 loadExtraDir 对同名包直接跳过，写进去也永不装载（创建即白建）
 */
export async function writeUserRolePackFiles(
  userRolePacksDir: string,
  templateDir: string,
  input: RolePackAssetInput,
  isNameTaken: (name: string) => boolean,
): Promise<WriteRolePackResult> {
  const sanitized = sanitizeAssetName(input.name);
  if (!sanitized.ok) return sanitized;
  const target = resolveInsideDir(userRolePacksDir, sanitized.name);
  if (!target.ok) return target;
  // 同名目录已存在（哪怕是空目录）⇒ 拒绝，不静默覆盖用户已有内容
  if (await pathExists(target.path)) {
    return { ok: false, reason: `同名用户角色包目录已存在：${target.path}` };
  }
  // 池内同名（内置必拒），与技能侧「确认后可覆盖」相反：内置角色包属产品组成，被同名用户包
  // 顶掉会让人以为功能消失；且内核 loadExtraDir 对同名包直接跳过 ⇒ 写进去也永不装载（创建即白建）
  if (isNameTaken(sanitized.name)) {
    return {
      ok: false,
      reason: `不能与内置角色包「${sanitized.name}」同名，请换个名字（同池同名只装载内置，新建的用户包不会被装载）`,
    };
  }

  let manifest: Record<string, unknown>;
  let textFiles: { relPath: string; text: string }[];
  try {
    const manifestRaw = await readFile(join(templateDir, 'manifest.json'), 'utf-8');
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    textFiles = await Promise.all(
      TEMPLATE_TEXT_FILES.map(async (relPath) => ({
        relPath,
        text: await readFile(join(templateDir, relPath), 'utf-8'),
      })),
    );
  } catch (err) {
    return { ok: false, reason: `读取内置角色包模板失败：${toNoticeText(err)}` };
  }

  const displayName = (input.displayName ?? '').trim() || sanitized.name;
  const description = (input.description ?? '').trim();
  // manifest 填值（模板占位符只存在于字符串字段，这里按字段赋值，避免 JSON 引号/换行被注入）
  manifest['name'] = sanitized.name;
  manifest['displayName'] = displayName;
  if (description) {
    manifest['description'] = description;
  } else {
    delete manifest['description'];
  }
  manifest['handoffPrompt'] = defaultHandoff(displayName);
  // formatVersion 缺省时显式写 1.0.0（schema 与运行时都已允许缺省；写入是为让文件自描述，
  // 不依赖「读者记得默认是 1.0.0」）
  if (!manifest['formatVersion']) {
    manifest['formatVersion'] = '1.0.0';
  }
  // 2 空格缩进 + 尾换行（与既有角色包写盘格式一致）
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  // 校验失败不落盘（复用内核判据，宿主不重写规则）
  const result = validateManifestText(manifestText);
  const firstError = result.issues.find((i) => i.severity === 'error');
  if (firstError) {
    return { ok: false, reason: `角色包 manifest 校验失败：${firstError.message}` };
  }

  // 文本文件统一替换占位符（顺序无关：先长后短不影响，各占位符互不重叠）
  const replaced = textFiles.map(({ relPath, text }) => ({
    relPath,
    text: text
      .split(PLACEHOLDER_NAME)
      .join(sanitized.name)
      .split(PLACEHOLDER_DISPLAY_NAME)
      .join(displayName)
      .split(PLACEHOLDER_DESCRIPTION)
      .join(description)
      .split(PLACEHOLDER_HANDOFF)
      .join(defaultHandoff(displayName)),
  }));

  // 落盘（唯一写点）：先建目录再逐文件写，失败即整包不完整（调用方按失败处理）
  const filePaths: string[] = [];
  await mkdir(join(target.path, 'skills'), { recursive: true });
  const manifestPath = join(target.path, 'manifest.json');
  await writeFile(manifestPath, manifestText, 'utf-8');
  filePaths.push(manifestPath);
  for (const { relPath, text } of replaced) {
    const filePath = join(target.path, relPath);
    await writeFile(filePath, text, 'utf-8');
    filePaths.push(filePath);
  }
  return { ok: true, dirPath: target.path, filePaths };
}
