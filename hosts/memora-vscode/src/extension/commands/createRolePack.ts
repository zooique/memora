/**
 * 命令：新建用户角色包（命令面板与设置页「新建角色包」按钮的唯一实现）。
 *
 * 模板复用内置 `role-pack-creator` 的 `templates/standard`（构建期复制到
 * `dist/extension/skills/role-pack-creator/templates/standard`），不另写模板。
 *
 * 写前判据（顺序即执行序）：
 *   1. 名字净化 + 路径逃逸断言；
 *   2. 同名用户角色包目录已存在 ⇒ 拒绝（不静默覆盖）；
 *   3. 同名角色包已在池内（内置必拒）⇒ 拒绝——内核 loadExtraDir 对同名包直接跳过，
 *      写进去也**永远不装载**（`rolePackManager.ts` 同名内置跳过判据），创建即白建；
 *   4. manifest 校验（复用内核 `validateManifestText`），`formatVersion` 缺省时显式写 1.0.0
 *      （schema 已随运行时改为可选；显式写是为让落盘文件自描述，不依赖任何人猜默认值）。
 */

import * as vscode from 'vscode';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '@zooique/memora';
import { validateManifestText } from '@zooique/memora';
import { toNoticeText } from '../host/noticeText.js';
import type { MemoraSettingsPanel } from '../../webview/panels/settingsPanel.js';
import { pathExists, resolveInsideDir, sanitizeAssetName } from './userAssetPath.js';

/** 新建角色包的草稿（displayName / description 由用户输入，name 为目录与标识） */
export interface RolePackDraft {
  name: string;
  displayName: string;
  description: string;
}

/** 写盘结果：成功回显角色包目录与写入的文件清单 */
export type WriteRolePackResult =
  { ok: true; dirPath: string; filePaths: string[] } | { ok: false; reason: string };

/** 新建角色包命令的依赖（由 extension 装配期注入） */
export interface CreateRolePackDeps {
  /** 用户角色包目录（globalStorageUri/role-packs，与装配期 loadExtraDir 同一路径） */
  userRolePacksDir: string;
  /** 内置模板目录（dist/extension/skills/role-pack-creator/templates/standard） */
  templateDir: string;
  /** 取当前工作区 Agent（失败返 null，不抛错） */
  tryGetAgent: () => Promise<Agent | null>;
  /** 设置页角色包列表刷新通道 */
  settingsProvider: MemoraSettingsPanel;
}

/** 模板中的文本文件（相对 templateDir；manifest.json 单独处理——它要被填值后再序列化） */
const TEMPLATE_TEXT_FILES = ['persona.md', 'rules.md', join('skills', 'README.md')] as const;

/** 模板占位符（唯一清单；文本文件替换与 manifest 填值分工，禁散落字面量） */
const PLACEHOLDER_NAME = '{{PACK_NAME}}';
const PLACEHOLDER_DISPLAY_NAME = '{{PACK_DISPLAY_NAME}}';
const PLACEHOLDER_DESCRIPTION = '{{PACK_DESCRIPTION}}';
const PLACEHOLDER_HANDOFF = '{{PACK_HANDOFF}}';

/**
 * 默认接手话术（用户未填写 handoffPrompt 时使用）
 *
 * 与设置页「带入对话」的兜底话术同语义，保证新包创建后即可被代入对话。
 */
function defaultHandoff(displayName: string): string {
  return `继续以「${displayName}」的视角处理任务`;
}

/**
 * 新建角色包的唯一写盘实现（两个入口最终都落到这里）
 *
 * @param userRolePacksDir 用户角色包根目录
 * @param templateDir 内置模板目录
 * @param draft 用户输入
 */
export async function writeUserRolePackFiles(
  userRolePacksDir: string,
  templateDir: string,
  draft: RolePackDraft,
): Promise<WriteRolePackResult> {
  const sanitized = sanitizeAssetName(draft.name);
  if (!sanitized.ok) return sanitized;
  const target = resolveInsideDir(userRolePacksDir, sanitized.name);
  if (!target.ok) return target;
  // 同名目录已存在（哪怕是空目录）⇒ 拒绝，不静默覆盖用户已有内容
  if (await pathExists(target.path)) {
    return { ok: false, reason: `同名用户角色包目录已存在：${target.path}` };
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

  const displayName = draft.displayName.trim() || sanitized.name;
  // manifest 填值（模板占位符只存在于字符串字段，这里按字段赋值，避免 JSON 引号/换行被注入）
  manifest['name'] = sanitized.name;
  manifest['displayName'] = displayName;
  if (draft.description.trim()) {
    manifest['description'] = draft.description.trim();
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
      .join(draft.description.trim())
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

/** 单行输入框（displayName / description 共用） */
async function promptLine(
  title: string,
  prompt: string,
  value?: string,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    value,
    ignoreFocusOut: true,
  });
}

/**
 * 新建角色包命令入口（命令面板 / 设置页消息 → 同一函数）
 *
 * @param deps 装配期注入的依赖
 */
export async function createRolePackCommand(deps: CreateRolePackDeps): Promise<void> {
  const rawName = await promptLine(
    '新建角色包 · 标识',
    '角色包标识（中文 / 字母 / 数字 / 下划线 / 连字符）；将创建 <用户角色包目录>/<标识>/',
  );
  if (rawName === undefined) return; // 用户取消

  const sanitized = sanitizeAssetName(rawName);
  if (!sanitized.ok) {
    void vscode.window.showWarningMessage(`角色包标识不合法：${sanitized.reason}`);
    return;
  }
  const target = resolveInsideDir(deps.userRolePacksDir, sanitized.name);
  if (!target.ok) {
    void vscode.window.showWarningMessage(`角色包标识不合法：${target.reason}`);
    return;
  }
  if (await pathExists(target.path)) {
    void vscode.window.showWarningMessage(
      `同名用户角色包目录已存在：${target.path}（不会覆盖，请换一个标识）`,
    );
    return;
  }

  const agent = await deps.tryGetAgent();
  const rpm = agent?.rolePackManager;
  if (!rpm) {
    void vscode.window.showWarningMessage('Memora Agent 未就绪，无法新建角色包');
    return;
  }
  // 同名必拒（与技能侧相反，理由见 createUserSkill.ts 的覆盖分支：
  // 角色包不是「样板文件」——内置角色包是**产品的一部分**，被用户同名包顶掉会让用户
  // 以为某个角色功能消失了。故宁可拒绝，也不做「用户版覆盖内置版」的隐式替换）。
  // 机制层原因：内核 loadExtraDir 对同名包直接跳过 ⇒ 用户包永远不装载（创建即白建）。
  // 同名用户包（不同目录但 manifest 同名）同样会被跳过，故一并拒绝（同一判据，不同文案）。
  const existing = rpm.get(sanitized.name);
  if (existing) {
    void vscode.window.showWarningMessage(
      `不能与内置角色包「${sanitized.name}」同名，请换个名字（同池同名只装载内置，新建的用户包不会被装载）`,
    );
    return;
  }

  const displayName = await promptLine(
    '新建角色包 · 显示名',
    '界面显示名（留空则与标识相同）',
    sanitized.name,
  );
  if (displayName === undefined) return; // 用户取消
  const description = await promptLine(
    '新建角色包 · 描述',
    '可选：一句话说明这个角色包擅长什么（会显示在角色列表副标题）',
    '',
  );
  if (description === undefined) return; // 用户取消

  let written: WriteRolePackResult;
  try {
    written = await writeUserRolePackFiles(deps.userRolePacksDir, deps.templateDir, {
      name: sanitized.name,
      displayName,
      description,
    });
  } catch (err) {
    void vscode.window.showWarningMessage(`创建角色包失败：${toNoticeText(err)}`);
    return;
  }
  if (!written.ok) {
    void vscode.window.showWarningMessage(`创建角色包失败：${written.reason}`);
    return;
  }

  // 写后重扫（摘除旧注入项 → 重扫用户目录）+ 刷新设置页角色列表
  try {
    await rpm.resyncUserPacks(deps.userRolePacksDir);
    await deps.settingsProvider.refreshRolePackList();
  } catch (err) {
    void vscode.window.showWarningMessage(
      `角色包已写入 ${written.dirPath}，但刷新列表失败：${toNoticeText(err)}`,
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `已创建角色包「${displayName.trim() || sanitized.name}」：${written.dirPath}`,
    '打开所在目录',
  );
  if (choice === '打开所在目录') {
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(written.dirPath));
  }
}
